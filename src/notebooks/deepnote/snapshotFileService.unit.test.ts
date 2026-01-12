import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';
import { FileType, Uri, WorkspaceConfiguration, WorkspaceFolder } from 'vscode';

import type { DeepnoteBlock, DeepnoteFile } from '@deepnote/blocks';

import { SnapshotFileService } from './snapshotFileService.node';
import type { DeepnoteOutput } from '../../platform/deepnote/deepnoteTypes';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';

suite('SnapshotFileService', () => {
    let service: SnapshotFileService;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let serviceAny: any;

    setup(() => {
        resetVSCodeMocks();
        service = new SnapshotFileService();
        serviceAny = service;
    });

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

            service.mergeOutputsIntoBlocks(blocks, outputs);

            assert.deepEqual(blocks[0].outputs, [{ output_type: 'stream', name: 'stdout', text: '1\n' }]);
            assert.deepEqual(blocks[1].outputs, [{ output_type: 'stream', name: 'stdout', text: '2\n' }]);
            assert.isUndefined(blocks[2].outputs);
        });

        test('should not modify blocks without matching outputs', () => {
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

            service.mergeOutputsIntoBlocks(blocks, outputs);

            assert.deepEqual(blocks[0].outputs, [{ output_type: 'stream', text: 'old' }]);
        });

        test('should handle empty outputs map', () => {
            const blocks: DeepnoteBlock[] = [{ id: 'block-1', type: 'code', sortingKey: 'a0', content: 'print(1)' }];

            const outputs = new Map<string, DeepnoteOutput[]>();

            service.mergeOutputsIntoBlocks(blocks, outputs);

            assert.isUndefined(blocks[0].outputs);
        });

        test('should handle empty blocks array', () => {
            const blocks: DeepnoteBlock[] = [];
            const outputs = new Map<string, DeepnoteOutput[]>();

            outputs.set('block-1', [{ output_type: 'stream', text: 'test' }]);

            service.mergeOutputsIntoBlocks(blocks, outputs);

            assert.lengthOf(blocks, 0);
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
                    executionStartedAt: '2025-01-01T00:00:00Z',
                    outputs: [{ output_type: 'stream', text: '1' }]
                }
            ];

            const result = service.stripOutputsFromBlocks(blocks);

            assert.strictEqual(result[0].id, 'block-1');
            assert.strictEqual(result[0].type, 'code');
            assert.strictEqual(result[0].content, 'print(1)');
            assert.strictEqual(result[0].contentHash, 'sha256:abc123');
            assert.strictEqual(result[0].executionStartedAt, '2025-01-01T00:00:00Z');
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
            assert.deepEqual(result.get('block-1'), [{ output_type: 'stream', text: '1' }]);
            assert.deepEqual(result.get('block-2'), [{ output_type: 'stream', text: '2' }]);
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

            assert.deepEqual(result.get('block-1'), [complexOutput]);
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

        test('should return false by default when setting is not configured', () => {
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
project:
  id: test-project-id-123
  name: Test Project
  notebooks:
    - id: notebook-1
      name: Notebook 1
      blocks:
        - id: block-1
          type: code
          content: print(1)
          outputs:
            - output_type: stream
              name: stdout
              text: '1'
        - id: block-2
          type: markdown
          content: '# Hello'
`;
            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.readFile(anything())).thenResolve(new TextEncoder().encode(snapshotYaml) as any);
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            const result = await service.readSnapshot(projectId);

            assert.isDefined(result);
            assert.strictEqual(result!.size, 1);
            assert.deepEqual(result!.get('block-1'), [{ output_type: 'stream', name: 'stdout', text: '1' }]);
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
project:
  notebooks:
    - blocks:
        - id: block-1
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

        function createProjectData(): DeepnoteFile {
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

    suite('updateLatestSnapshot', () => {
        const projectUri = Uri.file('/workspace/my-project.deepnote');
        const projectId = 'test-project-id-123';
        const projectName = 'My Project';

        function createProjectData(): DeepnoteFile {
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

        test('should update only latest snapshot file', async () => {
            const projectData = createProjectData();

            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.stat(anything())).thenResolve({ type: FileType.Directory } as any);
            when(mockFs.readFile(anything())).thenReject(new Error('ENOENT'));
            when(mockFs.writeFile(anything(), anything())).thenResolve();
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            const result = await service.updateLatestSnapshot(projectUri, projectId, projectName, projectData);

            assert.isDefined(result);
            assert.include(result!.fsPath, 'latest');
            assert.include(result!.fsPath, 'snapshot.deepnote');
        });

        test('should return undefined when project name is invalid', async () => {
            const projectData = createProjectData();

            const result = await service.updateLatestSnapshot(projectUri, projectId, '', projectData);

            assert.isUndefined(result);
        });

        test('should return undefined when no changes detected', async () => {
            const projectData = createProjectData();

            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.stat(anything())).thenResolve({ type: FileType.Directory } as any);

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

            const result = await service.updateLatestSnapshot(projectUri, projectId, projectName, projectData);

            assert.isUndefined(result);
        });

        test('should return undefined when write fails', async () => {
            const projectData = createProjectData();

            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.stat(anything())).thenResolve({ type: FileType.Directory } as any);
            when(mockFs.readFile(anything())).thenReject(new Error('ENOENT'));
            when(mockFs.writeFile(anything(), anything())).thenReject(new Error('Write failed'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            const result = await service.updateLatestSnapshot(projectUri, projectId, projectName, projectData);

            assert.isUndefined(result);
        });

        test('should create directory if it does not exist', async () => {
            const projectData = createProjectData();

            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.stat(anything())).thenReject(new Error('ENOENT'));
            when(mockFs.createDirectory(anything())).thenResolve();
            when(mockFs.readFile(anything())).thenReject(new Error('ENOENT'));
            when(mockFs.writeFile(anything(), anything())).thenResolve();
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            const result = await service.updateLatestSnapshot(projectUri, projectId, projectName, projectData);

            assert.isDefined(result);
            assert.include(result!.fsPath, 'latest');
        });
    });
});
