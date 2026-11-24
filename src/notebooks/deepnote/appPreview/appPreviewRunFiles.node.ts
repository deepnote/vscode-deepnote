import type { DeepnoteFile } from '@deepnote/blocks';
import { Uri, workspace } from 'vscode';

import { isFileNotFoundError } from '../../../platform/common/platform/errors';
import { readDeepnoteProjectFile } from '../../../platform/deepnote/deepnoteProjectFileReader';
import { logger } from '../../../platform/logging';
import { encodeSnapshotFile, ensureSnapshotsDirectory, SNAPSHOT_FILE_SUFFIX } from '../snapshots/snapshotFiles';

const APP_PREVIEW_FOLDER = 'appPreview';
const RUNS_FOLDER = 'runs';

/**
 * The app preview's run files, `<storage>/appPreview/runs/<runId>.snapshot.deepnote`. Create one per window:
 * constructing it starts clearing the runs folder in the background, and every write waits for that clear.
 */
export class AppPreviewRunFiles {
    private readonly clearing: Promise<void>;
    private readonly runsDir: Uri;

    constructor(storageUri: Uri) {
        this.runsDir = Uri.joinPath(storageUri, APP_PREVIEW_FOLDER, RUNS_FOLDER);
        this.clearing = this.clear();
    }

    /** Reads the file of `runId`; rejects when it is missing or does not parse. */
    public read(runId: string): Promise<DeepnoteFile> {
        return readDeepnoteProjectFile(this.fileOf(runId));
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

    private fileOf(runId: string): Uri {
        return Uri.joinPath(this.runsDir, `${runId}${SNAPSHOT_FILE_SUFFIX}`);
    }
}
