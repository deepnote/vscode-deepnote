import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';
import { NotebookDocument, Uri, WorkspaceFolder } from 'vscode';

import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { DeepnoteInterpreterSidecar } from './deepnoteInterpreterSidecar.node';

const WORKSPACE = Uri.file('/workspace');
const PROJECT_ID = 'project-1';
const INTERPRETER: PythonEnvironment = { id: '/envs/first/bin/python', uri: Uri.file('/envs/first/bin/python') };
const OTHER_INTERPRETER: PythonEnvironment = {
    id: '/envs/second/bin/python',
    uri: Uri.file('/envs/second/bin/python')
};

/** `null` for a notebook whose metadata carries no project id. */
function notebook(projectId: string | null = PROJECT_ID, uri = Uri.file('/workspace/project.deepnote')) {
    return {
        uri,
        notebookType: 'deepnote',
        metadata: projectId ? { deepnoteProjectId: projectId } : {},
        isClosed: false
    } as unknown as NotebookDocument;
}

suite('DeepnoteInterpreterSidecar', () => {
    /** The workspace's files by fsPath, as the mocked `workspace.fs` sees them. */
    let files: Map<string, string>;
    let createdDirectories: string[];
    let writes: number;

    setup(() => {
        resetVSCodeMocks();
        files = new Map();
        createdDirectories = [];
        writes = 0;

        const folder = { uri: WORKSPACE, name: 'workspace', index: 0 } as WorkspaceFolder;
        when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([folder]);
        when(mockedVSCodeNamespaces.workspace.getWorkspaceFolder(anything())).thenReturn(folder);
        when(mockedVSCodeNamespaces.env.appName).thenReturn('Visual Studio Code');

        const fs = mock<typeof import('vscode').workspace.fs>();
        when(fs.readFile(anything())).thenCall((uri: Uri) => {
            const content = files.get(uri.fsPath);

            return content === undefined
                ? Promise.reject(new Error(`ENOENT: ${uri.fsPath}`))
                : Promise.resolve(Buffer.from(content, 'utf-8'));
        });
        when(fs.createDirectory(anything())).thenCall((uri: Uri) => {
            createdDirectories.push(uri.fsPath);

            return Promise.resolve();
        });
        when(fs.writeFile(anything(), anything())).thenCall((uri: Uri, content: Uint8Array) => {
            files.set(uri.fsPath, Buffer.from(content).toString('utf-8'));
            writes++;

            return Promise.resolve();
        });
        when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(fs));
    });

    function sidecar(settingsFolder = '.vscode') {
        const content = files.get(Uri.joinPath(WORKSPACE, settingsFolder, 'deepnote.json').fsPath);

        return content === undefined ? undefined : (JSON.parse(content) as { mappings: Record<string, unknown> });
    }

    test('writes the interpreter under the project id, in the workspace folder .vscode directory', async () => {
        await new DeepnoteInterpreterSidecar().record(notebook(), INTERPRETER);

        assert.deepStrictEqual(sidecar(), {
            mappings: { [PROJECT_ID]: { pythonInterpreter: INTERPRETER.uri.fsPath } }
        });
        assert.deepStrictEqual(createdDirectories, [Uri.joinPath(WORKSPACE, '.vscode').fsPath]);
        assert.match(
            files.get(Uri.joinPath(WORKSPACE, '.vscode', 'deepnote.json').fsPath)!,
            /\n$/,
            'the file ends with a newline, like the settings files beside it'
        );
    });

    test('keeps the entries of other projects in the same folder', async () => {
        files.set(
            Uri.joinPath(WORKSPACE, '.vscode', 'deepnote.json').fsPath,
            JSON.stringify({ mappings: { other: { pythonInterpreter: '/envs/other/bin/python' } } })
        );

        await new DeepnoteInterpreterSidecar().record(notebook(), INTERPRETER);

        assert.deepStrictEqual(sidecar()?.mappings, {
            other: { pythonInterpreter: '/envs/other/bin/python' },
            [PROJECT_ID]: { pythonInterpreter: INTERPRETER.uri.fsPath }
        });
    });

    test('replaces an entry written by the environments feature with the slim shape', async () => {
        files.set(
            Uri.joinPath(WORKSPACE, '.vscode', 'deepnote.json').fsPath,
            JSON.stringify({
                mappings: {
                    [PROJECT_ID]: {
                        environmentId: 'env-1',
                        venvPath: '/venvs/env-1',
                        pythonInterpreter: '/venvs/env-1/bin/python'
                    }
                }
            })
        );

        await new DeepnoteInterpreterSidecar().record(notebook(), INTERPRETER);

        assert.deepStrictEqual(sidecar()?.mappings, {
            [PROJECT_ID]: { pythonInterpreter: INTERPRETER.uri.fsPath }
        });
    });

    test('does not rewrite a file that already records this interpreter', async () => {
        const writer = new DeepnoteInterpreterSidecar();

        await writer.record(notebook(), INTERPRETER);
        await writer.record(notebook(), INTERPRETER);

        assert.strictEqual(writes, 1);
    });

    test('records the interpreter the notebook switched to', async () => {
        const writer = new DeepnoteInterpreterSidecar();

        await writer.record(notebook(), INTERPRETER);
        await writer.record(notebook(), OTHER_INTERPRETER);

        assert.deepStrictEqual(sidecar()?.mappings, {
            [PROJECT_ID]: { pythonInterpreter: OTHER_INTERPRETER.uri.fsPath }
        });
    });

    test('serializes concurrent records, so neither overwrites the other', async () => {
        const writer = new DeepnoteInterpreterSidecar();

        await Promise.all([
            writer.record(notebook(), INTERPRETER),
            writer.record(notebook('project-2', Uri.file('/workspace/second.deepnote')), OTHER_INTERPRETER)
        ]);

        assert.deepStrictEqual(sidecar()?.mappings, {
            [PROJECT_ID]: { pythonInterpreter: INTERPRETER.uri.fsPath },
            'project-2': { pythonInterpreter: OTHER_INTERPRETER.uri.fsPath }
        });
    });

    test('starts over when the existing file is not valid JSON', async () => {
        files.set(Uri.joinPath(WORKSPACE, '.vscode', 'deepnote.json').fsPath, '{ not json');

        await new DeepnoteInterpreterSidecar().record(notebook(), INTERPRETER);

        assert.deepStrictEqual(sidecar()?.mappings, {
            [PROJECT_ID]: { pythonInterpreter: INTERPRETER.uri.fsPath }
        });
    });

    test('writes nothing for a notebook without a project id', async () => {
        await new DeepnoteInterpreterSidecar().record(notebook(null), INTERPRETER);

        assert.strictEqual(writes, 0);
    });

    test('writes nothing when there is no workspace folder to write into', async () => {
        when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn(undefined);
        when(mockedVSCodeNamespaces.workspace.getWorkspaceFolder(anything())).thenReturn(undefined);

        await new DeepnoteInterpreterSidecar().record(notebook(), INTERPRETER);

        assert.strictEqual(writes, 0);
    });

    test('resolves rather than rejects when the write fails', async () => {
        const fs = mock<typeof import('vscode').workspace.fs>();
        when(fs.readFile(anything())).thenReject(new Error('ENOENT'));
        when(fs.createDirectory(anything())).thenReject(new Error('EACCES'));
        when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(fs));

        await new DeepnoteInterpreterSidecar().record(notebook(), INTERPRETER);
    });

    test('writes into .cursor when running in Cursor', async () => {
        when(mockedVSCodeNamespaces.env.appName).thenReturn('Cursor');

        await new DeepnoteInterpreterSidecar().record(notebook(), INTERPRETER);

        assert.isDefined(sidecar('.cursor'));
        assert.isUndefined(sidecar());
    });

    test('writes into .antigravity when running in Antigravity', async () => {
        when(mockedVSCodeNamespaces.env.appName).thenReturn('Antigravity');

        await new DeepnoteInterpreterSidecar().record(notebook(), INTERPRETER);

        assert.isDefined(sidecar('.antigravity'));
    });
});
