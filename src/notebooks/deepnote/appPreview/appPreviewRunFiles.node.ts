import type { DeepnoteFile } from '@deepnote/blocks';
import { encodeNotebookIdForFilename } from '@deepnote/convert';
import { Uri, workspace } from 'vscode';

import { isFileNotFoundError } from '../../../platform/common/platform/errors';
import { readDeepnoteProjectFile } from '../../../platform/deepnote/deepnoteProjectFileReader';
import { logger } from '../../../platform/logging';
import { encodeSnapshotFile, ensureSnapshotsDirectory, SNAPSHOT_FILE_SUFFIX } from '../snapshots/snapshotFiles';

const APP_PREVIEW_FOLDER = 'appPreview';
const LATEST_FOLDER = 'latest';
const RUNS_FOLDER = 'runs';

/**
 * The app preview's run files, `<storage>/appPreview/runs/<runId>.snapshot.deepnote`, and a copy of each notebook's
 * latest successful run, `<storage>/appPreview/latest/<notebookId>.snapshot.deepnote`, the ID encoded for a file
 * name. Create one per window: constructing it starts clearing the runs folder in the background, and every write
 * waits for that clear. The latest copies are never cleared, so they outlive the window.
 */
export class AppPreviewRunFiles {
    private readonly clearing: Promise<void>;
    private readonly latestCreatedAt = new Map<string, string>();
    private readonly latestDir: Uri;
    private latestUpdates: Promise<void> = Promise.resolve();
    private readonly runsDir: Uri;

    constructor(storageUri: Uri) {
        this.latestDir = Uri.joinPath(storageUri, APP_PREVIEW_FOLDER, LATEST_FOLDER);
        this.runsDir = Uri.joinPath(storageUri, APP_PREVIEW_FOLDER, RUNS_FOLDER);
        this.clearing = this.clear();
    }

    /** Reads the file of `runId`; rejects when it is missing or does not parse. */
    public read(runId: string): Promise<DeepnoteFile> {
        return readDeepnoteProjectFile(this.fileOf(runId));
    }

    /** Reads the latest copy of `notebookId`; resolves `undefined` when it has none, and rejects on any other failure. */
    public async readLatest(notebookId: string): Promise<DeepnoteFile | undefined> {
        try {
            return await readDeepnoteProjectFile(this.latestFileOf(notebookId));
        } catch (error) {
            if (error instanceof Error && isFileNotFoundError(error)) {
                return undefined;
            }
            throw error;
        }
    }

    /**
     * Copies the file of `runId` to the latest copy of `notebookId`, unless a run of the notebook created after
     * `createdAt` was copied already, so overlapping runs leave the one created last. Copies are made one at a time;
     * resolves once this one settles, never rejects.
     */
    public updateLatest(notebookId: string, runId: string, createdAt: string): Promise<void> {
        this.latestUpdates = this.latestUpdates.then(() => this.copyToLatest(notebookId, runId, createdAt));

        return this.latestUpdates;
    }

    /** Writes `file` as the file of `runId` once the clear settles; resolves whether it was written, never rejects. */
    public async write(runId: string, file: DeepnoteFile): Promise<boolean> {
        await this.clearing;

        if (!(await ensureSnapshotsDirectory(this.runsDir))) {
            return false;
        }

        try {
            await workspace.fs.writeFile(this.fileOf(runId), encodeSnapshotFile(file));

            return true;
        } catch (error) {
            logger.error(`AppPreviewRunFiles: Could not save the results of run ${runId}`, error);

            return false;
        }
    }

    private async clear(): Promise<void> {
        try {
            await workspace.fs.delete(this.runsDir, { recursive: true, useTrash: false });
        } catch (error) {
            if (!(error instanceof Error && isFileNotFoundError(error))) {
                logger.warn('AppPreviewRunFiles: Could not clear the runs of earlier windows', error);
            }
        }
    }

    private async copyToLatest(notebookId: string, runId: string, createdAt: string): Promise<void> {
        const copiedCreatedAt = this.latestCreatedAt.get(notebookId);
        // toISOString() timestamps are fixed-width UTC, so they compare chronologically as strings.
        if (copiedCreatedAt !== undefined && createdAt < copiedCreatedAt) {
            return;
        }
        if (!(await ensureSnapshotsDirectory(this.latestDir))) {
            return;
        }

        try {
            await workspace.fs.copy(this.fileOf(runId), this.latestFileOf(notebookId), { overwrite: true });
            this.latestCreatedAt.set(notebookId, createdAt);
        } catch (error) {
            logger.error(`AppPreviewRunFiles: Could not save run ${runId} as its notebook's latest results`, error);
        }
    }

    private fileOf(runId: string): Uri {
        return Uri.joinPath(this.runsDir, `${runId}${SNAPSHOT_FILE_SUFFIX}`);
    }

    private latestFileOf(notebookId: string): Uri {
        return Uri.joinPath(this.latestDir, `${encodeNotebookIdForFilename(notebookId)}${SNAPSHOT_FILE_SUFFIX}`);
    }
}
