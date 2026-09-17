// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { assert } from 'chai';
import { instance, mock, when } from 'ts-mockito';
import { NotebookDocument, NotebookEditor, Uri } from 'vscode';
import { InteractiveWindowView, JupyterNotebookView } from '../platform/common/constants';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../test/vscode-mock';
import { NotebookEditorProvider } from './notebookEditorProvider';

suite('Notebook Editor Provider', () => {
    let provider: NotebookEditorProvider;

    setup(() => {
        resetVSCodeMocks();
        when(mockedVSCodeNamespaces.window.activeTextEditor).thenReturn(undefined);
        provider = new NotebookEditorProvider();
    });

    function activateNotebook(uri: Uri, notebookType: string): NotebookEditor {
        const document = mock<NotebookDocument>();
        when(document.uri).thenReturn(uri);
        when(document.notebookType).thenReturn(notebookType);
        const notebook = instance(document);
        const editor = mock<NotebookEditor>();
        when(editor.notebook).thenReturn(notebook);
        const notebookEditor = instance(editor);
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(notebookEditor);

        return notebookEditor;
    }

    test('the active Deepnote notebook is the active notebook editor', () => {
        const editor = activateNotebook(Uri.file('/workspace/analysis.deepnote'), 'deepnote');

        assert.strictEqual(provider.activeNotebookEditor, editor);
    });

    test('the active .ipynb notebook is the active notebook editor', () => {
        const editor = activateNotebook(Uri.file('/workspace/analysis.ipynb'), JupyterNotebookView);

        assert.strictEqual(provider.activeNotebookEditor, editor);
    });

    test('an Interactive Window is left to the embedded providers', () => {
        activateNotebook(Uri.parse('vscode-interactive://1'), InteractiveWindowView);

        assert.isUndefined(provider.activeNotebookEditor);
    });

    test('nothing is found when no notebook is active', () => {
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([]);
        when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);

        assert.isUndefined(provider.activeNotebookEditor);
    });
});
