import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';
import { FileType, NotebookCellKind, Uri, WorkspaceConfiguration, WorkspaceFolder } from 'vscode';

import type { DeepnoteBlock, DeepnoteFile } from '@deepnote/blocks';

import { IEnvironmentCapture } from './environmentCapture.node';
import { SnapshotService } from './snapshotService';
import type { DeepnoteOutput } from '../../../platform/deepnote/deepnoteTypes';
import { IDisposableRegistry } from '../../../platform/common/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';

suite('SnapshotService', () => {
    let service: SnapshotService;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let serviceAny: any;
    let mockEnvironmentCapture: IEnvironmentCapture;
    let mockDisposables: IDisposableRegistry;

    setup(() => {
        resetVSCodeMocks();
        mockEnvironmentCapture = mock<IEnvironmentCapture>();
        mockDisposables = [];
        service = new SnapshotService(instance(mockEnvironmentCapture), mockDisposables);
        serviceAny = service;
    });

    function createProjectData(projectId = 'test-project-id-123', projectName = 'My Project'): DeepnoteFile {
        return {
            metadata: {
                createdAt: '2025-01-01T00:00:00Z'
            },
            version: '1.0',
            project: {
                id: projectId,
                name: projectName,
                notebooks: [
                    {
                        id: 'notebook-1',
                        name: 'Notebook 1',
                        blocks: [
                            {
                                id: 'block-1',
                                type: 'code',
                                sortingKey: 'a0',
                                content: 'print(1)',
                                outputs: [{ output_type: 'stream', text: '1' }]
                            }
                        ]
                    }
                ]
            }
        };
    }

    suite('buildSnapshotPath', () => {
        test('should build correct path for latest variant', () => {
            const projectUri = Uri.file('/path/to/my-project.deepnote');
            const projectId = 'e132b172-b114-410e-8331-011517db664f';
            const projectName = 'My Project';

            const result = serviceAny.buildSnapshotPath(projectUri, projectId, projectName, 'latest');

            assert.include(result.fsPath, 'snapshots');
            assert.include(result.fsPath, 'my-project');
            assert.include(result.fsPath, projectId);
            assert.include(result.fsPath, 'latest');
            assert.include(result.fsPath, '.snapshot.deepnote');
        });

        test('should build correct path for timestamped variant', () => {
            const projectUri = Uri.file('/path/to/my-project.deepnote');
            const projectId = 'e132b172-b114-410e-8331-011517db664f';
            const projectName = 'My Project';
            const timestamp = '2025-12-11T10-31-48';

            const result = serviceAny.buildSnapshotPath(projectUri, projectId, projectName, timestamp);

            assert.include(result.fsPath, 'snapshots');
            assert.include(result.fsPath, 'my-project');
            assert.include(result.fsPath, projectId);
            assert.include(result.fsPath, timestamp);
            assert.include(result.fsPath, '.snapshot.deepnote');
        });

        test('should slugify project name correctly', () => {
            const projectUri = Uri.file('/path/to/file.deepnote');
            const projectId = 'abc-123';
            const projectName = 'Customer Churn ML Playbook!';

            const result = serviceAny.buildSnapshotPath(projectUri, projectId, projectName, 'latest');

            assert.include(result.fsPath, 'customer-churn-ml-playbook');
            assert.notInclude(result.fsPath, '!');
            assert.notInclude(result.fsPath, ' ');
        });

        test('should handle project names with special characters', () => {
            const projectUri = Uri.file('/path/to/file.deepnote');
            const projectId = 'abc-123';
            const projectName = 'Test@#$%Project';

            const result = serviceAny.buildSnapshotPath(projectUri, projectId, projectName, 'latest');

            assert.include(result.fsPath, 'testproject');
        });

        test('should handle project names with multiple spaces', () => {
            const projectUri = Uri.file('/path/to/file.deepnote');
            const projectId = 'abc-123';
            const projectName = 'My   Project   Name';

            const result = serviceAny.buildSnapshotPath(projectUri, projectId, projectName, 'latest');

            assert.include(result.fsPath, 'my-project-name');
            assert.notInclude(result.fsPath, '--');
        });

        test('should throw error for empty project name', () => {
            const projectUri = Uri.file('/path/to/file.deepnote');
            const projectId = 'abc-123';
            const projectName = '';

            assert.throws(
                () => serviceAny.buildSnapshotPath(projectUri, projectId, projectName, 'latest'),
                'Project name cannot be empty or contain only special characters'
            );
        });

        test('should throw error for project name with only special characters', () => {
            const projectUri = Uri.file('/path/to/file.deepnote');
            const projectId = 'abc-123';
            const projectName = '@#$%^&*()';

            assert.throws(
                () => serviceAny.buildSnapshotPath(projectUri, projectId, projectName, 'latest'),
                'Project name cannot be empty or contain only special characters'
            );
        });

        test('should throw error for project name with only whitespace', () => {
            const projectUri = Uri.file('/path/to/file.deepnote');
            const projectId = 'abc-123';
            const projectName = '   ';

            assert.throws(
                () => serviceAny.buildSnapshotPath(projectUri, projectId, projectName, 'latest'),
                'Project name cannot be empty or contain only special characters'
            );
        });
    });

    suite('mergeOutputsIntoBlocks', () => {
        test('should merge outputs into blocks by ID', () => {
            const blocks: DeepnoteBlock[] = [
                { id: 'block-1', type: 'code', sortingKey: 'a0', content: 'print(1)' },
                { id: 'block-2', type: 'code', sortingKey: 'a1', content: 'print(2)' },
                { id: 'block-3', type: 'markdown', sortingKey: 'a2', content: '# Hello' }
            ];

            const outputs = new Map<string, DeepnoteOutput[]>();

            outputs.set('block-1', [{ output_type: 'stream', name: 'stdout', text: '1\n' }]);
            outputs.set('block-2', [{ output_type: 'stream', name: 'stdout', text: '2\n' }]);

            const result = service.mergeOutputsIntoBlocks(blocks, outputs);

            assert.deepStrictEqual(result[0].outputs, [{ output_type: 'stream', name: 'stdout', text: '1\n' }]);
            assert.deepStrictEqual(result[1].outputs, [{ output_type: 'stream', name: 'stdout', text: '2\n' }]);
            assert.isUndefined(result[2].outputs);
        });

        test('should not modify original blocks', () => {
            const blocks: DeepnoteBlock[] = [{ id: 'block-1', type: 'code', sortingKey: 'a0', content: 'print(1)' }];

            const outputs = new Map<string, DeepnoteOutput[]>();

            outputs.set('block-1', [{ output_type: 'stream', text: 'new' }]);

            service.mergeOutputsIntoBlocks(blocks, outputs);

            assert.isUndefined(blocks[0].outputs);
        });

        test('should preserve blocks without matching outputs', () => {
            const blocks: DeepnoteBlock[] = [
                {
                    id: 'block-1',
                    type: 'code',
                    sortingKey: 'a0',
                    content: 'print(1)',
                    outputs: [{ output_type: 'stream', text: 'old' }]
                }
            ];

            const outputs = new Map<string, DeepnoteOutput[]>();

            outputs.set('block-2', [{ output_type: 'stream', text: 'new' }]);

            const result = service.mergeOutputsIntoBlocks(blocks, outputs);

            assert.deepStrictEqual(result[0].outputs, [{ output_type: 'stream', text: 'old' }]);
        });

        test('should handle empty outputs map', () => {
            const blocks: DeepnoteBlock[] = [{ id: 'block-1', type: 'code', sortingKey: 'a0', content: 'print(1)' }];

            const outputs = new Map<string, DeepnoteOutput[]>();

            const result = service.mergeOutputsIntoBlocks(blocks, outputs);

            assert.lengthOf(result, 1);
            assert.isUndefined(result[0].outputs);
        });

        test('should handle empty blocks array', () => {
            const blocks: DeepnoteBlock[] = [];
            const outputs = new Map<string, DeepnoteOutput[]>();

            outputs.set('block-1', [{ output_type: 'stream', text: 'test' }]);

            const result = service.mergeOutputsIntoBlocks(blocks, outputs);

            assert.lengthOf(result, 0);
        });
    });

    suite('stripOutputsFromBlocks', () => {
        test('should remove outputs from all blocks', () => {
            const blocks: DeepnoteBlock[] = [
                {
                    id: 'block-1',
                    type: 'code',
                    sortingKey: 'a0',
                    content: 'print(1)',
                    outputs: [{ output_type: 'stream', text: '1' }]
                },
                {
                    id: 'block-2',
                    type: 'code',
                    sortingKey: 'a1',
                    content: 'print(2)',
                    outputs: [{ output_type: 'stream', text: '2' }]
                }
            ];

            const result = service.stripOutputsFromBlocks(blocks);

            assert.lengthOf(result, 2);
            assert.isUndefined(result[0].outputs);
            assert.isUndefined(result[1].outputs);
        });

        test('should preserve other block properties', () => {
            const blocks: DeepnoteBlock[] = [
                {
                    id: 'block-1',
                    type: 'code',
                    sortingKey: 'a0',
                    content: 'print(1)',
                    contentHash: 'sha256:abc123',
                    outputs: [{ output_type: 'stream', text: '1' }]
                }
            ];

            const result = service.stripOutputsFromBlocks(blocks);

            assert.strictEqual(result[0].id, 'block-1');
            assert.strictEqual(result[0].type, 'code');
            assert.strictEqual(result[0].content, 'print(1)');
            assert.strictEqual(result[0].contentHash, 'sha256:abc123');
            assert.isUndefined(result[0].outputs);
        });

        test('should strip execution timestamps from blocks', () => {
            const blocks: DeepnoteBlock[] = [
                {
                    id: 'block-1',
                    type: 'code',
                    sortingKey: 'a0',
                    content: 'print(1)',
                    contentHash: 'sha256:abc123',
                    executionStartedAt: '2025-01-01T00:00:00Z',
                    executionFinishedAt: '2025-01-01T00:00:01Z',
                    outputs: [{ output_type: 'stream', text: '1' }]
                }
            ];

            const result = service.stripOutputsFromBlocks(blocks);

            assert.strictEqual(result[0].id, 'block-1');
            assert.strictEqual(result[0].contentHash, 'sha256:abc123');
            assert.isUndefined(result[0].executionStartedAt);
            assert.isUndefined(result[0].executionFinishedAt);
            assert.isUndefined(result[0].outputs);
        });

        test('should strip executionCount from blocks', () => {
            const blocks: DeepnoteBlock[] = [
                {
                    id: 'block-1',
                    type: 'code',
                    sortingKey: 'a0',
                    content: 'print(1)',
                    contentHash: 'sha256:abc123',
                    executionCount: 5,
                    outputs: [{ output_type: 'stream', text: '1' }]
                }
            ];

            const result = service.stripOutputsFromBlocks(blocks);

            assert.strictEqual(result[0].id, 'block-1');
            assert.strictEqual(result[0].contentHash, 'sha256:abc123');
            assert.isUndefined(result[0].executionCount);
            assert.isUndefined(result[0].outputs);
        });

        test('should not modify original blocks', () => {
            const blocks: DeepnoteBlock[] = [
                {
                    id: 'block-1',
                    type: 'code',
                    sortingKey: 'a0',
                    content: 'print(1)',
                    outputs: [{ output_type: 'stream', text: '1' }]
                }
            ];

            service.stripOutputsFromBlocks(blocks);

            assert.isDefined(blocks[0].outputs);
        });

        test('should handle blocks without outputs', () => {
            const blocks: DeepnoteBlock[] = [{ id: 'block-1', type: 'code', sortingKey: 'a0', content: 'print(1)' }];

            const result = service.stripOutputsFromBlocks(blocks);

            assert.lengthOf(result, 1);
            assert.isUndefined(result[0].outputs);
        });

        test('should handle empty array', () => {
            const blocks: DeepnoteBlock[] = [];

            const result = service.stripOutputsFromBlocks(blocks);

            assert.lengthOf(result, 0);
        });
    });

    suite('extractOutputsFromBlocks', () => {
        test('should extract outputs into a map', () => {
            const blocks: DeepnoteBlock[] = [
                {
                    id: 'block-1',
                    type: 'code',
                    sortingKey: 'a0',
                    content: 'print(1)',
                    outputs: [{ output_type: 'stream', text: '1' }]
                },
                {
                    id: 'block-2',
                    type: 'code',
                    sortingKey: 'a1',
                    content: 'print(2)',
                    outputs: [{ output_type: 'stream', text: '2' }]
                }
            ];

            const result = service.extractOutputsFromBlocks(blocks);

            assert.strictEqual(result.size, 2);
            assert.deepStrictEqual(result.get('block-1'), [{ output_type: 'stream', text: '1' }]);
            assert.deepStrictEqual(result.get('block-2'), [{ output_type: 'stream', text: '2' }]);
        });

        test('should skip blocks without outputs', () => {
            const blocks: DeepnoteBlock[] = [
                {
                    id: 'block-1',
                    type: 'code',
                    sortingKey: 'a0',
                    content: 'print(1)',
                    outputs: [{ output_type: 'stream', text: '1' }]
                },
                { id: 'block-2', type: 'code', sortingKey: 'a1', content: 'print(2)' }
            ];

            const result = service.extractOutputsFromBlocks(blocks);

            assert.strictEqual(result.size, 1);
            assert.isTrue(result.has('block-1'));
            assert.isFalse(result.has('block-2'));
        });

        test('should skip blocks without ID', () => {
            const blocks = [
                { type: 'code', sortingKey: 'a0', content: 'print(1)', outputs: [{ output_type: 'stream', text: '1' }] }
            ] as unknown as DeepnoteBlock[];

            const result = service.extractOutputsFromBlocks(blocks);

            assert.strictEqual(result.size, 0);
        });

        test('should handle empty array', () => {
            const blocks: DeepnoteBlock[] = [];

            const result = service.extractOutputsFromBlocks(blocks);

            assert.strictEqual(result.size, 0);
        });

        test('should handle complex outputs', () => {
            const complexOutput: DeepnoteOutput = {
                output_type: 'execute_result',
                execution_count: 1,
                data: {
                    'text/html': '<table>...</table>',
                    'text/plain': 'DataFrame...'
                },
                metadata: { table_state_spec: '{}' }
            };

            const blocks: DeepnoteBlock[] = [
                { id: 'block-1', type: 'code', sortingKey: 'a0', content: 'df', outputs: [complexOutput] }
            ];

            const result = service.extractOutputsFromBlocks(blocks);

            assert.deepStrictEqual(result.get('block-1'), [complexOutput]);
        });
    });

    suite('isSnapshotsEnabled', () => {
        test('should return true when snapshots.enabled is true', () => {
            const mockConfig = mock<WorkspaceConfiguration>();
            when(mockConfig.get<boolean>('snapshots.enabled', false)).thenReturn(true);
            when(mockedVSCodeNamespaces.workspace.getConfiguration('deepnote')).thenReturn(instance(mockConfig));

            const result = service.isSnapshotsEnabled();

            assert.isTrue(result);
        });

        test('should return false when snapshots.enabled is false', () => {
            const mockConfig = mock<WorkspaceConfiguration>();
            when(mockConfig.get<boolean>('snapshots.enabled', false)).thenReturn(false);
            when(mockedVSCodeNamespaces.workspace.getConfiguration('deepnote')).thenReturn(instance(mockConfig));

            const result = service.isSnapshotsEnabled();

            assert.isFalse(result);
        });
    });

    suite('readSnapshot', () => {
        const projectId = 'test-project-id-123';

        test('should return undefined when no workspace folders exist', async () => {
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn(undefined);

            const result = await service.readSnapshot(projectId);

            assert.isUndefined(result);
        });

        test('should return undefined when workspace folders array is empty', async () => {
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([]);

            const result = await service.readSnapshot(projectId);

            assert.isUndefined(result);
        });

        test('should find and parse latest snapshot file', async () => {
            const workspaceFolder: WorkspaceFolder = {
                uri: Uri.file('/workspace'),
                name: 'workspace',
                index: 0
            };
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder]);

            const snapshotUri = Uri.file('/workspace/snapshots/project_test-project-id-123_latest.snapshot.deepnote');
            when(mockedVSCodeNamespaces.workspace.findFiles(anything(), anything(), anything())).thenResolve([
                snapshotUri
            ] as any);

            const snapshotYaml = `
version: '1.0'
metadata:
  createdAt: '2025-01-01T00:00:00Z'
project:
  id: test-project-id-123
  name: Test Project
  notebooks:
    - id: notebook-1
      name: Notebook 1
      blocks:
        - id: block-1
          type: code
          sortingKey: 'a0'
          content: print(1)
          outputs:
            - output_type: stream
              name: stdout
              text: '1'
        - id: block-2
          type: markdown
          sortingKey: 'a1'
          content: '# Hello'
`;
            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.readFile(anything())).thenResolve(new TextEncoder().encode(snapshotYaml) as any);
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            const result = await service.readSnapshot(projectId);

            assert.isDefined(result);
            assert.strictEqual(result!.size, 1);
            assert.deepStrictEqual(result!.get('block-1'), [{ output_type: 'stream', name: 'stdout', text: '1' }]);
        });

        test('should return undefined when no snapshot files found', async () => {
            const workspaceFolder: WorkspaceFolder = {
                uri: Uri.file('/workspace'),
                name: 'workspace',
                index: 0
            };
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder]);
            when(mockedVSCodeNamespaces.workspace.findFiles(anything(), anything(), anything())).thenResolve([] as any);

            const result = await service.readSnapshot(projectId);

            assert.isUndefined(result);
        });

        test('should fall back to most recent timestamped snapshot when no latest exists', async () => {
            const workspaceFolder: WorkspaceFolder = {
                uri: Uri.file('/workspace'),
                name: 'workspace',
                index: 0
            };
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder]);

            // First call for latest - returns empty
            // Second call for timestamped - returns files
            const timestampedUri1 = Uri.file(
                '/workspace/snapshots/project_test-project-id-123_2025-01-01T10-00-00.snapshot.deepnote'
            );
            const timestampedUri2 = Uri.file(
                '/workspace/snapshots/project_test-project-id-123_2025-01-02T10-00-00.snapshot.deepnote'
            );

            let callCount = 0;
            when(mockedVSCodeNamespaces.workspace.findFiles(anything(), anything(), anything())).thenCall(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve([]);
                }

                return Promise.resolve([timestampedUri1, timestampedUri2]);
            });

            const snapshotYaml = `
version: '1.0'
metadata:
  createdAt: '2025-01-02T00:00:00Z'
project:
  id: test-project-id-123
  name: Test Project
  notebooks:
    - id: notebook-1
      name: Notebook 1
      blocks:
        - id: block-1
          type: code
          sortingKey: 'a0'
          outputs:
            - output_type: stream
              text: 'from timestamped'
`;
            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.readFile(anything())).thenResolve(new TextEncoder().encode(snapshotYaml) as any);
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            const result = await service.readSnapshot(projectId);

            assert.isDefined(result);
            assert.strictEqual(result!.size, 1);
        });

        test('should return empty map when snapshot file read fails', async () => {
            const workspaceFolder: WorkspaceFolder = {
                uri: Uri.file('/workspace'),
                name: 'workspace',
                index: 0
            };
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder]);

            const snapshotUri = Uri.file('/workspace/snapshots/project_test-project-id-123_latest.snapshot.deepnote');
            when(mockedVSCodeNamespaces.workspace.findFiles(anything(), anything(), anything())).thenResolve([
                snapshotUri
            ] as any);

            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.readFile(anything())).thenReject(new Error('File read error'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            const result = await service.readSnapshot(projectId);

            // parseSnapshotFile catches read errors and returns empty map
            assert.isDefined(result);
            assert.strictEqual(result!.size, 0);
        });

        test('should return empty map when snapshot has invalid structure', async () => {
            const workspaceFolder: WorkspaceFolder = {
                uri: Uri.file('/workspace'),
                name: 'workspace',
                index: 0
            };
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder]);

            const snapshotUri = Uri.file('/workspace/snapshots/project_test-project-id-123_latest.snapshot.deepnote');
            when(mockedVSCodeNamespaces.workspace.findFiles(anything(), anything(), anything())).thenResolve([
                snapshotUri
            ] as any);

            const invalidYaml = 'not_an_object';
            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.readFile(anything())).thenResolve(new TextEncoder().encode(invalidYaml) as any);
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            const result = await service.readSnapshot(projectId);

            assert.isDefined(result);
            assert.strictEqual(result!.size, 0);
        });
    });

    suite('createSnapshot', () => {
        const projectUri = Uri.file('/workspace/my-project.deepnote');
        const projectId = 'test-project-id-123';
        const projectName = 'My Project';

        test('should create snapshot files when there are changes', async () => {
            const projectData = createProjectData();

            const mockFs = mock<typeof import('vscode').workspace.fs>();
            // Directory doesn't exist - stat throws
            when(mockFs.stat(anything())).thenReject(new Error('ENOENT'));
            when(mockFs.createDirectory(anything())).thenResolve();
            when(mockFs.readFile(anything())).thenReject(new Error('ENOENT'));
            when(mockFs.writeFile(anything(), anything())).thenResolve();
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            const result = await service.createSnapshot(projectUri, projectId, projectName, projectData);

            assert.isDefined(result);
            assert.include(result!.fsPath, 'snapshot.deepnote');
        });

        test('should return undefined when project name is invalid', async () => {
            const projectData = createProjectData();

            const result = await service.createSnapshot(projectUri, projectId, '', projectData);

            assert.isUndefined(result);
        });

        test('should return undefined when directory creation fails', async () => {
            const projectData = createProjectData();

            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.stat(anything())).thenReject(new Error('ENOENT'));
            when(mockFs.createDirectory(anything())).thenReject(new Error('Permission denied'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            const result = await service.createSnapshot(projectUri, projectId, projectName, projectData);

            assert.isUndefined(result);
        });

        test('should skip snapshot creation when no changes detected', async () => {
            const projectData = createProjectData();

            const mockFs = mock<typeof import('vscode').workspace.fs>();
            // Directory exists
            when(mockFs.stat(anything())).thenResolve({ type: FileType.Directory } as any);
            // Return same content as existing
            const existingYaml = `
metadata:
  createdAt: '2025-01-01T00:00:00Z'
version: '1.0'
project:
  id: test-project-id-123
  name: My Project
  notebooks:
    - id: notebook-1
      name: Notebook 1
      blocks:
        - id: block-1
          type: code
          sortingKey: a0
          content: print(1)
          outputs:
            - output_type: stream
              text: '1'
`;
            when(mockFs.readFile(anything())).thenResolve(new TextEncoder().encode(existingYaml) as any);
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            const result = await service.createSnapshot(projectUri, projectId, projectName, projectData);

            assert.isUndefined(result);
        });

        test('should return undefined when timestamped file write fails', async () => {
            const projectData = createProjectData();

            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.stat(anything())).thenResolve({ type: FileType.Directory } as any);
            when(mockFs.readFile(anything())).thenReject(new Error('ENOENT'));
            when(mockFs.writeFile(anything(), anything())).thenReject(new Error('Write failed'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            const result = await service.createSnapshot(projectUri, projectId, projectName, projectData);

            assert.isUndefined(result);
        });

        test('should return timestamped path even if latest write fails', async () => {
            const projectData = createProjectData();

            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.stat(anything())).thenResolve({ type: FileType.Directory } as any);
            when(mockFs.readFile(anything())).thenReject(new Error('ENOENT'));

            let writeCallCount = 0;
            when(mockFs.writeFile(anything(), anything())).thenCall(() => {
                writeCallCount++;
                if (writeCallCount === 1) {
                    // First write (timestamped) succeeds
                    return Promise.resolve();
                }
                // Second write (latest) fails
                return Promise.reject(new Error('Write failed'));
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            const result = await service.createSnapshot(projectUri, projectId, projectName, projectData);

            assert.isDefined(result);
            assert.include(result!.fsPath, 'snapshot.deepnote');
            assert.notInclude(result!.fsPath, 'latest');
        });
    });

    // Metadata tracking tests (now using serviceAny for private methods)
    suite('execution metadata tracking', () => {
        const notebookUri = 'file:///path/to/notebook.deepnote';
        const cellId = 'cell-123';

        suite('recordCellExecutionStart (private)', () => {
            test('should record cell execution start time', () => {
                const startTime = Date.now();

                serviceAny.recordCellExecutionStart(notebookUri, cellId, startTime);

                const metadata = service.getBlockExecutionMetadata(notebookUri, cellId);
                assert.isDefined(metadata);
                assert.isDefined(metadata!.executionStartedAt);
                assert.isUndefined(metadata!.executionFinishedAt);
            });

            test('should initialize notebook execution state', () => {
                const startTime = Date.now();

                serviceAny.recordCellExecutionStart(notebookUri, cellId, startTime);

                const executionMetadata = service.getExecutionMetadata(notebookUri);
                // Should not have execution metadata yet since no cells have completed
                assert.isUndefined(executionMetadata);
            });

            test('should handle multiple cells in same notebook', () => {
                const startTime = Date.now();

                serviceAny.recordCellExecutionStart(notebookUri, 'cell-1', startTime);
                serviceAny.recordCellExecutionStart(notebookUri, 'cell-2', startTime + 1000);

                const metadata1 = service.getBlockExecutionMetadata(notebookUri, 'cell-1');
                const metadata2 = service.getBlockExecutionMetadata(notebookUri, 'cell-2');

                assert.isDefined(metadata1);
                assert.isDefined(metadata2);
                assert.notStrictEqual(metadata1!.executionStartedAt, metadata2!.executionStartedAt);
            });
        });

        suite('recordCellExecutionEnd (private)', () => {
            test('should record successful cell execution end', () => {
                const startTime = Date.now();
                const endTime = startTime + 1000;

                serviceAny.recordCellExecutionStart(notebookUri, cellId, startTime);
                serviceAny.recordCellExecutionEnd(notebookUri, cellId, endTime, true);

                const metadata = service.getBlockExecutionMetadata(notebookUri, cellId);
                assert.isDefined(metadata);
                assert.isDefined(metadata!.executionStartedAt);
                assert.isDefined(metadata!.executionFinishedAt);
            });

            test('should update execution summary on success', () => {
                const startTime = Date.now();
                const endTime = startTime + 1000;

                serviceAny.recordCellExecutionStart(notebookUri, cellId, startTime);
                serviceAny.recordCellExecutionEnd(notebookUri, cellId, endTime, true);

                const executionMetadata = service.getExecutionMetadata(notebookUri);
                assert.isDefined(executionMetadata);
                assert.isDefined(executionMetadata!.summary);
                assert.strictEqual(executionMetadata!.summary!.blocksExecuted, 1);
                assert.strictEqual(executionMetadata!.summary!.blocksSucceeded, 1);
                assert.strictEqual(executionMetadata!.summary!.blocksFailed, 0);
            });

            test('should update execution summary on failure', () => {
                const startTime = Date.now();
                const endTime = startTime + 1000;

                serviceAny.recordCellExecutionStart(notebookUri, cellId, startTime);
                serviceAny.recordCellExecutionEnd(notebookUri, cellId, endTime, false);

                const executionMetadata = service.getExecutionMetadata(notebookUri);
                assert.isDefined(executionMetadata);
                assert.isDefined(executionMetadata!.summary);
                assert.strictEqual(executionMetadata!.summary!.blocksExecuted, 1);
                assert.strictEqual(executionMetadata!.summary!.blocksSucceeded, 0);
                assert.strictEqual(executionMetadata!.summary!.blocksFailed, 1);
            });

            test('should record error details on failure', () => {
                const startTime = Date.now();
                const endTime = startTime + 1000;
                const error = { name: 'TypeError', message: 'undefined is not a function' };

                serviceAny.recordCellExecutionStart(notebookUri, cellId, startTime);
                serviceAny.recordCellExecutionEnd(notebookUri, cellId, endTime, false, error);

                const executionMetadata = service.getExecutionMetadata(notebookUri);
                assert.isDefined(executionMetadata);
                assert.isDefined(executionMetadata!.error);
                assert.strictEqual(executionMetadata!.error!.name, 'TypeError');
                assert.strictEqual(executionMetadata!.error!.message, 'undefined is not a function');
            });

            test('should accumulate multiple cell executions', () => {
                const startTime = Date.now();

                // Execute 3 cells: 2 successful, 1 failed
                serviceAny.recordCellExecutionStart(notebookUri, 'cell-1', startTime);
                serviceAny.recordCellExecutionEnd(notebookUri, 'cell-1', startTime + 100, true);

                serviceAny.recordCellExecutionStart(notebookUri, 'cell-2', startTime + 200);
                serviceAny.recordCellExecutionEnd(notebookUri, 'cell-2', startTime + 300, true);

                serviceAny.recordCellExecutionStart(notebookUri, 'cell-3', startTime + 400);
                serviceAny.recordCellExecutionEnd(notebookUri, 'cell-3', startTime + 500, false);

                const executionMetadata = service.getExecutionMetadata(notebookUri);
                assert.isDefined(executionMetadata);
                assert.isDefined(executionMetadata!.summary);
                assert.strictEqual(executionMetadata!.summary!.blocksExecuted, 3);
                assert.strictEqual(executionMetadata!.summary!.blocksSucceeded, 2);
                assert.strictEqual(executionMetadata!.summary!.blocksFailed, 1);
            });

            test('should calculate total duration', () => {
                const startTime = Date.now();
                const endTime = startTime + 5000;

                serviceAny.recordCellExecutionStart(notebookUri, cellId, startTime);
                serviceAny.recordCellExecutionEnd(notebookUri, cellId, endTime, true);

                const executionMetadata = service.getExecutionMetadata(notebookUri);
                assert.isDefined(executionMetadata);
                assert.isDefined(executionMetadata!.summary);
                assert.strictEqual(executionMetadata!.summary!.totalDurationMs, 5000);
            });
        });

        suite('getExecutionMetadata', () => {
            test('should return undefined for unknown notebook', () => {
                const metadata = service.getExecutionMetadata('unknown-notebook');
                assert.isUndefined(metadata);
            });

            test('should return undefined if no cells have been executed', () => {
                const startTime = Date.now();
                serviceAny.recordCellExecutionStart(notebookUri, cellId, startTime);

                const metadata = service.getExecutionMetadata(notebookUri);
                assert.isUndefined(metadata);
            });

            test('should include ISO timestamps', () => {
                const startTime = Date.now();
                serviceAny.recordCellExecutionStart(notebookUri, cellId, startTime);
                serviceAny.recordCellExecutionEnd(notebookUri, cellId, startTime + 1000, true);

                const metadata = service.getExecutionMetadata(notebookUri);
                assert.isDefined(metadata);
                assert.isDefined(metadata!.startedAt);
                assert.isDefined(metadata!.finishedAt);
                // Should be valid ISO date strings
                assert.doesNotThrow(() => new Date(metadata!.startedAt!));
                assert.doesNotThrow(() => new Date(metadata!.finishedAt!));
            });
        });

        suite('getBlockExecutionMetadata', () => {
            test('should return undefined for unknown notebook', () => {
                const metadata = service.getBlockExecutionMetadata('unknown-notebook', cellId);
                assert.isUndefined(metadata);
            });

            test('should return undefined for unknown cell', () => {
                const startTime = Date.now();
                serviceAny.recordCellExecutionStart(notebookUri, cellId, startTime);

                const metadata = service.getBlockExecutionMetadata(notebookUri, 'unknown-cell');
                assert.isUndefined(metadata);
            });
        });

        suite('clearExecutionState', () => {
            test('should clear all state for a notebook', () => {
                const startTime = Date.now();
                serviceAny.recordCellExecutionStart(notebookUri, cellId, startTime);
                serviceAny.recordCellExecutionEnd(notebookUri, cellId, startTime + 1000, true);

                service.clearExecutionState(notebookUri);

                const executionMetadata = service.getExecutionMetadata(notebookUri);
                const blockMetadata = service.getBlockExecutionMetadata(notebookUri, cellId);

                assert.isUndefined(executionMetadata);
                assert.isUndefined(blockMetadata);
            });

            test('should only clear state for specified notebook', () => {
                const startTime = Date.now();
                const otherNotebookUri = 'file:///other/notebook.deepnote';

                serviceAny.recordCellExecutionStart(notebookUri, cellId, startTime);
                serviceAny.recordCellExecutionEnd(notebookUri, cellId, startTime + 1000, true);

                serviceAny.recordCellExecutionStart(otherNotebookUri, 'other-cell', startTime);
                serviceAny.recordCellExecutionEnd(otherNotebookUri, 'other-cell', startTime + 1000, true);

                service.clearExecutionState(notebookUri);

                // First notebook should be cleared
                assert.isUndefined(service.getExecutionMetadata(notebookUri));

                // Second notebook should still have state
                assert.isDefined(service.getExecutionMetadata(otherNotebookUri));
            });
        });

        suite('multiple notebooks', () => {
            test('should track state independently for different notebooks', () => {
                const notebook1 = 'file:///notebook1.deepnote';
                const notebook2 = 'file:///notebook2.deepnote';
                const startTime = Date.now();

                // Execute cells in different notebooks
                serviceAny.recordCellExecutionStart(notebook1, 'cell-1', startTime);
                serviceAny.recordCellExecutionEnd(notebook1, 'cell-1', startTime + 100, true);

                serviceAny.recordCellExecutionStart(notebook2, 'cell-2', startTime);
                serviceAny.recordCellExecutionEnd(notebook2, 'cell-2', startTime + 200, false);

                const metadata1 = service.getExecutionMetadata(notebook1);
                const metadata2 = service.getExecutionMetadata(notebook2);

                assert.isDefined(metadata1);
                assert.isDefined(metadata1!.summary);
                assert.strictEqual(metadata1!.summary!.blocksSucceeded, 1);
                assert.strictEqual(metadata1!.summary!.blocksFailed, 0);

                assert.isDefined(metadata2);
                assert.isDefined(metadata2!.summary);
                assert.strictEqual(metadata2!.summary!.blocksSucceeded, 0);
                assert.strictEqual(metadata2!.summary!.blocksFailed, 1);
            });
        });

        suite('Run All auto-detection', () => {
            test('should detect Run All when all code cells are executed', async () => {
                // Set up mocks
                const mockConfig = mock<WorkspaceConfiguration>();
                when(mockConfig.get<boolean>('snapshots.enabled', false)).thenReturn(true);
                when(mockedVSCodeNamespaces.workspace.getConfiguration('deepnote')).thenReturn(instance(mockConfig));

                const projectId = 'test-project-id';
                const notebookId = 'test-notebook-id';

                // Create mock cells - 3 code cells and 1 markdown
                const mockCodeCell1 = {
                    kind: NotebookCellKind.Code,
                    document: { getText: () => 'print(1)', languageId: 'python' },
                    metadata: { id: 'cell-1' },
                    outputs: [],
                    executionSummary: { success: true }
                };
                const mockCodeCell2 = {
                    kind: NotebookCellKind.Code,
                    document: { getText: () => 'print(2)', languageId: 'python' },
                    metadata: { id: 'cell-2' },
                    outputs: [],
                    executionSummary: { success: true }
                };
                const mockCodeCell3 = {
                    kind: NotebookCellKind.Code,
                    document: { getText: () => 'print(3)', languageId: 'python' },
                    metadata: { id: 'cell-3' },
                    outputs: [],
                    executionSummary: { success: true }
                };
                const mockMarkdownCell = {
                    kind: NotebookCellKind.Markup,
                    document: { getText: () => '# Title', languageId: 'markdown' },
                    metadata: { id: 'cell-md' },
                    outputs: []
                };

                const mockNotebook = {
                    uri: Uri.parse(notebookUri),
                    notebookType: 'deepnote',
                    metadata: {
                        deepnoteProjectId: projectId,
                        deepnoteNotebookId: notebookId
                    },
                    getCells: () => [mockCodeCell1, mockCodeCell2, mockMarkdownCell, mockCodeCell3]
                };

                when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([mockNotebook as any]);

                // Create mock notebook manager with original project
                const originalProject: DeepnoteFile = {
                    metadata: { createdAt: '2025-01-01T00:00:00Z' },
                    version: '1.0',
                    project: {
                        id: projectId,
                        name: 'Test Project',
                        notebooks: [
                            {
                                id: notebookId,
                                name: 'Test Notebook',
                                blocks: []
                            }
                        ]
                    }
                };

                const mockNotebookManager = {
                    getOriginalProject: sinon.stub().returns(originalProject)
                };

                // Create a new service with the mock notebook manager
                const testService = new SnapshotService(
                    instance(mockEnvironmentCapture),
                    mockDisposables,
                    mockNotebookManager as any
                );
                const testServiceAny = testService as any;

                // Record execution for all 3 code cells
                const startTime = Date.now();
                testServiceAny.recordCellExecutionStart(notebookUri, 'cell-1', startTime);
                testServiceAny.recordCellExecutionEnd(notebookUri, 'cell-1', startTime + 100, true);
                testServiceAny.recordCellExecutionStart(notebookUri, 'cell-2', startTime + 200);
                testServiceAny.recordCellExecutionEnd(notebookUri, 'cell-2', startTime + 300, true);
                testServiceAny.recordCellExecutionStart(notebookUri, 'cell-3', startTime + 400);
                testServiceAny.recordCellExecutionEnd(notebookUri, 'cell-3', startTime + 500, true);

                // Spy on createSnapshot and updateLatestSnapshot
                const createSnapshotSpy = sinon.spy(testServiceAny, 'createSnapshot');
                const updateLatestSnapshotSpy = sinon.spy(testServiceAny, 'updateLatestSnapshot');

                // Mock file system operations for snapshot creation
                const mockFs = mock<typeof import('vscode').workspace.fs>();
                when(mockFs.stat(anything())).thenResolve({ type: FileType.Directory } as any);
                when(mockFs.readFile(anything())).thenReject(new Error('ENOENT'));
                when(mockFs.writeFile(anything(), anything())).thenResolve();
                when(mockFs.copy(anything(), anything(), anything())).thenResolve();
                when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

                // Call onExecutionComplete (which should auto-detect Run All)
                await testServiceAny.onExecutionComplete(notebookUri);

                // ASSERT: createSnapshot should be called (full snapshot, not just latest)
                assert.isTrue(
                    createSnapshotSpy.calledOnce,
                    'createSnapshot should be called when all code cells are executed'
                );
                assert.isFalse(
                    updateLatestSnapshotSpy.called,
                    'updateLatestSnapshot should NOT be called when all code cells are executed'
                );
            });
        });

        suite('captureEnvironmentBeforeExecution', () => {
            test('should not throw for valid notebook URI', async () => {
                await service.captureEnvironmentBeforeExecution(notebookUri);
                // Should complete without error
            });
        });

        suite('getEnvironmentMetadata', () => {
            test('should return undefined when no environment captured', async () => {
                const result = await service.getEnvironmentMetadata(notebookUri);

                assert.isUndefined(result);
            });
        });
    });
});
