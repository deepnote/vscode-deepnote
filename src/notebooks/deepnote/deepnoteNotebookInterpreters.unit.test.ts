import { assert } from 'chai';
import { Memento, Uri } from 'vscode';

import { IExtensionContext } from '../../platform/common/types';
import { DeepnoteNotebookInterpreters } from './deepnoteNotebookInterpreters';

const NOTEBOOK = Uri.file('/ws/project.deepnote');
const OTHER_NOTEBOOK = Uri.file('/ws/other.deepnote');
const INTERPRETER = Uri.file('/envs/first/bin/python');
const LEGACY_INTERPRETER = Uri.file('/envs/legacy/bin/python');

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

/** A stored environment as the removed environments feature serialized it. */
function legacyEnvironment(id: string, interpreter: Uri) {
    return { id, name: id, pythonInterpreterPath: { id, uri: interpreter.toString(true) } };
}

suite('DeepnoteNotebookInterpreters', () => {
    test('returns undefined for a notebook that was never pinned', () => {
        const store = new DeepnoteNotebookInterpreters(context());

        assert.isUndefined(store.get(NOTEBOOK));
    });

    test('returns the interpreter pinned to a notebook, and only to that notebook', async () => {
        const store = new DeepnoteNotebookInterpreters(context());

        await store.set(NOTEBOOK, INTERPRETER);

        assert.strictEqual(store.get(NOTEBOOK)?.toString(), INTERPRETER.toString());
        assert.isUndefined(store.get(OTHER_NOTEBOOK));
    });

    test('persists the pin so a later session reads it back', async () => {
        const shared = context();
        await new DeepnoteNotebookInterpreters(shared).set(NOTEBOOK, INTERPRETER);

        const reopened = new DeepnoteNotebookInterpreters(shared);

        assert.strictEqual(reopened.get(NOTEBOOK)?.toString(), INTERPRETER.toString());
    });

    test('resolves a notebook that only has an old Deepnote environment selection', () => {
        const store = new DeepnoteNotebookInterpreters(
            context({
                // The old mapping keyed on fsPath, not on the URI.
                workspace: { 'deepnote.notebookEnvironmentMappings': { [NOTEBOOK.fsPath]: 'env-1' } },
                global: { 'deepnote.kernelEnvironments': [legacyEnvironment('env-1', LEGACY_INTERPRETER)] }
            })
        );

        assert.strictEqual(store.get(NOTEBOOK)?.toString(), LEGACY_INTERPRETER.toString());
    });

    test('prefers a new pin over the old environment selection', async () => {
        const store = new DeepnoteNotebookInterpreters(
            context({
                workspace: { 'deepnote.notebookEnvironmentMappings': { [NOTEBOOK.fsPath]: 'env-1' } },
                global: { 'deepnote.kernelEnvironments': [legacyEnvironment('env-1', LEGACY_INTERPRETER)] }
            })
        );

        await store.set(NOTEBOOK, INTERPRETER);

        assert.strictEqual(store.get(NOTEBOOK)?.toString(), INTERPRETER.toString());
    });

    test('ignores an old selection whose environment no longer exists', () => {
        const store = new DeepnoteNotebookInterpreters(
            context({
                workspace: { 'deepnote.notebookEnvironmentMappings': { [NOTEBOOK.fsPath]: 'deleted-env' } },
                global: { 'deepnote.kernelEnvironments': [legacyEnvironment('env-1', LEGACY_INTERPRETER)] }
            })
        );

        assert.isUndefined(store.get(NOTEBOOK));
    });
});
