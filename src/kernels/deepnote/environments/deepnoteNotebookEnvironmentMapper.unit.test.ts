import { assert } from 'chai';
import * as sinon from 'sinon';
import { Uri, Memento } from 'vscode';

import { DeepnoteNotebookEnvironmentMapper } from './deepnoteNotebookEnvironmentMapper.node';
import { IExtensionContext } from '../../../platform/common/types';

class InMemoryMemento implements Memento {
    private storage = new Map<string, unknown>();

    get<T>(key: string, defaultValue?: T): T {
        if (this.storage.has(key)) {
            return this.storage.get(key) as T;
        }
        return defaultValue as T;
    }

    update(key: string, value: unknown): Thenable<void> {
        if (value === undefined) {
            this.storage.delete(key);
        } else {
            this.storage.set(key, value);
        }
        return Promise.resolve();
    }

    keys(): readonly string[] {
        return Array.from(this.storage.keys());
    }
}

function createExtensionContextStub(workspaceState: Memento): IExtensionContext {
    return { workspaceState } as unknown as IExtensionContext;
}

suite('DeepnoteNotebookEnvironmentMapper', () => {
    let workspaceState: InMemoryMemento;
    let mapper: DeepnoteNotebookEnvironmentMapper;

    setup(() => {
        workspaceState = new InMemoryMemento();
        mapper = new DeepnoteNotebookEnvironmentMapper(createExtensionContextStub(workspaceState));
    });

    teardown(() => {
        sinon.restore();
    });

    test('stores unique environments per notebook query', async () => {
        const uriA = Uri.parse('file:///workspace/notebook.deepnote?notebook=a');
        const uriB = Uri.parse('file:///workspace/notebook.deepnote?notebook=b');

        await mapper.setEnvironmentForNotebook(uriA, 'env-a');
        await mapper.setEnvironmentForNotebook(uriB, 'env-b');

        assert.strictEqual(mapper.getEnvironmentForNotebook(uriA), 'env-a');
        assert.strictEqual(mapper.getEnvironmentForNotebook(uriB), 'env-b');
    });

    test('migrates legacy fsPath keys on load', async () => {
        const legacyUri = Uri.parse('file:///workspace/notebook.deepnote?notebook=legacy');
        const legacyKey = legacyUri.with({ query: '', fragment: '' }).fsPath;

        await workspaceState.update('deepnote.notebookEnvironmentMappings', { [legacyKey]: 'env-legacy' });

        const freshMapper = new DeepnoteNotebookEnvironmentMapper(createExtensionContextStub(workspaceState));

        assert.strictEqual(freshMapper.getEnvironmentForNotebook(legacyUri), 'env-legacy');
    });
});
