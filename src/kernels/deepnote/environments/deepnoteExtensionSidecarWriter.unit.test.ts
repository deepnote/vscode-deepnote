import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';
import { EventEmitter, NotebookDocument, Uri, WorkspaceFolder } from 'vscode';

import type { IDisposableRegistry } from '../../../platform/common/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { IDeepnoteEnvironmentManager, IDeepnoteNotebookEnvironmentMapper } from '../types';
import { DeepnoteEnvironment } from './deepnoteEnvironment';
import { DeepnoteExtensionSidecarWriter } from './deepnoteExtensionSidecarWriter.node';

const waitForTimeoutMs = 5000;
const waitForIntervalMs = 50;

async function waitFor(
    condition: () => boolean,
    timeoutMs = waitForTimeoutMs,
    intervalMs = waitForIntervalMs
): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`waitFor timed out after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

function makeEnvironment(overrides: Partial<DeepnoteEnvironment> & { id: string }): DeepnoteEnvironment {
    return {
        name: 'Test Env',
        pythonInterpreter: { id: 'python3', uri: Uri.file('/usr/bin/python3') } as any,
        venvPath: Uri.file('/home/user/.venvs/test'),
        managedVenv: true,
        createdAt: new Date(),
        lastUsedAt: new Date(),
        ...overrides
    };
}

function makeDeepnoteYaml(projectId: string): string {
    return `version: '1.0'\nproject:\n  id: ${projectId}\n  name: Test\n  notebooks: []\n`;
}

function createMockNotebook(opts: { uri: Uri; projectId?: string; notebookType?: string }): NotebookDocument {
    return {
        uri: opts.uri,
        notebookType: opts.notebookType ?? 'deepnote',
        metadata: { deepnoteProjectId: opts.projectId ?? 'project-1' },
        isDirty: false,
        isUntitled: false,
        isClosed: false,
        version: 1,
        cellCount: 0,
        cellAt: () => {
            throw new Error('Not implemented');
        },
        getCells: () => [],
        save: async () => true
    } as unknown as NotebookDocument;
}

suite('DeepnoteExtensionSidecarWriter', () => {
    let writer: DeepnoteExtensionSidecarWriter;
    let disposables: IDisposableRegistry;
    let mockMapper: IDeepnoteNotebookEnvironmentMapper;
    let mockEnvironmentManager: IDeepnoteEnvironmentManager;

    let onDidSetEnvironment: EventEmitter<{ notebookUri: Uri; environmentId: string }>;
    let onDidRemoveEnvironment: EventEmitter<{ notebookUri: Uri }>;
    let onDidChangeEnvironments: EventEmitter<void>;
    let onDidOpenNotebookDocument: EventEmitter<NotebookDocument>;

    let writtenContent: string | undefined;
    let writeFileCallCount: number;
    let readFileContent: string;
    /** Per-file read responses keyed by fsPath — used for .deepnote YAML files. */
    let fileContents: Map<string, string>;

    const workspaceUri = Uri.file('/workspace');

    setup(() => {
        resetVSCodeMocks();
        writtenContent = undefined;
        writeFileCallCount = 0;
        readFileContent = '';
        fileContents = new Map();

        disposables = [];

        // Set up event emitters
        onDidSetEnvironment = new EventEmitter<{ notebookUri: Uri; environmentId: string }>();
        onDidRemoveEnvironment = new EventEmitter<{ notebookUri: Uri }>();
        onDidChangeEnvironments = new EventEmitter<void>();
        onDidOpenNotebookDocument = new EventEmitter<NotebookDocument>();
        disposables.push(
            onDidSetEnvironment,
            onDidRemoveEnvironment,
            onDidChangeEnvironments,
            onDidOpenNotebookDocument
        );

        // Set up mapper mock
        mockMapper = mock<IDeepnoteNotebookEnvironmentMapper>();
        when(mockMapper.onDidSetEnvironment).thenReturn(onDidSetEnvironment.event);
        when(mockMapper.onDidRemoveEnvironment).thenReturn(onDidRemoveEnvironment.event);
        when(mockMapper.getAllMappings()).thenReturn(new Map());

        // Set up environment manager mock
        mockEnvironmentManager = mock<IDeepnoteEnvironmentManager>();
        when(mockEnvironmentManager.onDidChangeEnvironments).thenReturn(onDidChangeEnvironments.event);
        when(mockEnvironmentManager.waitForInitialization()).thenResolve();

        // Set up workspace folder and onDidOpenNotebookDocument
        const workspaceFolder = { uri: workspaceUri, name: 'workspace', index: 0 } as WorkspaceFolder;
        when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder]);
        when(mockedVSCodeNamespaces.workspace.onDidOpenNotebookDocument).thenReturn(onDidOpenNotebookDocument.event);

        // Set up workspace.fs mock
        setupMockFs();

        writer = new DeepnoteExtensionSidecarWriter(
            instance(mockMapper),
            instance(mockEnvironmentManager),
            disposables
        );
    });

    teardown(() => {
        sinon.restore();
        for (const d of disposables) {
            d.dispose();
        }
    });

    function setupMockFs() {
        const mockFs = mock<typeof import('vscode').workspace.fs>();
        when(mockFs.readFile(anything())).thenCall((uri: Uri) => {
            // Check per-file map first (for .deepnote YAML files)
            const perFile = fileContents.get(uri.fsPath);
            if (perFile !== undefined) {
                return Promise.resolve(Buffer.from(perFile, 'utf-8'));
            }
            // Fall back to global sidecar content
            if (!readFileContent) {
                return Promise.reject(new Error('File not found'));
            }
            return Promise.resolve(Buffer.from(readFileContent, 'utf-8'));
        });
        when(mockFs.writeFile(anything(), anything())).thenCall((_uri: Uri, content: Uint8Array) => {
            writtenContent = Buffer.from(content).toString('utf-8');
            writeFileCallCount++;
            return Promise.resolve();
        });
        when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));
    }

    function parseSidecar(): {
        mappings: Record<string, { environmentId: string; venvPath: string; pythonInterpreter: string }>;
    } {
        assert.isDefined(writtenContent, 'Expected sidecar to be written');
        return JSON.parse(writtenContent!);
    }

    test('set mapping writes sidecar with correct projectId, environmentId, and venvPath', async () => {
        const notebookUri = Uri.file('/workspace/project.deepnote');
        const notebook = createMockNotebook({ uri: notebookUri, projectId: 'proj-abc' });
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        const env = makeEnvironment({
            id: 'env-1',
            venvPath: Uri.file('/home/user/.venvs/my-env')
        });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env);

        writer.activate();

        onDidSetEnvironment.fire({ notebookUri, environmentId: 'env-1' });

        await waitFor(() => writeFileCallCount > 0);

        const sidecar = parseSidecar();
        assert.deepStrictEqual(sidecar.mappings['proj-abc'], {
            environmentId: 'env-1',
            venvPath: '/home/user/.venvs/my-env',
            pythonInterpreter: '/usr/bin/python3'
        });
    });

    test('remove mapping removes entry from sidecar', async () => {
        const notebookUri = Uri.file('/workspace/project.deepnote');
        const notebook = createMockNotebook({ uri: notebookUri, projectId: 'proj-abc' });
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        const env = makeEnvironment({ id: 'env-1' });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env);

        writer.activate();

        // First set, then remove
        onDidSetEnvironment.fire({ notebookUri, environmentId: 'env-1' });
        await waitFor(() => writeFileCallCount >= 1);

        // Set the sidecar content so the next read picks it up
        readFileContent = writtenContent!;

        onDidRemoveEnvironment.fire({ notebookUri });
        await waitFor(() => writeFileCallCount >= 2);

        const sidecar = parseSidecar();
        assert.isUndefined(sidecar.mappings['proj-abc']);
        assert.deepStrictEqual(sidecar.mappings, {});
    });

    test('multiple projects accumulate entries in a single sidecar', async () => {
        const uri1 = Uri.file('/workspace/project1.deepnote');
        const uri2 = Uri.file('/workspace/project2.deepnote');
        const nb1 = createMockNotebook({ uri: uri1, projectId: 'proj-1' });
        const nb2 = createMockNotebook({ uri: uri2, projectId: 'proj-2' });
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([nb1, nb2]);

        const env1 = makeEnvironment({ id: 'env-1', venvPath: Uri.file('/venvs/env1') });
        const env2 = makeEnvironment({ id: 'env-2', venvPath: Uri.file('/venvs/env2') });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env1);
        when(mockEnvironmentManager.getEnvironment('env-2')).thenReturn(env2);

        writer.activate();

        onDidSetEnvironment.fire({ notebookUri: uri1, environmentId: 'env-1' });
        await waitFor(() => writeFileCallCount >= 1);
        readFileContent = writtenContent!;

        onDidSetEnvironment.fire({ notebookUri: uri2, environmentId: 'env-2' });
        await waitFor(() => writeFileCallCount >= 2);

        const sidecar = parseSidecar();
        assert.deepStrictEqual(sidecar.mappings, {
            'proj-1': { environmentId: 'env-1', venvPath: '/venvs/env1', pythonInterpreter: '/usr/bin/python3' },
            'proj-2': { environmentId: 'env-2', venvPath: '/venvs/env2', pythonInterpreter: '/usr/bin/python3' }
        });
    });

    test('error reading sidecar does not throw', async () => {
        const notebookUri = Uri.file('/workspace/project.deepnote');
        const notebook = createMockNotebook({ uri: notebookUri, projectId: 'proj-abc' });
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        const env = makeEnvironment({ id: 'env-1' });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env);

        // readFile will reject (default behavior when readFileContent is empty)
        writer.activate();

        // Should not throw even though readFile fails
        onDidSetEnvironment.fire({ notebookUri, environmentId: 'env-1' });
        await waitFor(() => writeFileCallCount >= 1);

        // Still writes successfully with a fresh sidecar
        const sidecar = parseSidecar();
        assert.isDefined(sidecar.mappings['proj-abc']);
    });

    test('error writing sidecar does not throw', async () => {
        const notebookUri = Uri.file('/workspace/project.deepnote');
        const notebook = createMockNotebook({ uri: notebookUri, projectId: 'proj-abc' });
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        const env = makeEnvironment({ id: 'env-1' });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env);

        // Make writeFile throw
        const mockFs = mock<typeof import('vscode').workspace.fs>();
        when(mockFs.readFile(anything())).thenReject(new Error('File not found'));
        when(mockFs.writeFile(anything(), anything())).thenReject(new Error('Permission denied'));
        when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

        writer.activate();

        // Should not throw
        onDidSetEnvironment.fire({ notebookUri, environmentId: 'env-1' });

        // Give time for the async operation to complete
        await new Promise((resolve) => setTimeout(resolve, 200));

        // No crash — test passes if we get here
    });

    test('environment changed refreshes sidecar with updated venvPath', async () => {
        const notebookUri = Uri.file('/workspace/project.deepnote');
        const notebook = createMockNotebook({ uri: notebookUri, projectId: 'proj-abc' });
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        const env = makeEnvironment({ id: 'env-1', venvPath: Uri.file('/venvs/old-path') });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env);

        writer.activate();

        // Set initial mapping
        onDidSetEnvironment.fire({ notebookUri, environmentId: 'env-1' });
        await waitFor(() => writeFileCallCount >= 1);
        readFileContent = writtenContent!;

        // Now change the env venvPath
        const updatedEnv = makeEnvironment({ id: 'env-1', venvPath: Uri.file('/venvs/new-path') });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(updatedEnv);

        onDidChangeEnvironments.fire();
        await waitFor(() => writeFileCallCount >= 2);

        const sidecar = parseSidecar();
        assert.strictEqual(sidecar.mappings['proj-abc'].venvPath, '/venvs/new-path');
    });

    test('environment deleted removes entry on environments changed', async () => {
        const notebookUri = Uri.file('/workspace/project.deepnote');
        const notebook = createMockNotebook({ uri: notebookUri, projectId: 'proj-abc' });
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        const env = makeEnvironment({ id: 'env-1' });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env);

        writer.activate();

        onDidSetEnvironment.fire({ notebookUri, environmentId: 'env-1' });
        await waitFor(() => writeFileCallCount >= 1);
        readFileContent = writtenContent!;

        // Now the environment no longer exists
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(undefined);

        onDidChangeEnvironments.fire();
        await waitFor(() => writeFileCallCount >= 2);

        const sidecar = parseSidecar();
        assert.isUndefined(sidecar.mappings['proj-abc']);
    });

    test('no-op when no workspace folder is open', async () => {
        when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn(undefined);

        const notebookUri = Uri.file('/workspace/project.deepnote');
        const notebook = createMockNotebook({ uri: notebookUri, projectId: 'proj-abc' });
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        const env = makeEnvironment({ id: 'env-1' });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env);

        writer.activate();

        onDidSetEnvironment.fire({ notebookUri, environmentId: 'env-1' });

        await new Promise((resolve) => setTimeout(resolve, 200));

        assert.strictEqual(writeFileCallCount, 0, 'Should not write when no workspace folder');
    });

    test('activation syncs existing mappings to sidecar by reading .deepnote files', async () => {
        const fsPath = '/workspace/project.deepnote';

        // Mapper has a persisted entry — notebook is NOT open
        when(mockMapper.getAllMappings()).thenReturn(new Map([[fsPath, 'env-existing']]));
        fileContents.set(fsPath, makeDeepnoteYaml('proj-existing'));

        const env = makeEnvironment({ id: 'env-existing', venvPath: Uri.file('/venvs/existing') });
        when(mockEnvironmentManager.getEnvironment('env-existing')).thenReturn(env);

        writer.activate();

        await waitFor(() => writeFileCallCount >= 1);

        const sidecar = parseSidecar();
        assert.deepStrictEqual(sidecar.mappings['proj-existing'], {
            environmentId: 'env-existing',
            venvPath: '/venvs/existing',
            pythonInterpreter: '/usr/bin/python3'
        });
    });

    test('activation syncs multiple projects including closed notebooks', async () => {
        const path1 = '/workspace/proj1.deepnote';
        const path2 = '/workspace/proj2.deepnote';

        when(mockMapper.getAllMappings()).thenReturn(
            new Map([
                [path1, 'env-1'],
                [path2, 'env-2']
            ])
        );
        fileContents.set(path1, makeDeepnoteYaml('proj-1'));
        fileContents.set(path2, makeDeepnoteYaml('proj-2'));

        const env1 = makeEnvironment({ id: 'env-1', venvPath: Uri.file('/venvs/env1') });
        const env2 = makeEnvironment({ id: 'env-2', venvPath: Uri.file('/venvs/env2') });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env1);
        when(mockEnvironmentManager.getEnvironment('env-2')).thenReturn(env2);

        writer.activate();

        await waitFor(() => writeFileCallCount >= 1);

        const sidecar = parseSidecar();
        assert.deepStrictEqual(sidecar.mappings, {
            'proj-1': { environmentId: 'env-1', venvPath: '/venvs/env1', pythonInterpreter: '/usr/bin/python3' },
            'proj-2': { environmentId: 'env-2', venvPath: '/venvs/env2', pythonInterpreter: '/usr/bin/python3' }
        });
    });

    test('activation skips entries whose .deepnote file cannot be read', async () => {
        const goodPath = '/workspace/good.deepnote';
        const badPath = '/workspace/missing.deepnote';

        when(mockMapper.getAllMappings()).thenReturn(
            new Map([
                [goodPath, 'env-1'],
                [badPath, 'env-2']
            ])
        );
        fileContents.set(goodPath, makeDeepnoteYaml('proj-good'));
        // badPath not in fileContents → readFile will reject

        const env1 = makeEnvironment({ id: 'env-1', venvPath: Uri.file('/venvs/env1') });
        const env2 = makeEnvironment({ id: 'env-2', venvPath: Uri.file('/venvs/env2') });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env1);
        when(mockEnvironmentManager.getEnvironment('env-2')).thenReturn(env2);

        writer.activate();

        await waitFor(() => writeFileCallCount >= 1);

        const sidecar = parseSidecar();
        assert.strictEqual(Object.keys(sidecar.mappings).length, 1);
        assert.isDefined(sidecar.mappings['proj-good']);
        assert.isUndefined(sidecar.mappings['proj-missing']);
    });

    test('opening a notebook with existing mapping writes to sidecar', async () => {
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([]);

        writer.activate();

        // Wait for initial sync (no-op since no notebooks open)
        await new Promise((resolve) => setTimeout(resolve, 100));

        const notebookUri = Uri.file('/workspace/project.deepnote');
        const notebook = createMockNotebook({ uri: notebookUri, projectId: 'proj-opened' });

        const env = makeEnvironment({ id: 'env-1', venvPath: Uri.file('/venvs/env1') });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env);
        when(mockMapper.getEnvironmentForNotebook(anything())).thenReturn('env-1');

        onDidOpenNotebookDocument.fire(notebook);

        await waitFor(() => writeFileCallCount >= 1);

        const sidecar = parseSidecar();
        assert.deepStrictEqual(sidecar.mappings['proj-opened'], {
            environmentId: 'env-1',
            venvPath: '/venvs/env1',
            pythonInterpreter: '/usr/bin/python3'
        });
    });

    test('no-op when notebook has no projectId in metadata', async () => {
        const notebookUri = Uri.file('/workspace/project.deepnote');
        // Notebook without projectId
        const notebook = {
            uri: notebookUri,
            notebookType: 'deepnote',
            metadata: {},
            isDirty: false,
            isUntitled: false,
            isClosed: false,
            version: 1,
            cellCount: 0,
            cellAt: () => {
                throw new Error('Not implemented');
            },
            getCells: () => [],
            save: async () => true
        } as unknown as NotebookDocument;

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        const env = makeEnvironment({ id: 'env-1' });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env);

        writer.activate();

        onDidSetEnvironment.fire({ notebookUri, environmentId: 'env-1' });

        await new Promise((resolve) => setTimeout(resolve, 200));

        assert.strictEqual(writeFileCallCount, 0, 'Should not write when no projectId');
    });
});
