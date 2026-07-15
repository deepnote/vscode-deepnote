import { assert } from 'chai';
import { when } from 'ts-mockito';
import { Uri, type NotebookDocument } from 'vscode';

import { flushNotebookDocumentIfDirty } from './deepnoteDocumentFlush';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';

// A plain object cast to NotebookDocument: the function only reads `uri`/`isDirty` and calls `save`,
// so a real ts-mockito mock (whose callable `then` breaks awaiting) is unnecessary here.
function fakeNotebookDocument(uri: Uri, isDirty: boolean, save: () => Promise<boolean>): NotebookDocument {
    return { uri, isDirty, notebookType: 'deepnote', save } as unknown as NotebookDocument;
}

suite('flushNotebookDocumentIfDirty', () => {
    setup(() => {
        resetVSCodeMocks();
    });

    test('saves a dirty matching document and returns true when the save succeeds', async () => {
        const targetUri = Uri.file('/workspace/target.deepnote');

        let saveCalls = 0;
        const doc = fakeNotebookDocument(targetUri, true, async () => {
            saveCalls++;

            return true;
        });
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([doc]);

        const result = await flushNotebookDocumentIfDirty(targetUri);

        assert.isTrue(result);
        assert.strictEqual(saveCalls, 1, 'the dirty document must be saved exactly once');
    });

    test('returns false when a dirty document declines the save (save resolves false)', async () => {
        const targetUri = Uri.file('/workspace/target.deepnote');

        const doc = fakeNotebookDocument(targetUri, true, async () => false);
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([doc]);

        const result = await flushNotebookDocumentIfDirty(targetUri);

        assert.isFalse(result);
    });
});
