import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';
import { EventEmitter, NotebookDocument, Uri, WorkspaceFolder } from 'vscode';

import type { IDisposableRegistry } from '../../../platform/common/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { IDeepnoteEnvironmentManager, IDeepnoteProjectEnvironmentMapper } from '../types';
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

suite('DeepnoteExtensionSidecarWriter', () => {
    let writer: DeepnoteExtensionSidecarWriter;
    let disposables: IDisposableRegistry;
    let mockMapper: IDeepnoteProjectEnvironmentMapper;
    let mockEnvironmentManager: IDeepnoteEnvironmentManager;

    let onDidSetEnvironment: EventEmitter<{ projectId: string; environmentId: string }>;
    let onDidRemoveEnvironment: EventEmitter<{ projectId: string }>;
    let onDidChangeEnvironments: EventEmitter<void>;
    let onDidOpenNotebookDocument: EventEmitter<NotebookDocument>;

    let writtenContent: string | undefined;
    let writeFileCallCount: number;
    let createDirectoryUris: Uri[];
    let readFileContent: string;

    const workspaceUri = Uri.file('/workspace');

    setup(() => {
        resetVSCodeMocks();
        writtenContent = undefined;
        writeFileCallCount = 0;
        createDirectoryUris = [];
        readFileContent = '';

        disposables = [];

        // Set up event emitters
        onDidSetEnvironment = new EventEmitter<{ projectId: string; environmentId: string }>();
        onDidRemoveEnvironment = new EventEmitter<{ projectId: string }>();
        onDidChangeEnvironments = new EventEmitter<void>();
        onDidOpenNotebookDocument = new EventEmitter<NotebookDocument>();
        disposables.push(
            onDidSetEnvironment,
            onDidRemoveEnvironment,
            onDidChangeEnvironments,
            onDidOpenNotebookDocument
        );

        // Set up mapper mock
        mockMapper = mock<IDeepnoteProjectEnvironmentMapper>();
        when(mockMapper.onDidSetEnvironment).thenReturn(onDidSetEnvironment.event);
        when(mockMapper.onDidRemoveEnvironment).thenReturn(onDidRemoveEnvironment.event);
        when(mockMapper.getAllMappings()).thenReturn(new Map());
        when(mockMapper.waitForInitialization()).thenResolve();

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
        when(mockFs.readFile(anything())).thenCall(() => {
            if (!readFileContent) {
                return Promise.reject(new Error('File not found'));
            }
            return Promise.resolve(Buffer.from(readFileContent, 'utf-8'));
        });
        when(mockFs.createDirectory(anything())).thenCall((uri: Uri) => {
            createDirectoryUris.push(uri);
            return Promise.resolve();
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
        const env = makeEnvironment({
            id: 'env-1',
            venvPath: Uri.file('/home/user/.venvs/my-env')
        });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env);

        writer.activate();

        onDidSetEnvironment.fire({ projectId: 'proj-abc', environmentId: 'env-1' });

        await waitFor(() => writeFileCallCount > 0);

        const sidecar = parseSidecar();
        assert.deepStrictEqual(sidecar.mappings['proj-abc'], {
            environmentId: 'env-1',
            venvPath: '/home/user/.venvs/my-env',
            pythonInterpreter: '/usr/bin/python3'
        });
    });

    test('remove mapping removes entry from sidecar', async () => {
        const env = makeEnvironment({ id: 'env-1' });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env);

        writer.activate();

        // First set, then remove
        onDidSetEnvironment.fire({ projectId: 'proj-abc', environmentId: 'env-1' });
        await waitFor(() => writeFileCallCount >= 1);

        // Set the sidecar content so the next read picks it up
        readFileContent = writtenContent!;

        onDidRemoveEnvironment.fire({ projectId: 'proj-abc' });
        await waitFor(() => writeFileCallCount >= 2);

        const sidecar = parseSidecar();
        assert.isUndefined(sidecar.mappings['proj-abc']);
        assert.deepStrictEqual(sidecar.mappings, {});
    });

    test('multiple projects accumulate entries in a single sidecar', async () => {
        const env1 = makeEnvironment({ id: 'env-1', venvPath: Uri.file('/venvs/env1') });
        const env2 = makeEnvironment({ id: 'env-2', venvPath: Uri.file('/venvs/env2') });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env1);
        when(mockEnvironmentManager.getEnvironment('env-2')).thenReturn(env2);

        writer.activate();

        onDidSetEnvironment.fire({ projectId: 'proj-1', environmentId: 'env-1' });
        await waitFor(() => writeFileCallCount >= 1);
        readFileContent = writtenContent!;

        onDidSetEnvironment.fire({ projectId: 'proj-2', environmentId: 'env-2' });
        await waitFor(() => writeFileCallCount >= 2);

        const sidecar = parseSidecar();
        assert.deepStrictEqual(sidecar.mappings, {
            'proj-1': { environmentId: 'env-1', venvPath: '/venvs/env1', pythonInterpreter: '/usr/bin/python3' },
            'proj-2': { environmentId: 'env-2', venvPath: '/venvs/env2', pythonInterpreter: '/usr/bin/python3' }
        });
    });

    test('error reading sidecar does not throw', async () => {
        const env = makeEnvironment({ id: 'env-1' });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env);

        // readFile will reject (default behavior when readFileContent is empty)
        writer.activate();

        // Should not throw even though readFile fails
        onDidSetEnvironment.fire({ projectId: 'proj-abc', environmentId: 'env-1' });
        await waitFor(() => writeFileCallCount >= 1);

        // Still writes successfully with a fresh sidecar
        const sidecar = parseSidecar();
        assert.isDefined(sidecar.mappings['proj-abc']);
    });

    test('error writing sidecar does not throw', async () => {
        const env = makeEnvironment({ id: 'env-1' });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env);

        // Make writeFile throw
        const mockFs = mock<typeof import('vscode').workspace.fs>();
        when(mockFs.readFile(anything())).thenReject(new Error('File not found'));
        when(mockFs.writeFile(anything(), anything())).thenReject(new Error('Permission denied'));
        when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

        writer.activate();

        // Should not throw
        onDidSetEnvironment.fire({ projectId: 'proj-abc', environmentId: 'env-1' });

        // Give time for the async operation to complete
        await new Promise((resolve) => setTimeout(resolve, 200));

        // No crash — test passes if we get here
    });

    test('environment changed refreshes sidecar with updated venvPath', async () => {
        const env = makeEnvironment({ id: 'env-1', venvPath: Uri.file('/venvs/old-path') });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env);

        writer.activate();

        // Set initial mapping
        onDidSetEnvironment.fire({ projectId: 'proj-abc', environmentId: 'env-1' });
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
        const env = makeEnvironment({ id: 'env-1' });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env);

        writer.activate();

        onDidSetEnvironment.fire({ projectId: 'proj-abc', environmentId: 'env-1' });
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

        const env = makeEnvironment({ id: 'env-1' });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env);

        writer.activate();

        onDidSetEnvironment.fire({ projectId: 'proj-abc', environmentId: 'env-1' });

        await new Promise((resolve) => setTimeout(resolve, 200));

        assert.strictEqual(writeFileCallCount, 0, 'Should not write when no workspace folder');
    });

    test('activation syncs existing project-keyed mappings to sidecar', async () => {
        // Mapper already has project-keyed entries (no need to read any .deepnote files)
        when(mockMapper.getAllMappings()).thenReturn(new Map([['proj-existing', 'env-existing']]));

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

    test('activation syncs multiple project-keyed mappings', async () => {
        when(mockMapper.getAllMappings()).thenReturn(
            new Map([
                ['proj-1', 'env-1'],
                ['proj-2', 'env-2']
            ])
        );

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

    test('activation skips entries whose environment does not exist', async () => {
        when(mockMapper.getAllMappings()).thenReturn(
            new Map([
                ['proj-good', 'env-1'],
                ['proj-missing', 'env-missing']
            ])
        );

        const env1 = makeEnvironment({ id: 'env-1', venvPath: Uri.file('/venvs/env1') });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env1);
        // env-missing returns undefined from the environment manager

        writer.activate();

        await waitFor(() => writeFileCallCount >= 1);

        const sidecar = parseSidecar();
        assert.strictEqual(Object.keys(sidecar.mappings).length, 1);
        assert.isDefined(sidecar.mappings['proj-good']);
        assert.isUndefined(sidecar.mappings['proj-missing']);
    });

    test('creates the editor settings folder before writing', async () => {
        const env = makeEnvironment({ id: 'env-1' });
        when(mockEnvironmentManager.getEnvironment('env-1')).thenReturn(env);

        writer.activate();

        onDidSetEnvironment.fire({ projectId: 'proj-abc', environmentId: 'env-1' });

        await waitFor(() => writeFileCallCount > 0);

        assert.strictEqual(createDirectoryUris.length, 1);
        assert.strictEqual(createDirectoryUris[0].fsPath, Uri.file('/workspace/.vscode').fsPath);
    });
});
