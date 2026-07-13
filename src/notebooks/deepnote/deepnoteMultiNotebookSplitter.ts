import { l10n, TabInputNotebook, Uri, window, workspace, type Disposable, type NotebookDocument } from 'vscode';
import { serializeDeepnoteFile } from '@deepnote/blocks';
import { isSingleNotebookDeepnoteFile, splitByNotebooks } from '@deepnote/convert';

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
        exists: (uri: Uri) => Promise<boolean>
    ) {
        this.envMapper = envMapper;
        this.refreshTree = refreshTree;
        this.logger = logger;
        this.exists = exists;
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
                l10n.t('This .deepnote file contains multiple notebooks. Split it into one file per notebook?'),
                SPLIT_ACTION
            );

            if (selection === SPLIT_ACTION) {
                await this.splitFile(fileUri);
            }
        } catch (error) {
            this.logger.error(`Failed to inspect Deepnote file for multi-notebook split: ${fileUri.toString()}`, error);
        }
    }

    private async splitFile(fileUri: Uri): Promise<void> {
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

                    return;
                }
            }

            const deepnoteFile = await readDeepnoteProjectFile(fileUri);
            const parentDir = Uri.joinPath(fileUri, '..');

            // Write all children before retiring the original (see step below).
            const entries = splitByNotebooks(deepnoteFile, getFileStem(fileUri));
            const reserved = new Set<string>();
            const newUris: Uri[] = [];
            const encoder = new TextEncoder();

            try {
                for (const entry of entries) {
                    const targetUri = await allocateSiblingUri(parentDir, entry.outputFilename, this.exists, reserved);

                    await workspace.fs.writeFile(targetUri, encoder.encode(serializeDeepnoteFile(entry.file)));
                    newUris.push(targetUri);
                }
            } catch (writeError) {
                // Delete partial siblings: orphans left on disk would bump a retry's name allocation to a duplicate.
                for (const uri of newUris) {
                    await workspace.fs
                        .delete(uri, { useTrash: false })
                        .then(undefined, (cleanupError) =>
                            this.logger.error(`Failed to clean up partial split file: ${uri.toString()}`, cleanupError)
                        );
                }

                throw writeError;
            }

            // Migrate the environment selection onto each new file (desktop-only).
            if (this.envMapper) {
                const env = this.envMapper.getEnvironmentForNotebook(fileUri);

                if (env) {
                    for (const newUri of newUris) {
                        await this.envMapper.setEnvironmentForNotebook(newUri, env);
                    }
                }
            }

            // Only now that all children are durably written: close the tab and retire the original.
            await this.closeNotebookTab(fileUri);
            const legacyUri = await this.allocateLegacyUri(fileUri);
            await workspace.fs.rename(fileUri, legacyUri, { overwrite: false });

            if (this.envMapper) {
                await this.envMapper.removeEnvironmentForNotebook(fileUri);
            }

            this.refreshTree();

            await window.showInformationMessage(l10n.t('Split into {0} files.', newUris.length));
        } catch (error) {
            // Any write failure leaves the original intact; a re-run re-derives the rest via the allocator.
            this.logger.error(`Failed to split Deepnote file: ${fileUri.toString()}`, error);

            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            await window.showErrorMessage(
                l10n.t('Failed to split file: {0}. The original file was left unchanged.', errorMessage)
            );
        }
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

    private async closeNotebookTab(fileUri: Uri): Promise<void> {
        for (const group of window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (
                    tab.input instanceof TabInputNotebook &&
                    tab.input.uri.with({ query: '', fragment: '' }).toString() === fileUri.toString()
                ) {
                    await window.tabGroups.close(tab);

                    return;
                }
            }
        }
    }
}
