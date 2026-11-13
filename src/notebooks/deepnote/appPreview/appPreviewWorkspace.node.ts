import {
    deserializeDeepnoteFile,
    isInputBlock,
    type DeepnoteBlock,
    type DeepnoteFile,
    type InputBlock
} from '@deepnote/blocks';
import { FileType, Uri, workspace } from 'vscode';

import { readDeepnoteProjectFile } from '../../../platform/deepnote/deepnoteProjectFileReader';
import type { DeepnoteNotebook } from '../../../platform/deepnote/deepnoteTypes';
import { logger } from '../../../platform/logging';
import { dirname, isEqual } from '../../../platform/vscode-path/resources';
import { isSnapshotFile } from '../snapshots/snapshotFiles';
import type { AppPreviewProject } from './appPreviewSession.node';

export interface WorkspaceNotebook {
    file: DeepnoteFile;
    fileUri: Uri;
    notebook: DeepnoteNotebook;
}

/** An input block as Deepnote's app viewer API lists it in a notebook's `inputs`. */
export interface NotebookInput {
    blockId: string;
    label?: string;
    max?: number;
    min?: number;
    multiple?: boolean;
    name: string;
    options?: string[];
    step?: number;
    type: InputBlock['type'];
    value: InputBlock['metadata']['deepnote_variable_value'];
}

// Code-unit order, as Deepnote orders its fractional sorting keys: `localeCompare` would put `a0` before `Z`.
function compareCodeUnits(left: string, right: string): number {
    if (left === right) {
        return 0;
    }

    return left < right ? -1 : 1;
}

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

function toNotebookInput(block: InputBlock): NotebookInput {
    const label =
        block.metadata.deepnote_input_label ||
        (block.type === 'input-checkbox' ? block.metadata.deepnote_input_checkbox_label : undefined);
    const input: NotebookInput = {
        blockId: block.id,
        name: block.metadata.deepnote_variable_name,
        type: block.type,
        value: block.metadata.deepnote_variable_value,
        ...(label ? { label } : {})
    };

    if (block.type === 'input-slider') {
        return {
            ...input,
            min: block.metadata.deepnote_slider_min_value,
            max: block.metadata.deepnote_slider_max_value,
            step: block.metadata.deepnote_slider_step
        };
    }
    if (block.type === 'input-select') {
        return {
            ...input,
            options: block.metadata.deepnote_variable_options,
            multiple: block.metadata.deepnote_allow_multiple_values === true
        };
    }

    return input;
}

/** The notebook's blocks in the order Deepnote shows them, by `sortingKey`. */
export function blocksInNotebookOrder(notebook: DeepnoteNotebook): DeepnoteBlock[] {
    return [...notebook.blocks].sort((a, b) => compareCodeUnits(a.sortingKey, b.sortingKey));
}

/**
 * Finds the notebook with `notebookId` in the workspace's `.deepnote` files, read from disk on every call. Files
 * directly in `projectFolder` are searched first and the rest in URI order, so an ID that several files share, as in
 * a copied project, resolves to the app's own project and to the same file on every call. Snapshots are skipped, and
 * files that fail to parse are logged and skipped.
 */
export async function findNotebookById(
    notebookId: string,
    projectFolder?: Uri
): Promise<WorkspaceNotebook | undefined> {
    const outsideProject = (uri: Uri) => (projectFolder !== undefined && isEqual(dirname(uri), projectFolder) ? 0 : 1);
    const candidates = (await workspace.findFiles('**/*.deepnote'))
        .filter((uri) => !isSnapshotFile(uri))
        .sort((a, b) => outsideProject(a) - outsideProject(b) || compareCodeUnits(a.toString(), b.toString()));

    for (const fileUri of candidates) {
        let file: DeepnoteFile;
        try {
            const text = new TextDecoder().decode(await workspace.fs.readFile(fileUri));
            // Notebook IDs need no YAML escaping, so a file that holds the notebook contains its ID as is; skipping the
            // rest saves their YAML and schema parse on every request.
            if (!text.includes(notebookId)) {
                continue;
            }
            file = deserializeDeepnoteFile(text);
        } catch (error) {
            logger.warn(`Could not read ${fileUri.fsPath} to find the notebook ${notebookId}`, error);
            continue;
        }

        const notebook = file.project.notebooks.find((candidate) => candidate.id === notebookId);
        if (notebook) {
            return { file, fileUri, notebook };
        }
    }

    return undefined;
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

/**
 * The notebook's input blocks that have a variable name, in notebook order, as Deepnote's app viewer API lists them.
 * Returns `undefined` when there are none, as Deepnote then leaves `inputs` out. The `.deepnote` parser has already
 * filled in the defaults of missing fields, such as a slider's 0, 100 and 1.
 */
export function toNotebookInputs(notebook: DeepnoteNotebook): NotebookInput[] | undefined {
    const inputs = blocksInNotebookOrder(notebook)
        .filter(isInputBlock)
        .filter((block) => block.metadata.deepnote_variable_name !== '')
        .map(toNotebookInput);

    return inputs.length > 0 ? inputs : undefined;
}
