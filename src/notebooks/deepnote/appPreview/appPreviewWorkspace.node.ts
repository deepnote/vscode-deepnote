import { FileType, Uri, workspace } from 'vscode';

import { readDeepnoteProjectFile } from '../../../platform/deepnote/deepnoteProjectFileReader';
import { logger } from '../../../platform/logging';
import { dirname, isEqual } from '../../../platform/vscode-path/resources';
import { isSnapshotFile } from '../snapshots/snapshotFiles';
import type { AppPreviewProject } from './appPreviewSession.node';

async function projectIdsIn(folder: Uri): Promise<Set<string>> {
    const ids = new Set<string>();
    let entries: [string, FileType][];
    try {
        entries = await workspace.fs.readDirectory(folder);
    } catch (error) {
        logger.warn(`Could not list ${folder.fsPath} to find the app's Deepnote project`, error);

        return ids;
    }

    for (const [name, type] of entries) {
        const fileUri = Uri.joinPath(folder, name);
        if ((type & FileType.File) === 0 || !name.endsWith('.deepnote') || isSnapshotFile(fileUri)) {
            continue;
        }

        try {
            ids.add((await readDeepnoteProjectFile(fileUri)).project.id);
        } catch (error) {
            logger.warn(`Could not read ${fileUri.fsPath} to find the app's Deepnote project`, error);
        }
    }

    return ids;
}

/**
 * Finds the Deepnote project an app folder belongs to: the nearest folder, from `appFolder` up to the root of its
 * workspace folder, that directly holds `.deepnote` files. Returns `undefined` when there is none, or when that
 * folder's files belong to more than one project. Snapshots and files that fail to parse are ignored.
 */
export async function resolvePreviewProject(appFolder: Uri): Promise<AppPreviewProject | undefined> {
    const root = workspace.getWorkspaceFolder(appFolder)?.uri ?? appFolder;

    for (let folder = appFolder; ; folder = dirname(folder)) {
        const ids = await projectIdsIn(folder);
        if (ids.size > 0) {
            return ids.size === 1 ? { id: [...ids][0], folder } : undefined;
        }
        if (isEqual(folder, root) || isEqual(dirname(folder), folder)) {
            return undefined;
        }
    }
}
