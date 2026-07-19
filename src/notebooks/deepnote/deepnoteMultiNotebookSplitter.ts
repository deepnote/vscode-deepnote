import { l10n, TabInputNotebook, Uri, window, workspace, type Disposable, type NotebookDocument } from 'vscode';
import { serializeDeepnoteFile } from '@deepnote/blocks';
import { isSingleNotebookDeepnoteFile, splitByNotebooks } from '@deepnote/convert';

import { ITelemetryService } from '../../platform/analytics/types';
import { ILogger } from '../../platform/logging/types';
import type { IDeepnoteNotebookEnvironmentMapper } from '../../kernels/deepnote/types';
import { DEEPNOTE_NOTEBOOK_TYPE } from '../../kernels/deepnote/types';
import { readDeepnoteProjectFile } from '../../platform/deepnote/deepnoteProjectFileReader';
import { allocateSiblingUri } from './deepnoteSiblingFileAllocator';
import { getFileStem } from './deepnoteNotebookFileFactory';

const SPLIT_ACTION = l10n.t('Split into separate files');

/** Suffix appended to a split-away original so it no longer matches `*.deepnote` yet stays on disk. */
const LEGACY_SUFFIX = '.legacy';

/** Upper bound on `.legacy` / `.legacy-N` suffix attempts when the base name is already taken. */
const MAX_LEGACY_ALLOCATION_ATTEMPTS = 10_000;

/**
 * On opening a legacy multi-notebook `.deepnote` file, prompts to split it into one single-notebook
 * sibling file per notebook and retire the original as `<name>.deepnote.legacy`. No automatic rewrite.
 * The environment mapper is undefined on the web target, where env migration is a desktop-only no-op.
 */
export class DeepnoteMultiNotebookSplitter {
    private readonly analytics: ITelemetryService;

    private readonly disposables: Disposable[] = [];

    private readonly envMapper: IDeepnoteNotebookEnvironmentMapper | undefined;

    private readonly exists: (uri: Uri) => Promise<boolean>;

    private readonly logger: ILogger;

    private readonly promptedUris = new Set<string>();

    private readonly refreshTree: () => void;

    constructor(
        envMapper: IDeepnoteNotebookEnvironmentMapper | undefined,
        refreshTree: () => void,
        logger: ILogger,
        exists: (uri: Uri) => Promise<boolean>,
        analytics: ITelemetryService
    ) {
        this.envMapper = envMapper;
        this.refreshTree = refreshTree;
        this.logger = logger;
        this.exists = exists;
        this.analytics = analytics;
    }

    public activate(): Disposable[] {
        this.disposables.push(
            workspace.onDidOpenNotebookDocument((notebook) => {
                void this.handleNotebookOpened(notebook);
            })
        );

        // One-time sweep over already-open notebooks (event-driven only, no polling).
        for (const notebook of workspace.notebookDocuments) {
            try {
                void this.handleNotebookOpened(notebook);
            } catch (error) {
                this.logger.error('Failed to inspect open Deepnote notebook for multi-notebook split', error);
            }
        }

        return this.disposables;
    }

    public dispose(): void {
        while (this.disposables.length > 0) {
            this.disposables.pop()?.dispose();
        }
    }

    private async handleNotebookOpened(notebook: NotebookDocument): Promise<void> {
        if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        const fileUri = notebook.uri.with({ query: '', fragment: '' });
        const uriKey = fileUri.toString();

        if (this.promptedUris.has(uriKey)) {
            return;
        }

        try {
            const file = await readDeepnoteProjectFile(fileUri);

            if (isSingleNotebookDeepnoteFile(file)) {
                return;
            }

            // Mark as prompted before showing so a rapid re-open can't double-prompt.
            this.promptedUris.add(uriKey);

            const selection = await window.showWarningMessage(
                l10n.t(
                    'Multiple notebooks in one .deepnote file is a legacy layout, now being replaced by one file per notebook. Split it?'
                ),
                SPLIT_ACTION
            );

            if (selection === SPLIT_ACTION) {
                const notebookCount = await this.splitFile(fileUri);
                this.analytics.trackEvent({
                    eventName: 'split_notebook',
                    properties: { completed: notebookCount > 0, notebookCount }
                });
            }
        } catch (error) {
            this.logger.error(`Failed to inspect Deepnote file for multi-notebook split: ${fileUri.toString()}`, error);
        }
    }

    private async splitFile(fileUri: Uri): Promise<number> {
        // Compensations for each applied step, unwound in reverse on any failure so the split is all-or-nothing.
        const rollbacks: Array<() => Thenable<void>> = [];
        let renamed = false;

        try {
            // Flush the open document first, then re-read from disk.
            const openDocument = workspace.notebookDocuments.find(
                (doc) => doc.uri.with({ query: '', fragment: '' }).toString() === fileUri.toString()
            );

            if (openDocument?.isDirty) {
                let saved = false;

                try {
                    saved = await openDocument.save();
                } catch (error) {
                    this.logger.error(`Failed to save Deepnote file before split: ${fileUri.toString()}`, error);
                }

                if (!saved) {
                    await window.showErrorMessage(
                        l10n.t('Could not save the file before splitting. The file was left unchanged.')
                    );

                    return 0;
                }
            }

            const deepnoteFile = await readDeepnoteProjectFile(fileUri);
            const parentDir = Uri.joinPath(fileUri, '..');
            const envMapper = this.envMapper;
            const originalEnv = envMapper?.getEnvironmentForNotebook(fileUri);

            // Write all children before retiring the original (see step below).
            const entries = splitByNotebooks(deepnoteFile, getFileStem(fileUri));
            const reserved = new Set<string>();
            const newUris: Uri[] = [];
            const encoder = new TextEncoder();

            for (const entry of entries) {
                const targetUri = await allocateSiblingUri(parentDir, entry.outputFilename, this.exists, reserved);

                // Register cleanup BEFORE the write: a create-then-reject leaves an orphan the rollback must delete.
                rollbacks.push(async () => {
                    if (await this.exists(targetUri)) {
                        await workspace.fs.delete(targetUri, { useTrash: false });
                    }
                });
                await workspace.fs.writeFile(targetUri, encoder.encode(serializeDeepnoteFile(entry.file)));
                newUris.push(targetUri);
            }

            // Migrate the environment selection onto each new file (desktop-only).
            if (envMapper && originalEnv) {
                for (const newUri of newUris) {
                    // Register the revert BEFORE the set: the mapper mutates memory before the persist that can reject.
                    rollbacks.push(() => envMapper.removeEnvironmentForNotebook(newUri));
                    await envMapper.setEnvironmentForNotebook(newUri, originalEnv);
                }
            }

            // Abort before retiring the original if its tab won't close, else a later save recreates it.
            if (!(await this.closeNotebookTab(fileUri))) {
                throw new Error(l10n.t('The file is still open in an editor and could not be closed.'));
            }

            const legacyUri = await this.allocateLegacyUri(fileUri);
            await workspace.fs.rename(fileUri, legacyUri, { overwrite: false });
            renamed = true;
            rollbacks.push(() => workspace.fs.rename(legacyUri, fileUri, { overwrite: false }));

            if (envMapper) {
                // Restore the original mapping on rollback before removing it here.
                if (originalEnv) {
                    rollbacks.push(() => envMapper.setEnvironmentForNotebook(fileUri, originalEnv));
                }

                await envMapper.removeEnvironmentForNotebook(fileUri);
            }

            this.refreshTree();

            await window.showInformationMessage(l10n.t('Split into {0} files.', newUris.length));

            return newUris.length;
        } catch (error) {
            // Unwind every applied step so the original is left as it was found (or an honest message if it can't be).
            this.logger.error(`Failed to split Deepnote file: ${fileUri.toString()}`, error);

            const restored = await this.runRollback(rollbacks);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            await window.showErrorMessage(this.describeSplitFailure({ errorMessage, renamed, restored }));

            return 0;
        }
    }

    /** Unwinds applied steps in reverse; resolves to `true` only if every compensation succeeded. */
    private async runRollback(rollbacks: Array<() => Thenable<void>>): Promise<boolean> {
        let restored = true;

        for (let index = rollbacks.length - 1; index >= 0; index--) {
            try {
                await rollbacks[index]();
            } catch (rollbackError) {
                restored = false;
                this.logger.error('Failed to roll back a Deepnote split step', rollbackError);
            }
        }

        return restored;
    }

    /** Derives the failure message from state so "unchanged" is never claimed for a file that was moved. */
    private describeSplitFailure({
        errorMessage,
        renamed,
        restored
    }: {
        errorMessage: string;
        renamed: boolean;
        restored: boolean;
    }): string {
        if (!restored) {
            return l10n.t(
                'Failed to split file: {0}. Automatic cleanup did not fully complete; check the folder for stray ".deepnote" or ".legacy" files.',
                errorMessage
            );
        }

        if (renamed) {
            return l10n.t('Failed to split file: {0}. The original file was restored.', errorMessage);
        }

        return l10n.t('Failed to split file: {0}. The original file was left unchanged.', errorMessage);
    }

    /** Resolves a collision-free `<original>.legacy` (then `.legacy-2`, …) URI next to the original. */
    private async allocateLegacyUri(fileUri: Uri): Promise<Uri> {
        for (let attempt = 1; attempt <= MAX_LEGACY_ALLOCATION_ATTEMPTS; attempt++) {
            const suffix = attempt === 1 ? LEGACY_SUFFIX : `${LEGACY_SUFFIX}-${attempt}`;
            const candidateUri = fileUri.with({ path: `${fileUri.path}${suffix}` });

            if (!(await this.exists(candidateUri))) {
                return candidateUri;
            }
        }

        throw new Error(`Unable to allocate a free "${LEGACY_SUFFIX}" filename for "${fileUri.toString()}".`);
    }

    /** Closes every editor tab still showing `fileUri`; resolves `false` if a dirty tab's close was cancelled. */
    private async closeNotebookTab(fileUri: Uri): Promise<boolean> {
        const tabs = window.tabGroups.all.flatMap((group) =>
            group.tabs.filter(
                (tab) =>
                    tab.input instanceof TabInputNotebook &&
                    tab.input.uri.with({ query: '', fragment: '' }).toString() === fileUri.toString()
            )
        );

        if (tabs.length === 0) {
            return true;
        }

        return window.tabGroups.close(tabs);
    }
}
