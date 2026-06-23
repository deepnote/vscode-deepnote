import { inject, injectable } from 'inversify';
import { Disposable, RelativePattern, Uri, window, workspace } from 'vscode';
import { deserializeDeepnoteFile, serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';

import { IDisposableRegistry } from '../common/types';
import { logger } from '../logging';
import { IPlatformDeepnoteNotebookManager } from '../notebooks/deepnote/types';
import { IDeepnoteProjectMetadataPropagator, ProjectMetadataPropagationResult } from './types';

/**
 * Suffix that identifies snapshot `.deepnote` files. Snapshots are notebook-output sidecars,
 * not project source files, so they are excluded from the propagation group.
 *
 * Re-implemented locally (rather than imported from the notebooks-layer
 * `snapshots/snapshotFiles.ts`) to avoid this platform-layer module reaching across into the
 * notebooks layer for a one-line `endsWith` check.
 */
const SNAPSHOT_FILE_SUFFIX = '.snapshot.deepnote';

/**
 * Upper bound on `.deepnote` files inspected per workspace folder. Bounds the on-disk scan
 * so a pathological workspace cannot stall the propagation pass.
 */
const MAX_DEEPNOTE_FILES_PER_FOLDER = 5_000;

/**
 * Desktop-only implementation of {@link IDeepnoteProjectMetadataPropagator}.
 *
 * Walks the workspace via `workspace.findFiles`/`workspace.fs` and rewrites every sibling
 * `.deepnote` file of a project so that a project-level edit (integrations, name, …) reaches
 * closed siblings, not just the open editor. For open siblings it additionally refreshes the
 * manager cache so an open editor does not save a stale project.
 */
@injectable()
export class DeepnoteProjectMetadataPropagator implements IDeepnoteProjectMetadataPropagator {
    private readonly fileWrittenCallbacks: ((uri: Uri) => void)[] = [];

    constructor(
        @inject(IDisposableRegistry) disposables: IDisposableRegistry,
        @inject(IPlatformDeepnoteNotebookManager)
        private readonly notebookManager: IPlatformDeepnoteNotebookManager
    ) {
        disposables.push({ dispose: () => (this.fileWrittenCallbacks.length = 0) });
    }

    public onFileWritten(callback: (uri: Uri) => void): Disposable {
        this.fileWrittenCallbacks.push(callback);

        return {
            dispose: () => {
                const idx = this.fileWrittenCallbacks.indexOf(callback);

                if (idx >= 0) {
                    this.fileWrittenCallbacks.splice(idx, 1);
                }
            }
        };
    }

    public async propagateProjectMetadata(
        projectId: string,
        mutator: (file: DeepnoteFile) => void
    ): Promise<ProjectMetadataPropagationResult> {
        const updated: Uri[] = [];
        const failures: Array<{ uri: Uri; error: unknown }> = [];

        const decoder = new TextDecoder();
        const encoder = new TextEncoder();

        const candidates = await this.enumerateProjectFiles(projectId, decoder);

        for (const { uri, file, originalBytes } of candidates) {
            try {
                mutator(file);

                // No-op skip: serialize the post-mutator file BEFORE bumping modifiedAt and
                // compare to the original on-disk bytes. If the mutator changed nothing, skip
                // entirely (no write, no modifiedAt bump) so a "save" that changes nothing
                // cannot start a churn loop.
                const serialized = serializeDeepnoteFile(file);

                if (serialized === originalBytes) {
                    continue;
                }

                if (!file.metadata) {
                    file.metadata = { createdAt: new Date().toISOString() };
                }
                file.metadata.modifiedAt = new Date().toISOString();

                const content = encoder.encode(serializeDeepnoteFile(file));

                // Fire self-write callbacks BEFORE the write so the file watcher marks this a
                // self-write and skips the reload-and-resave for an open sibling.
                this.fireFileWritten(uri);

                await workspace.fs.writeFile(uri, content);

                updated.push(uri);

                this.refreshManagerCache(projectId, file);
            } catch (error) {
                logger.error(`[MetadataPropagator] Failed to update project file: ${uri.path}`, error);
                failures.push({ uri, error });
            }
        }

        if (failures.length > 0) {
            const total = updated.length + failures.length;

            await window.showWarningMessage(
                `Updated ${updated.length} of ${total} project files; ${failures.length} could not be updated.`
            );
        }

        return { updated, failures };
    }

    /**
     * Enumerates every non-snapshot `.deepnote` file across the workspace whose
     * `project.id === projectId`. Membership is "matches project.id on disk" — open documents
     * and the manager cache are never consulted here.
     */
    private async enumerateProjectFiles(
        projectId: string,
        decoder: TextDecoder
    ): Promise<Array<{ uri: Uri; file: DeepnoteFile; originalBytes: string }>> {
        const matches: Array<{ uri: Uri; file: DeepnoteFile; originalBytes: string }> = [];

        const workspaceFolders = workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            return matches;
        }

        for (const folder of workspaceFolders) {
            let files: Uri[];

            try {
                files = await workspace.findFiles(
                    new RelativePattern(folder, '**/*.deepnote'),
                    undefined,
                    MAX_DEEPNOTE_FILES_PER_FOLDER
                );
            } catch (error) {
                logger.warn(`[MetadataPropagator] Failed to enumerate .deepnote files in ${folder.uri.path}`, error);

                continue;
            }

            for (const uri of files) {
                if (uri.path.endsWith(SNAPSHOT_FILE_SUFFIX)) {
                    continue;
                }

                try {
                    const bytes = await workspace.fs.readFile(uri);
                    const originalBytes = decoder.decode(bytes);
                    const file = deserializeDeepnoteFile(originalBytes);

                    if (file.project.id === projectId) {
                        matches.push({ uri, file, originalBytes });
                    }
                } catch (error) {
                    logger.warn(`[MetadataPropagator] Failed to read/parse candidate file: ${uri.path}`, error);
                }
            }
        }

        return matches;
    }

    private fireFileWritten(uri: Uri): void {
        for (const callback of this.fileWrittenCallbacks) {
            try {
                callback(uri);
            } catch (error) {
                logger.warn('[MetadataPropagator] File written callback failed', error);
            }
        }
    }

    /**
     * Refreshes the manager cache for an updated file that is also open, so an open editor
     * does not save a stale project. This is the only place open-state is consulted, and it is
     * for cache coherence — not to decide which files to write.
     */
    private refreshManagerCache(projectId: string, file: DeepnoteFile): void {
        // Single-notebook files: refresh the one notebook entry if it is cached.
        for (const notebook of file.project.notebooks) {
            if (this.notebookManager.getOriginalProject(projectId, notebook.id)) {
                this.notebookManager.updateOriginalProject(projectId, notebook.id, file);
            }
        }
    }
}
