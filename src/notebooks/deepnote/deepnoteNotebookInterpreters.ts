import { inject, injectable } from 'inversify';
import { Uri } from 'vscode';

import { IExtensionContext } from '../../platform/common/types';
import { logger } from '../../platform/logging';

const STORAGE_KEY = 'deepnote.notebookInterpreters';

/**
 * Keys written by the Deepnote environments feature, removed in favour of plain interpreters. Read
 * so a workspace that had an environment selected keeps running on that environment's venv, which
 * already has the toolkit installed. Nothing writes them any more.
 */
const LEGACY_MAPPING_KEY = 'deepnote.notebookEnvironmentMappings';
const LEGACY_ENVIRONMENTS_KEY = 'deepnote.kernelEnvironments';

interface LegacyEnvironmentState {
    id: string;
    pythonInterpreterPath?: { uri?: string };
}

export const IDeepnoteNotebookInterpreters = Symbol('IDeepnoteNotebookInterpreters');
export interface IDeepnoteNotebookInterpreters {
    /**
     * The interpreter pinned to this notebook, or undefined when it should follow the workspace's
     * active interpreter.
     */
    get(notebookUri: Uri): Uri | undefined;

    /**
     * Pins an interpreter to this notebook for this workspace, across sessions. Passing `undefined`
     * removes the pin, so the notebook follows the workspace's active interpreter again.
     */
    set(notebookUri: Uri, interpreter: Uri | undefined): Promise<void>;
}

/**
 * Remembers which interpreter each notebook runs on.
 *
 * Per notebook rather than per workspace folder because a folder can hold several `.deepnote`
 * projects, and the extension gives each file its own toolkit server anyway. The Python extension's
 * own selection stays untouched: it is workspace-scoped and drives terminals and language features,
 * so switching it per notebook would be a visible side effect elsewhere in the editor.
 */
@injectable()
export class DeepnoteNotebookInterpreters implements IDeepnoteNotebookInterpreters {
    private readonly legacy: ReadonlyMap<string, string>;

    private pinned: Record<string, string>;

    constructor(@inject(IExtensionContext) private readonly context: IExtensionContext) {
        this.pinned = context.workspaceState.get<Record<string, string>>(STORAGE_KEY) ?? {};
        this.legacy = this.readLegacyMappings();
    }

    public get(notebookUri: Uri): Uri | undefined {
        const key = notebookUri.toString();
        const stored = this.pinned[key] ?? this.legacy.get(key);

        return stored ? Uri.parse(stored) : undefined;
    }

    public async set(notebookUri: Uri, interpreter: Uri | undefined): Promise<void> {
        const key = notebookUri.toString();
        const { [key]: removed, ...rest } = this.pinned;

        this.pinned = interpreter ? { ...rest, [key]: interpreter.toString() } : rest;

        await this.context.workspaceState.update(STORAGE_KEY, this.pinned);
    }

    /** Resolves the old notebook-path -> environment-id -> interpreter chain into one lookup. */
    private readLegacyMappings(): ReadonlyMap<string, string> {
        const mappings = this.context.workspaceState.get<Record<string, string>>(LEGACY_MAPPING_KEY);

        if (!mappings || Object.keys(mappings).length === 0) {
            return new Map();
        }

        const environments = this.context.globalState.get<LegacyEnvironmentState[]>(LEGACY_ENVIRONMENTS_KEY) ?? [];
        const interpreterByEnvironmentId = new Map(
            environments
                .filter((environment) => environment?.pythonInterpreterPath?.uri)
                .map((environment) => [environment.id, environment.pythonInterpreterPath!.uri!] as const)
        );

        const resolved = new Map<string, string>();

        for (const [notebookPath, environmentId] of Object.entries(mappings)) {
            const interpreter = interpreterByEnvironmentId.get(environmentId);

            if (interpreter) {
                // The old mapping keyed on fsPath; everything else here keys on the URI.
                resolved.set(Uri.file(notebookPath).toString(), interpreter);
            }
        }

        if (resolved.size > 0) {
            logger.info(`Carrying ${resolved.size} interpreter selection(s) over from Deepnote environments`);
        }

        return resolved;
    }
}
