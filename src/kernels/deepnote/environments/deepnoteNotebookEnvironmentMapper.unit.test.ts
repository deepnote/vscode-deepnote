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

    test('stores environments scoped to the project, not individual notebook instances', async () => {
        const uriA = Uri.parse('file:///workspace/notebook.deepnote?notebook=a');
        const uriB = Uri.parse('file:///workspace/notebook.deepnote?notebook=b');
        const otherUri = Uri.parse('file:///workspace/other.deepnote');

        await mapper.setEnvironmentForNotebook(uriA, 'project-123', 'env-a');
        await mapper.setEnvironmentForNotebook(otherUri, 'project-456', 'env-b');

        assert.strictEqual(mapper.getEnvironmentForNotebook(uriB, 'project-123'), 'env-a');
        assert.strictEqual(mapper.getEnvironmentForNotebook(otherUri, 'project-456'), 'env-b');
        assert.isUndefined(mapper.getEnvironmentForNotebook(uriB, 'project-missing'));
    });
});
