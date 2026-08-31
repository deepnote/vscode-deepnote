import { assert } from 'chai';
import { Memento, Uri } from 'vscode';

import { IExtensionContext } from '../../platform/common/types';
import * as platformUtils from '../../platform/common/utils/platform';
import { IInterpreterService } from '../../platform/interpreter/contracts';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { DeepnoteNotebookInterpreters } from './deepnoteNotebookInterpreters';

const NOTEBOOK = Uri.file('/ws/project.deepnote');
const OTHER_NOTEBOOK = Uri.file('/ws/other.deepnote');
const INTERPRETER = Uri.file('/envs/first/bin/python');
const LEGACY_INTERPRETER = Uri.file('/envs/legacy/bin/python');
const LEGACY_VENV = Uri.file('/envs/legacy-venv');
const ACTIVE_INTERPRETER: PythonEnvironment = {
    id: '/envs/active/bin/python',
    uri: Uri.file('/envs/active/bin/python')
};

/** Minimal in-memory Memento; `update` has to persist so a second store instance reads it back. */
function memento(initial: Record<string, unknown> = {}): Memento {
    const state = new Map<string, unknown>(Object.entries(initial));

    return {
        keys: () => [...state.keys()],
        get: <T>(key: string, defaultValue?: T) => (state.has(key) ? (state.get(key) as T) : defaultValue!),
        update: async (key: string, value: unknown) => {
            state.set(key, value);
        }
    } as Memento;
}

function context(options: { workspace?: Record<string, unknown>; global?: Record<string, unknown> } = {}) {
    return {
        workspaceState: memento(options.workspace),
        globalState: memento(options.global)
    } as unknown as IExtensionContext;
}

/** Resolves any interpreter whose path is listed in `known`, and reports ACTIVE_INTERPRETER otherwise. */
function interpreterService(known: Uri[] = []): IInterpreterService {
    return {
        getInterpreterDetails: async (path: Uri | { path: string } | string) => {
            const uri = path as Uri;
            const match = known.find((candidate) => candidate.toString() === uri.toString());

            return match ? { id: match.fsPath, uri: match } : undefined;
        },
        getActiveInterpreter: async () => ACTIVE_INTERPRETER
    } as unknown as IInterpreterService;
}

function store(options: Parameters<typeof context>[0] = {}, known: Uri[] = []) {
    return new DeepnoteNotebookInterpreters(context(options), interpreterService(known));
}

/** A stored environment as the removed environments feature serialized it. */
function legacyEnvironment(id: string, interpreter: Uri, extra: Record<string, unknown> = {}) {
    return { id, name: id, pythonInterpreterPath: { id, uri: interpreter.toString(true) }, ...extra };
}

suite('DeepnoteNotebookInterpreters', () => {
    test('returns undefined for a notebook that was never pinned', () => {
        const pins = store();

        assert.isUndefined(pins.get(NOTEBOOK));
    });

    test('returns the interpreter pinned to a notebook, and only to that notebook', async () => {
        const pins = store();

        await pins.set(NOTEBOOK, INTERPRETER);

        assert.strictEqual(pins.get(NOTEBOOK)?.toString(), INTERPRETER.toString());
        assert.isUndefined(pins.get(OTHER_NOTEBOOK));
    });

    test('persists the pin so a later session reads it back', async () => {
        const shared = context();
        await new DeepnoteNotebookInterpreters(shared, interpreterService()).set(NOTEBOOK, INTERPRETER);

        const reopened = new DeepnoteNotebookInterpreters(shared, interpreterService());

        assert.strictEqual(reopened.get(NOTEBOOK)?.toString(), INTERPRETER.toString());
    });

    test('removes the pin when set to undefined, leaving the notebook on the workspace interpreter', async () => {
        const pins = store();
        await pins.set(NOTEBOOK, INTERPRETER);

        await pins.set(NOTEBOOK, undefined);

        assert.isUndefined(pins.get(NOTEBOOK));
    });

    test("removing one notebook's pin leaves the others alone", async () => {
        const pins = store();
        await pins.set(NOTEBOOK, INTERPRETER);
        await pins.set(OTHER_NOTEBOOK, LEGACY_INTERPRETER);

        await pins.set(NOTEBOOK, undefined);

        assert.isUndefined(pins.get(NOTEBOOK));
        assert.strictEqual(pins.get(OTHER_NOTEBOOK)?.toString(), LEGACY_INTERPRETER.toString());
    });

    test('a removed pin stays removed in a later session', async () => {
        const shared = context();
        const pins = new DeepnoteNotebookInterpreters(shared, interpreterService());
        await pins.set(NOTEBOOK, INTERPRETER);
        await pins.set(NOTEBOOK, undefined);

        assert.isUndefined(new DeepnoteNotebookInterpreters(shared, interpreterService()).get(NOTEBOOK));
    });

    test('resolves a notebook that only has an old Deepnote environment selection', () => {
        const pins = store({
            // The old mapping keyed on fsPath, not on the URI.
            workspace: { 'deepnote.notebookEnvironmentMappings': { [NOTEBOOK.fsPath]: 'env-1' } },
            global: { 'deepnote.kernelEnvironments': [legacyEnvironment('env-1', LEGACY_INTERPRETER)] }
        });

        assert.strictEqual(pins.get(NOTEBOOK)?.toString(), LEGACY_INTERPRETER.toString());
    });

    test('prefers a new pin over the old environment selection', async () => {
        const pins = store({
            workspace: { 'deepnote.notebookEnvironmentMappings': { [NOTEBOOK.fsPath]: 'env-1' } },
            global: { 'deepnote.kernelEnvironments': [legacyEnvironment('env-1', LEGACY_INTERPRETER)] }
        });

        await pins.set(NOTEBOOK, INTERPRETER);

        assert.strictEqual(pins.get(NOTEBOOK)?.toString(), INTERPRETER.toString());
    });

    test('ignores an old selection whose environment no longer exists', () => {
        const pins = store({
            workspace: { 'deepnote.notebookEnvironmentMappings': { [NOTEBOOK.fsPath]: 'deleted-env' } },
            global: { 'deepnote.kernelEnvironments': [legacyEnvironment('env-1', LEGACY_INTERPRETER)] }
        });

        assert.isUndefined(pins.get(NOTEBOOK));
    });

    suite('legacy managed venvs', () => {
        function withEnvironment(environment: Record<string, unknown>) {
            return store({
                workspace: { 'deepnote.notebookEnvironmentMappings': { [NOTEBOOK.fsPath]: 'env-1' } },
                global: { 'deepnote.kernelEnvironments': [environment] }
            });
        }

        test("carries over the managed venv's python, not the base interpreter it was created from", () => {
            const pins = withEnvironment(
                legacyEnvironment('env-1', LEGACY_INTERPRETER, { venvPath: LEGACY_VENV.toString(true) })
            );

            assert.strictEqual(pins.get(NOTEBOOK)?.toString(), Uri.file('/envs/legacy-venv/bin/python').toString());
        });

        test('treats a missing managedVenv flag as managed, matching how the old storage read it', () => {
            const managed = withEnvironment(
                legacyEnvironment('env-1', LEGACY_INTERPRETER, {
                    managedVenv: true,
                    venvPath: LEGACY_VENV.toString(true)
                })
            );
            const unflagged = withEnvironment(
                legacyEnvironment('env-1', LEGACY_INTERPRETER, { venvPath: LEGACY_VENV.toString(true) })
            );

            assert.strictEqual(managed.get(NOTEBOOK)?.toString(), unflagged.get(NOTEBOOK)?.toString());
        });

        test('keeps the interpreter the user picked for an unmanaged environment', () => {
            const pins = withEnvironment(
                legacyEnvironment('env-1', LEGACY_INTERPRETER, {
                    managedVenv: false,
                    venvPath: LEGACY_VENV.toString(true)
                })
            );

            assert.strictEqual(pins.get(NOTEBOOK)?.toString(), LEGACY_INTERPRETER.toString());
        });

        test("uses the venv's Scripts directory on Windows", () => {
            const original = platformUtils.platformUtils.getOSType;
            platformUtils.platformUtils.getOSType = () => platformUtils.OSType.Windows;

            try {
                const pins = withEnvironment(
                    legacyEnvironment('env-1', LEGACY_INTERPRETER, { venvPath: LEGACY_VENV.toString(true) })
                );

                assert.strictEqual(
                    pins.get(NOTEBOOK)?.toString(),
                    Uri.file('/envs/legacy-venv/Scripts/python.exe').toString()
                );
            } finally {
                platformUtils.platformUtils.getOSType = original;
            }
        });
    });

    suite('resolve', () => {
        test('resolves the pinned interpreter when it still exists', async () => {
            const pins = store({}, [INTERPRETER]);
            await pins.set(NOTEBOOK, INTERPRETER);

            assert.strictEqual((await pins.resolve(NOTEBOOK))?.uri.toString(), INTERPRETER.toString());
        });

        test('falls back to the active interpreter when the pin no longer resolves', async () => {
            const pins = store({}, []);
            await pins.set(NOTEBOOK, INTERPRETER);

            assert.strictEqual((await pins.resolve(NOTEBOOK))?.uri.toString(), ACTIVE_INTERPRETER.uri.toString());
        });

        test('uses the active interpreter when nothing is pinned', async () => {
            assert.strictEqual((await store().resolve(NOTEBOOK))?.uri.toString(), ACTIVE_INTERPRETER.uri.toString());
        });
    });
});
