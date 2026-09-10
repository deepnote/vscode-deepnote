import { injectable } from 'inversify';
import { NotebookDocument, Uri, env, workspace } from 'vscode';

import { logger } from '../../platform/logging';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';

const SIDECAR_FILENAME = 'deepnote.json';

/**
 * One project's entry. Older extension versions also recorded `environmentId` and `venvPath` for the
 * venv they managed per project; those are gone, and consumers (`@deepnote/runtime-core`'s
 * `resolveProjectPython`) treat them as optional, so an entry is rewritten in this shape.
 */
interface SidecarEntry {
    pythonInterpreter: string;
}

/** Other top-level keys are carried through untouched, so the file can grow without this writer knowing. */
interface SidecarFile extends Record<string, unknown> {
    mappings: Record<string, SidecarEntry>;
}

export const IDeepnoteInterpreterSidecar = Symbol('IDeepnoteInterpreterSidecar');
export interface IDeepnoteInterpreterSidecar {
    /**
     * Records `interpreter` as the one `notebook`'s project runs on. Never throws: a sidecar that
     * cannot be written is logged and the kernel carries on, since the file only serves other tools.
     * A notebook outside any workspace folder, or without a project id, is skipped.
     */
    record(notebook: NotebookDocument, interpreter: PythonEnvironment): Promise<void>;
}

/**
 * The editor settings folder the sidecar lives in: `.vscode`, or the equivalent for the editor the
 * extension is running in. `@deepnote/runtime-core` reads all of them.
 */
function getEditorSettingsFolder(): string {
    const appName = env.appName.toLowerCase();

    if (appName.includes('cursor')) {
        return '.cursor';
    }

    if (appName.includes('antigravity')) {
        return '.antigravity';
    }

    return '.vscode';
}

/**
 * Writes `<workspace folder>/.vscode/deepnote.json` (or `.cursor/`, `.antigravity/`), keyed by the
 * `.deepnote` file's `project.id`, so the Deepnote CLI and MCP server run a project on the same
 * interpreter its notebooks run on in the editor, without reading VS Code workspace state. The shape
 * is pinned on the consumer side in `test-fixtures/ide-sidecar/` of deepnote/deepnote.
 */
@injectable()
export class DeepnoteInterpreterSidecar implements IDeepnoteInterpreterSidecar {
    /** Serializes read-modify-write cycles so two notebooks recorded together both land. */
    private writeQueue: Promise<void> = Promise.resolve();

    public record(notebook: NotebookDocument, interpreter: PythonEnvironment): Promise<void> {
        const projectId = notebook.metadata?.deepnoteProjectId as string | undefined;
        const sidecarUri = this.getSidecarUri(notebook.uri);

        if (!projectId || !sidecarUri) {
            return Promise.resolve();
        }

        const pythonInterpreter = interpreter.uri.fsPath;
        const write = this.writeQueue.then(async () => {
            const sidecar = await this.readSidecar(sidecarUri);
            const existing = sidecar.mappings[projectId];

            if (existing && existing.pythonInterpreter === pythonInterpreter && Object.keys(existing).length === 1) {
                return;
            }

            sidecar.mappings[projectId] = { pythonInterpreter };
            await this.writeSidecar(sidecarUri, sidecar);
            logger.info(`Recorded ${pythonInterpreter} for project ${projectId} in ${sidecarUri.fsPath}`);
        });

        this.writeQueue = write.catch((error) => {
            logger.warn(`Failed to record the interpreter for project ${projectId} in ${sidecarUri.fsPath}`, error);
        });

        return this.writeQueue;
    }

    private getSidecarUri(notebookUri: Uri): Uri | undefined {
        const folder = workspace.getWorkspaceFolder(notebookUri) ?? workspace.workspaceFolders?.[0];

        if (!folder) {
            return undefined;
        }

        return Uri.joinPath(folder.uri, getEditorSettingsFolder(), SIDECAR_FILENAME);
    }

    /**
     * Entries for other projects, and any other top-level keys, are kept as written, so several
     * projects in one folder coexist and nothing another tool put in the file is lost.
     */
    private async readSidecar(sidecarUri: Uri): Promise<SidecarFile> {
        try {
            const raw = await workspace.fs.readFile(sidecarUri);
            const parsed = JSON.parse(Buffer.from(raw).toString('utf-8')) as Partial<SidecarFile> | null;

            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const mappings =
                    parsed.mappings && typeof parsed.mappings === 'object' && !Array.isArray(parsed.mappings)
                        ? parsed.mappings
                        : {};

                return { ...parsed, mappings };
            }
        } catch {
            // Missing or unreadable: start over rather than fail the record.
        }

        return { mappings: {} };
    }

    private async writeSidecar(sidecarUri: Uri, sidecar: SidecarFile): Promise<void> {
        await workspace.fs.createDirectory(Uri.joinPath(sidecarUri, '..'));
        await workspace.fs.writeFile(sidecarUri, Buffer.from(`${JSON.stringify(sidecar, undefined, 2)}\n`, 'utf-8'));
    }
}
