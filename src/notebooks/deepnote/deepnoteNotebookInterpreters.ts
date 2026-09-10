import { inject, injectable } from 'inversify';
import { Uri } from 'vscode';

import { IExtensionContext } from '../../platform/common/types';
import { getOSType, OSType } from '../../platform/common/utils/platform';
import { IInterpreterService } from '../../platform/interpreter/contracts';
import { logger } from '../../platform/logging';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';

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
    managedVenv?: boolean;
    pythonInterpreterPath?: { uri?: string };
    venvPath?: string;
}

/**
 * The interpreter the old feature actually ran kernels on. A managed environment was a venv the
 * extension created *from* `pythonInterpreterPath` and installed the toolkit into, so the venv's
 * python is the one to carry over; only an unmanaged environment ran on the interpreter as picked.
 * `managedVenv` defaults to true, matching how the old storage deserialized it.
 */
function legacyKernelInterpreter(environment: LegacyEnvironmentState): string | undefined {
    if (environment?.venvPath && environment.managedVenv !== false) {
        const executable = getOSType() === OSType.Windows ? ['Scripts', 'python.exe'] : ['bin', 'python'];

        return Uri.joinPath(Uri.parse(environment.venvPath), ...executable).toString();
    }

    return environment?.pythonInterpreterPath?.uri;
}

export const IDeepnoteNotebookInterpreters = Symbol('IDeepnoteNotebookInterpreters');
export interface IDeepnoteNotebookInterpreters {
    /**
     * The interpreter pinned to this notebook, or undefined when it should follow the workspace's
     * active interpreter.
     */
    get(notebookUri: Uri): Uri | undefined;

    /**
     * The interpreter this notebook runs on: the pin if it still resolves, otherwise the
     * workspace's active interpreter. A pin that no longer resolves (its venv was deleted, say)
     * falls back rather than failing, so the notebook stays runnable.
     */
    resolve(notebookUri: Uri): Promise<PythonEnvironment | undefined>;

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

    constructor(
        @inject(IExtensionContext) private readonly context: IExtensionContext,
        @inject(IInterpreterService) private readonly interpreterService: IInterpreterService
    ) {
        this.pinned = context.workspaceState.get<Record<string, string>>(STORAGE_KEY) ?? {};
        this.legacy = this.readLegacyMappings();
    }

    public get(notebookUri: Uri): Uri | undefined {
        const key = notebookUri.toString();
        const stored = this.pinned[key] ?? this.legacy.get(key);

        return stored ? Uri.parse(stored) : undefined;
    }

    public async resolve(notebookUri: Uri): Promise<PythonEnvironment | undefined> {
        const pinned = this.get(notebookUri);

        if (pinned) {
            const interpreter = await this.interpreterService.getInterpreterDetails(pinned);

            if (interpreter) {
                return interpreter;
            }

            logger.warn(
                `Interpreter pinned to ${notebookUri.toString()} no longer resolves (${pinned.toString()}); using the active interpreter`
            );
        }

        return this.interpreterService.getActiveInterpreter(notebookUri);
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
        const interpreterByEnvironmentId = new Map<string, string>();

        for (const environment of environments) {
            const interpreter = legacyKernelInterpreter(environment);

            if (interpreter) {
                interpreterByEnvironmentId.set(environment.id, interpreter);
            }
        }

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
