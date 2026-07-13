import * as fakeTimers from '@sinonjs/fake-timers';
import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, instance, mock, verify, when } from 'ts-mockito';
import {
    EventEmitter,
    FileType,
    NotebookCell,
    NotebookCellKind,
    NotebookDocument,
    NotebookDocumentCellChange,
    NotebookDocumentChangeEvent,
    TextDocument,
    Uri,
    WorkspaceConfiguration,
    WorkspaceFolder
} from 'vscode';

import type { DeepnoteBlock, DeepnoteFile, Environment, ExecutableBlock } from '@deepnote/blocks';

import {
    NotebookCellExecutionState,
    notebookCellExecutions
} from '../../../platform/notebooks/cellExecutionStateService';
import { IEnvironmentCapture } from './environmentCapture.node';
import { ExecutionMetadataTracker } from './executionMetadataTracker';
import { buildSnapshotPath } from './snapshotFiles';
import { SnapshotService } from './snapshotService';
import { InvalidProjectNameError } from '../../../platform/errors/invalidProjectNameError';
import type { DeepnoteOutput } from '../../../platform/deepnote/deepnoteTypes';
import { IDeepnoteNotebookManager } from '../../types';
import { IDisposableRegistry } from '../../../platform/common/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';

suite('SnapshotService', () => {
    let service: SnapshotService;
    let mockEnvironmentCapture: IEnvironmentCapture;
    let mockDisposables: IDisposableRegistry;
    let tracker: ExecutionMetadataTracker;

    setup(() => {
        resetVSCodeMocks();
        mockEnvironmentCapture = mock<IEnvironmentCapture>();
        mockDisposables = [];
        tracker = new ExecutionMetadataTracker();
        service = new SnapshotService(instance(mockEnvironmentCapture), mockDisposables, undefined, tracker);
    });

    teardown(() => {
        // activate() subscribes to the module-singleton execution emitters; without disposal those
        // subscriptions leak across tests and receive later tests' fired events.
        mockDisposables.forEach((d) => d.dispose());
        mockDisposables.length = 0;
    });

    /** The URI of the notebook the activated-service fixture registers and records as executed. */
    const activatedServiceNotebookUri = 'file:///workspace/notebook.deepnote';

    function mockCell(options: {
        id: string;
        kind?: NotebookCellKind;
        languageId?: string;
        source?: string;
    }): NotebookCell {
        const { id, kind = NotebookCellKind.Code, languageId = 'python', source = 'print(1)' } = options;

        const document = mock<TextDocument>();
        when(document.getText()).thenReturn(source);
        when(document.languageId).thenReturn(languageId);

        const cell = mock<NotebookCell>();
        when(cell.kind).thenReturn(kind);
        when(cell.document).thenReturn(instance(document));
        when(cell.metadata).thenReturn({ id });
        when(cell.outputs).thenReturn([]);
        when(cell.executionSummary).thenReturn({ success: true });

        return instance(cell);
    }

    function mockNotebookDoc(options: {
        cells: NotebookCell[];
        notebookId: string;
        projectId: string;
        uri: Uri;
    }): NotebookDocument {
        const { cells, notebookId, projectId, uri } = options;

        const doc = mock<NotebookDocument>();
        when(doc.uri).thenReturn(uri);
        when(doc.notebookType).thenReturn('deepnote');
        when(doc.metadata).thenReturn({ deepnoteProjectId: projectId, deepnoteNotebookId: notebookId });
        when(doc.getCells()).thenReturn(cells);

        return instance(doc);
    }

    /**
     * Installs suite-owned notebook change/close emitters onto the workspace mock so activate()'s
     * subscriptions resolve to events the test can fire (resetVSCodeMocks does not stub these).
     */
    function installNotebookDocumentEmitters(): {
        changeEmitter: EventEmitter<NotebookDocumentChangeEvent>;
        closeEmitter: EventEmitter<NotebookDocument>;
    } {
        const changeEmitter = new EventEmitter<NotebookDocumentChangeEvent>();
        const closeEmitter = new EventEmitter<NotebookDocument>();

        when(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument).thenReturn(changeEmitter.event);
        when(mockedVSCodeNamespaces.workspace.onDidCloseNotebookDocument).thenReturn(closeEmitter.event);

        return { changeEmitter, closeEmitter };
    }

    /**
     * Builds and activates a SnapshotService wired end-to-end so a deferred flush reaches the public
     * createSnapshot seam: snapshots enabled, one executed code cell (the Run-All branch), the notebook
     * open in the workspace, a manager returning its project, and suite-owned change/close emitters.
     */
    function buildActivatedSnapshotService(): {
        changeEmitter: EventEmitter<NotebookDocumentChangeEvent>;
        closeEmitter: EventEmitter<NotebookDocument>;
        service: SnapshotService;
    } {
        const projectId = 'fixture-project-id';
        const notebookId = 'fixture-notebook-id';

        const notebookDoc = mockNotebookDoc({
            uri: Uri.parse(activatedServiceNotebookUri),
            projectId,
            notebookId,
            cells: [mockCell({ id: 'cell-1' })]
        });
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookDoc]);

        const config = mock<WorkspaceConfiguration>();
        when(config.get<boolean>('snapshots.enabled', true)).thenReturn(true);
        when(mockedVSCodeNamespaces.workspace.getConfiguration('deepnote')).thenReturn(instance(config));

        const originalProject: DeepnoteFile = {
            metadata: { createdAt: '2025-01-01T00:00:00Z' },
            version: '1.0.0',
            project: {
                id: projectId,
                name: 'Fixture Project',
                notebooks: [{ id: notebookId, name: 'Fixture Notebook', blocks: [] }]
            }
        };
        const notebookManager = mock<IDeepnoteNotebookManager>();
        when(notebookManager.getProjectForNotebook(anything(), anything())).thenReturn(originalProject);

        // Record the single code cell as executed so the flush takes the Run-All (timestamped) branch.
        const startTime = Date.now();
        tracker.recordCellExecutionStart(activatedServiceNotebookUri, 'cell-1', startTime);
        tracker.recordCellExecutionEnd(activatedServiceNotebookUri, 'cell-1', startTime + 100, true);

        const { changeEmitter, closeEmitter } = installNotebookDocumentEmitters();

        const built = new SnapshotService(
            instance(mockEnvironmentCapture),
            mockDisposables,
            instance(notebookManager),
            tracker
        );
        built.activate();

        return { changeEmitter, closeEmitter, service: built };
    }

    function createProjectData(projectId = 'test-project-id-123', projectName = 'My Project'): DeepnoteFile {
        return {
            metadata: {
                createdAt: '2025-01-01T00:00:00Z'
            },
            version: '1.0.0',
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
                                blockGroup: '1',
                                metadata: {},
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

            const result = buildSnapshotPath({
                projectUri,
                projectId,
                projectName,
                variant: 'latest'
            });

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

            const result = buildSnapshotPath({
                projectUri,
                projectId,
                projectName,
                variant: timestamp
            });

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

            const result = buildSnapshotPath({
                projectUri,
                projectId,
                projectName,
                variant: 'latest'
            });

            assert.include(result.fsPath, 'customer-churn-ml-playbook');
            assert.notInclude(result.fsPath, '!');
            assert.notInclude(result.fsPath, ' ');
        });

        test('should handle project names with special characters', () => {
            const projectUri = Uri.file('/path/to/file.deepnote');
            const projectId = 'abc-123';
            const projectName = 'Test@#$%Project';

            const result = buildSnapshotPath({
                projectUri,
                projectId,
                projectName,
                variant: 'latest'
            });

            // convert's slugifyProjectName collapses a run of special characters to a single hyphen.
            assert.include(result.fsPath, 'test-project');
        });

        test('should embed the notebook id when provided', () => {
            const projectUri = Uri.file('/path/to/my-project.deepnote');
            const projectId = 'e132b172-b114-410e-8331-011517db664f';
            const projectName = 'My Project';
            const notebookId = 'notebook-1';

            const result = buildSnapshotPath({
                projectUri,
                projectId,
                projectName,
                variant: 'latest',
                notebookId
            });

            assert.include(result.fsPath, `${projectId}_notebook-1_latest.snapshot.deepnote`);
        });

        test('should handle project names with multiple spaces', () => {
            const projectUri = Uri.file('/path/to/file.deepnote');
            const projectId = 'abc-123';
            const projectName = 'My   Project   Name';

            const result = buildSnapshotPath({
                projectUri,
                projectId,
                projectName,
                variant: 'latest'
            });

            assert.include(result.fsPath, 'my-project-name');
            assert.notInclude(result.fsPath, '--');
        });

        test('should throw error for empty project name', () => {
            const projectUri = Uri.file('/path/to/file.deepnote');
            const projectId = 'abc-123';
            const projectName = '';

            assert.throws(
                () => buildSnapshotPath({ projectUri, projectId, projectName, variant: 'latest' }),
                'Project name cannot be empty or contain only special characters'
            );
        });

        test('should throw error for project name with only special characters', () => {
            const projectUri = Uri.file('/path/to/file.deepnote');
            const projectId = 'abc-123';
            const projectName = '@#$%^&*()';

            assert.throws(
                () => buildSnapshotPath({ projectUri, projectId, projectName, variant: 'latest' }),
                'Project name cannot be empty or contain only special characters'
            );
        });

        test('should throw error for project name with only whitespace', () => {
            const projectUri = Uri.file('/path/to/file.deepnote');
            const projectId = 'abc-123';
            const projectName = '   ';

            assert.throws(
                () => buildSnapshotPath({ projectUri, projectId, projectName, variant: 'latest' }),
                'Project name cannot be empty or contain only special characters'
            );
        });

        // performSnapshotSave catches this failure with `error instanceof InvalidProjectNameError` to
        // skip snapshots gracefully; a generic Error with the same message would defeat that catch, so
        // pin the TYPE (not just the message) at BOTH throw sites — the empty-name guard here...
        test('throws an InvalidProjectNameError instance (not a generic Error) for an empty name', () => {
            const projectUri = Uri.file('/path/to/file.deepnote');
            const projectId = 'abc-123';

            assert.throws(
                () => buildSnapshotPath({ projectUri, projectId, projectName: '', variant: 'latest' }),
                InvalidProjectNameError
            );
        });

        // ...and the slug-empties-to-nothing guard, which passes the trim check but fails slugification.
        test('throws an InvalidProjectNameError instance when the name slugifies to empty', () => {
            const projectUri = Uri.file('/path/to/file.deepnote');
            const projectId = 'abc-123';

            assert.throws(
                () => buildSnapshotPath({ projectUri, projectId, projectName: '@#$', variant: 'latest' }),
                InvalidProjectNameError
            );
        });

        // Complements the notebook-id-bearing shape above: with no notebookId the projectId must abut
        // the variant directly, with no notebook segment leaking between them.
        test('builds the legacy (no notebookId) filename shape with the projectId immediately before the variant', () => {
            const projectUri = Uri.file('/path/to/my-project.deepnote');
            const projectId = 'e132b172-b114-410e-8331-011517db664f';
            const projectName = 'My Project';

            const result = buildSnapshotPath({ projectUri, projectId, projectName, variant: 'latest' });

            assert.include(result.fsPath, `${projectId}_latest.snapshot.deepnote`);
        });
    });

    suite('mergeOutputsIntoBlocks', () => {
        test('should merge outputs into blocks by ID', () => {
            const blocks: DeepnoteBlock[] = [
                { id: 'block-1', type: 'code', sortingKey: 'a0', content: 'print(1)', blockGroup: '1', metadata: {} },
                { id: 'block-2', type: 'code', sortingKey: 'a1', content: 'print(2)', blockGroup: '1', metadata: {} },
                { id: 'block-3', type: 'markdown', sortingKey: 'a2', content: '# Hello', blockGroup: '1', metadata: {} }
            ];

            const outputs = new Map<string, DeepnoteOutput[]>();

            outputs.set('block-1', [{ output_type: 'stream', name: 'stdout', text: '1\n' }]);
            outputs.set('block-2', [{ output_type: 'stream', name: 'stdout', text: '2\n' }]);

            const result = service.mergeOutputsIntoBlocks(blocks, outputs);

            assert.deepStrictEqual((result[0] as ExecutableBlock).outputs, [
                { output_type: 'stream', name: 'stdout', text: '1\n' }
            ]);
            assert.deepStrictEqual((result[1] as ExecutableBlock).outputs, [
                { output_type: 'stream', name: 'stdout', text: '2\n' }
            ]);
            assert.isUndefined((result[2] as ExecutableBlock).outputs);
        });

        test('should not modify original blocks', () => {
            const blocks: DeepnoteBlock[] = [
                { id: 'block-1', type: 'code', sortingKey: 'a0', content: 'print(1)', blockGroup: '1', metadata: {} }
            ];

            const outputs = new Map<string, DeepnoteOutput[]>();

            outputs.set('block-1', [{ output_type: 'stream', text: 'new' }]);

            service.mergeOutputsIntoBlocks(blocks, outputs);

            assert.isUndefined((blocks[0] as ExecutableBlock).outputs);
        });

        test('should preserve blocks without matching outputs', () => {
            const blocks: DeepnoteBlock[] = [
                {
                    id: 'block-1',
                    type: 'code',
                    sortingKey: 'a0',
                    content: 'print(1)',
                    blockGroup: '1',
                    metadata: {},
                    outputs: [{ output_type: 'stream', text: 'old' }]
                }
            ];

            const outputs = new Map<string, DeepnoteOutput[]>();

            outputs.set('block-2', [{ output_type: 'stream', text: 'new' }]);

            const result = service.mergeOutputsIntoBlocks(blocks, outputs);

            assert.deepStrictEqual((result[0] as ExecutableBlock).outputs, [{ output_type: 'stream', text: 'old' }]);
        });

        test('should handle empty outputs map', () => {
            const blocks: DeepnoteBlock[] = [
                { id: 'block-1', type: 'code', sortingKey: 'a0', content: 'print(1)', blockGroup: '1', metadata: {} }
            ];

            const outputs = new Map<string, DeepnoteOutput[]>();

            const result = service.mergeOutputsIntoBlocks(blocks, outputs);

            assert.lengthOf(result, 1);
            assert.isUndefined((result[0] as ExecutableBlock).outputs);
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
                    blockGroup: '1',
                    metadata: {},
                    content: 'print(1)',
                    outputs: [{ output_type: 'stream', text: '1' }]
                },
                {
                    id: 'block-2',
                    type: 'code',
                    sortingKey: 'a1',
                    blockGroup: '1',
                    metadata: {},
                    content: 'print(2)',
                    outputs: [{ output_type: 'stream', text: '2' }]
                }
            ];

            const result = service.stripOutputsFromBlocks(blocks);

            assert.lengthOf(result, 2);
            assert.isUndefined((result[0] as ExecutableBlock).outputs);
            assert.isUndefined((result[1] as ExecutableBlock).outputs);
        });

        test('should preserve other block properties', () => {
            const blocks: DeepnoteBlock[] = [
                {
                    id: 'block-1',
                    type: 'code',
                    sortingKey: 'a0',
                    blockGroup: '1',
                    metadata: {},
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
            assert.isUndefined((result[0] as ExecutableBlock).outputs);
        });

        test('should strip execution timestamps from blocks', () => {
            const blocks: DeepnoteBlock[] = [
                {
                    id: 'block-1',
                    type: 'code',
                    sortingKey: 'a0',
                    blockGroup: '1',
                    metadata: {},
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
            assert.isUndefined((result[0] as ExecutableBlock).executionStartedAt);
            assert.isUndefined((result[0] as ExecutableBlock).executionFinishedAt);
            assert.isUndefined((result[0] as ExecutableBlock).outputs);
        });

        test('should strip executionCount from blocks', () => {
            const blocks: DeepnoteBlock[] = [
                {
                    id: 'block-1',
                    type: 'code',
                    sortingKey: 'a0',
                    blockGroup: '1',
                    metadata: {},
                    content: 'print(1)',
                    contentHash: 'sha256:abc123',
                    executionCount: 5,
                    outputs: [{ output_type: 'stream', text: '1' }]
                }
            ];

            const result = service.stripOutputsFromBlocks(blocks);

            assert.strictEqual(result[0].id, 'block-1');
            assert.strictEqual(result[0].contentHash, 'sha256:abc123');
            assert.isUndefined((result[0] as ExecutableBlock).executionCount);
            assert.isUndefined((result[0] as ExecutableBlock).outputs);
        });

        test('should not modify original blocks', () => {
            const blocks: DeepnoteBlock[] = [
                {
                    id: 'block-1',
                    type: 'code',
                    sortingKey: 'a0',
                    blockGroup: '1',
                    metadata: {},
                    content: 'print(1)',
                    outputs: [{ output_type: 'stream', text: '1' }]
                }
            ];

            service.stripOutputsFromBlocks(blocks);

            assert.isDefined((blocks[0] as ExecutableBlock).outputs);
        });

        test('should handle blocks without outputs', () => {
            const blocks: DeepnoteBlock[] = [
                { id: 'block-1', type: 'code', sortingKey: 'a0', blockGroup: '1', metadata: {}, content: 'print(1)' }
            ];

            const result = service.stripOutputsFromBlocks(blocks);

            assert.lengthOf(result, 1);
            assert.isUndefined((result[0] as ExecutableBlock).outputs);
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
                    blockGroup: '1',
                    metadata: {},
                    content: 'print(1)',
                    outputs: [{ output_type: 'stream', text: '1' }]
                },
                {
                    id: 'block-2',
                    type: 'code',
                    sortingKey: 'a1',
                    blockGroup: '1',
                    metadata: {},
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
                    blockGroup: '1',
                    metadata: {},
                    content: 'print(1)',
                    outputs: [{ output_type: 'stream', text: '1' }]
                },
                { id: 'block-2', type: 'code', sortingKey: 'a1', blockGroup: '1', metadata: {}, content: 'print(2)' }
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
                {
                    id: 'block-1',
                    type: 'code',
                    sortingKey: 'a0',
                    blockGroup: '1',
                    metadata: {},
                    content: 'df',
                    outputs: [complexOutput]
                }
            ];

            const result = service.extractOutputsFromBlocks(blocks);

            assert.deepStrictEqual(result.get('block-1'), [complexOutput]);
        });
    });

    suite('isSnapshotsEnabled', () => {
        test('should return true when snapshots.enabled is true', () => {
            const mockConfig = mock<WorkspaceConfiguration>();
            when(mockConfig.get<boolean>('snapshots.enabled', true)).thenReturn(true);
            when(mockedVSCodeNamespaces.workspace.getConfiguration('deepnote')).thenReturn(instance(mockConfig));

            const result = service.isSnapshotsEnabled();

            assert.isTrue(result);
        });

        test('should return false when snapshots.enabled is false', () => {
            const mockConfig = mock<WorkspaceConfiguration>();
            when(mockConfig.get<boolean>('snapshots.enabled', true)).thenReturn(false);
            when(mockedVSCodeNamespaces.workspace.getConfiguration('deepnote')).thenReturn(instance(mockConfig));

            const result = service.isSnapshotsEnabled();

            assert.isFalse(result);
        });
    });

    suite('readSnapshot', () => {
        const projectId = 'e132b172-b114-410e-8331-011517db664f';

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

            const snapshotUri = Uri.file(`/workspace/snapshots/project_${projectId}_latest.snapshot.deepnote`);
            when(mockedVSCodeNamespaces.workspace.findFiles(anything(), anything(), anything())).thenResolve([
                snapshotUri
            ] as any);

            const snapshotYaml = `
version: '1.0.0'
metadata:
  createdAt: '2025-01-01T00:00:00Z'
project:
  id: ${projectId}
  name: Test Project
  notebooks:
    - id: notebook-1
      name: Notebook 1
      blocks:
        - id: block-1
          blockGroup: group-1
          type: code
          sortingKey: 'a0'
          content: print(1)
          outputs:
            - output_type: stream
              name: stdout
              text: '1'
        - id: block-2
          blockGroup: group-2
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

            const timestampedUri1 = Uri.file(
                `/workspace/snapshots/project_${projectId}_2025-01-01T10-00-00.snapshot.deepnote`
            );
            const timestampedUri2 = Uri.file(
                `/workspace/snapshots/project_${projectId}_2025-01-02T10-00-00.snapshot.deepnote`
            );

            when(mockedVSCodeNamespaces.workspace.findFiles(anything(), anything(), anything())).thenResolve([
                timestampedUri1,
                timestampedUri2
            ] as any);

            const snapshotYaml = `
version: '1.0.0'
metadata:
  createdAt: '2025-01-02T00:00:00Z'
project:
  id: ${projectId}
  name: Test Project
  notebooks:
    - id: notebook-1
      name: Notebook 1
      blocks:
        - id: block-1
          blockGroup: group-1
          type: code
          sortingKey: 'a0'
          content: ''
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

        test('should return undefined when the only snapshot file read fails', async () => {
            const workspaceFolder: WorkspaceFolder = {
                uri: Uri.file('/workspace'),
                name: 'workspace',
                index: 0
            };
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder]);

            const snapshotUri = Uri.file(`/workspace/snapshots/project_${projectId}_latest.snapshot.deepnote`);
            when(mockedVSCodeNamespaces.workspace.findFiles(anything(), anything(), anything())).thenResolve([
                snapshotUri
            ] as any);

            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.readFile(anything())).thenReject(new Error('File read error'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            const result = await service.readSnapshot(projectId);

            // A corrupt/unreadable candidate is skipped during the safe-restore walk; with no other
            // candidate the lookup resolves to undefined (the open-time merge becomes a no-op).
            assert.isUndefined(result);
        });

        test('should return undefined when the only snapshot candidate has no outputs', async () => {
            const workspaceFolder: WorkspaceFolder = {
                uri: Uri.file('/workspace'),
                name: 'workspace',
                index: 0
            };
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder]);

            const snapshotUri = Uri.file(`/workspace/snapshots/project_${projectId}_latest.snapshot.deepnote`);
            when(mockedVSCodeNamespaces.workspace.findFiles(anything(), anything(), anything())).thenResolve([
                snapshotUri
            ] as any);

            // A `latest` snapshot whose blocks carry no real outputs signals a save race and is
            // skipped by the safe-restore walk.
            const emptyOutputsYaml = `
version: '1.0.0'
metadata:
  createdAt: '2025-01-01T00:00:00Z'
project:
  id: ${projectId}
  name: Test Project
  notebooks:
    - id: notebook-1
      name: Notebook 1
      blocks:
        - id: block-1
          blockGroup: group-1
          type: code
          sortingKey: 'a0'
          content: print(1)
          outputs: []
`;
            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.readFile(anything())).thenResolve(new TextEncoder().encode(emptyOutputsYaml) as any);
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            const result = await service.readSnapshot(projectId);

            assert.isUndefined(result);
        });
    });

    suite('readSnapshot backward-compatible ranking', () => {
        // UUIDs are required: convert's (faithfully mocked) parseSnapshotFilename only matches a
        // 36-char projectId AND a UUID-shaped notebook id, so non-UUID ids would never parse.
        const projectId = 'e132b172-b114-410e-8331-011517db664f';
        const notebookId = '11111111-2222-3333-4444-555555555555';
        const otherNotebookId = '99999999-8888-7777-6666-555555555555';

        const workspaceFolder: WorkspaceFolder = {
            uri: Uri.file('/workspace'),
            name: 'workspace',
            index: 0
        };

        /** A snapshot whose single block carries one stream output tagged with `marker`. */
        function snapshotYamlWithOutput(marker: string): string {
            return `
version: '1.0.0'
metadata:
  createdAt: '2025-01-01T00:00:00Z'
project:
  id: ${projectId}
  name: Test Project
  notebooks:
    - id: notebook-1
      name: Notebook 1
      blocks:
        - id: block-1
          blockGroup: group-1
          type: code
          sortingKey: 'a0'
          content: print(1)
          outputs:
            - output_type: stream
              name: stdout
              text: '${marker}'
`;
        }

        /**
         * Dispatches readFile bytes per-URI by fsPath: ts-mockito's single-arg matcher returns one value
         * for every call, so without this every candidate reads identical bytes and "which file won" is moot.
         */
        function stubSnapshotFiles(filesByUri: Array<{ uri: Uri; yaml: string }>): void {
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder]);
            when(mockedVSCodeNamespaces.workspace.findFiles(anything(), anything(), anything())).thenResolve(
                filesByUri.map((f) => f.uri) as any
            );

            const byPath = new Map(filesByUri.map((f) => [f.uri.fsPath, f.yaml]));
            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.readFile(anything())).thenCall((uri: Uri) => {
                const yaml = byPath.get(uri.fsPath);
                if (yaml === undefined) {
                    return Promise.reject(new Error(`Unexpected readFile for ${uri.fsPath}`));
                }

                return Promise.resolve(new TextEncoder().encode(yaml));
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            return;
        }

        function markerOf(result: Map<string, DeepnoteOutput[]> | undefined): string | undefined {
            const outputs = result?.get('block-1');
            const first = outputs?.[0] as { text?: string } | undefined;

            return first?.text;
        }

        test('still loads a legacy project-scoped snapshot when a notebookId is requested but only the legacy file exists (catches dropping the legacy fallback)', async () => {
            const legacyUri = Uri.file(`/workspace/snapshots/test-project_${projectId}_latest.snapshot.deepnote`);
            stubSnapshotFiles([{ uri: legacyUri, yaml: snapshotYamlWithOutput('from-legacy') }]);

            const result = await service.readSnapshot(projectId, notebookId);

            assert.strictEqual(markerOf(result), 'from-legacy');
        });

        test('prefers the notebook-scoped snapshot over a legacy one for the requested notebookId (catches ranking legacy ahead of the notebook-scoped match)', async () => {
            const scopedUri = Uri.file(
                `/workspace/snapshots/test-project_${projectId}_${notebookId}_latest.snapshot.deepnote`
            );
            const legacyUri = Uri.file(`/workspace/snapshots/test-project_${projectId}_latest.snapshot.deepnote`);

            stubSnapshotFiles([
                { uri: legacyUri, yaml: snapshotYamlWithOutput('from-legacy') },
                { uri: scopedUri, yaml: snapshotYamlWithOutput('from-scoped') }
            ]);

            const result = await service.readSnapshot(projectId, notebookId);

            assert.strictEqual(markerOf(result), 'from-scoped');
        });

        test('ignores a different notebook scoped snapshot and falls back to the legacy one (catches reading another notebook outputs into this notebook)', async () => {
            const otherScopedUri = Uri.file(
                `/workspace/snapshots/test-project_${projectId}_${otherNotebookId}_latest.snapshot.deepnote`
            );
            const legacyUri = Uri.file(`/workspace/snapshots/test-project_${projectId}_latest.snapshot.deepnote`);

            stubSnapshotFiles([
                { uri: otherScopedUri, yaml: snapshotYamlWithOutput('from-other-notebook') },
                { uri: legacyUri, yaml: snapshotYamlWithOutput('from-legacy') }
            ]);

            const result = await service.readSnapshot(projectId, notebookId);

            assert.strictEqual(markerOf(result), 'from-legacy');
        });

        test('never deletes or renames the legacy snapshot file while reading it (catches a destructive migration on open)', async () => {
            const legacyUri = Uri.file(`/workspace/snapshots/test-project_${projectId}_latest.snapshot.deepnote`);

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder]);
            when(mockedVSCodeNamespaces.workspace.findFiles(anything(), anything(), anything())).thenResolve([
                legacyUri
            ] as any);

            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.readFile(anything())).thenResolve(
                new TextEncoder().encode(snapshotYamlWithOutput('from-legacy')) as any
            );
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            const result = await service.readSnapshot(projectId, notebookId);

            // The read must succeed AND leave the file untouched: no delete/rename/write of the legacy.
            assert.strictEqual(markerOf(result), 'from-legacy');
            verify(mockFs.delete(anything())).never();
            verify(mockFs.delete(anything(), anything())).never();
            verify(mockFs.rename(anything(), anything())).never();
            verify(mockFs.rename(anything(), anything(), anything())).never();
            verify(mockFs.writeFile(anything(), anything())).never();
        });
    });

    suite('readSnapshot safe restore', () => {
        const projectId = 'e132b172-b114-410e-8331-011517db664f';

        const workspaceFolder: WorkspaceFolder = {
            uri: Uri.file('/workspace'),
            name: 'workspace',
            index: 0
        };

        function snapshotYaml(blockContent: string, outputsYaml: string): string {
            return `
version: '1.0.0'
metadata:
  createdAt: '2025-01-01T00:00:00Z'
project:
  id: ${projectId}
  name: Test Project
  notebooks:
    - id: notebook-1
      name: Notebook 1
      blocks:
        - id: block-1
          blockGroup: group-1
          type: code
          sortingKey: 'a0'
          content: ${blockContent}
          outputs:${outputsYaml}
`;
        }

        function stubFiles(filesByUri: Array<{ uri: Uri; yaml: string }>): void {
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder]);
            when(mockedVSCodeNamespaces.workspace.findFiles(anything(), anything(), anything())).thenResolve(
                filesByUri.map((f) => f.uri) as any
            );

            const byPath = new Map(filesByUri.map((f) => [f.uri.fsPath, f.yaml]));
            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.readFile(anything())).thenCall((uri: Uri) => {
                const yaml = byPath.get(uri.fsPath);
                if (yaml === undefined) {
                    return Promise.reject(new Error(`Unexpected readFile for ${uri.fsPath}`));
                }

                return Promise.resolve(new TextEncoder().encode(yaml));
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            return;
        }

        test('skips an empty-output latest and falls through to a timestamped candidate that has outputs (catches restoring a save-race empty latest)', async () => {
            const latestUri = Uri.file(`/workspace/snapshots/test-project_${projectId}_latest.snapshot.deepnote`);
            const timestampedUri = Uri.file(
                `/workspace/snapshots/test-project_${projectId}_2025-01-02T10-00-00.snapshot.deepnote`
            );

            stubFiles([
                // `latest` ranks first but has empty outputs (a save race) and must be skipped.
                { uri: latestUri, yaml: snapshotYaml('print(1)', ' []') },
                // The timestamped candidate has real outputs and must be the one returned.
                {
                    uri: timestampedUri,
                    yaml: snapshotYaml(
                        'print(1)',
                        `\n            - output_type: stream\n              name: stdout\n              text: 'from-timestamped'`
                    )
                }
            ]);

            const result = await service.readSnapshot(projectId);

            const first = result?.get('block-1')?.[0] as { text?: string } | undefined;
            assert.strictEqual(first?.text, 'from-timestamped');
        });
    });

    suite('deferred snapshot save timing', () => {
        const notebookUri = activatedServiceNotebookUri;
        let clock: fakeTimers.InstalledClock;
        let changeEmitter: EventEmitter<NotebookDocumentChangeEvent>;
        let closeEmitter: EventEmitter<NotebookDocument>;
        let flush: sinon.SinonStub;

        setup(() => {
            // install() patches Date.now AND setTimeout/clearTimeout, both of which armSnapshotSave
            // relies on (armedAt = Date.now(); the quiet/max-wait delays are real setTimeout calls).
            clock = fakeTimers.install();

            const built = buildActivatedSnapshotService();
            changeEmitter = built.changeEmitter;
            closeEmitter = built.closeEmitter;

            // Observe the flush at the public createSnapshot seam: the fixture's executed code cell
            // routes the deferred save down the Run-All branch, so a flush means createSnapshot ran.
            flush = sinon.stub(built.service, 'createSnapshot').resolves(undefined);
        });

        teardown(() => {
            clock.uninstall();
            flush.restore();
        });

        /** Fires the real queue-completion event and lets onExecutionComplete arm the deferred save. */
        async function arm(): Promise<void> {
            notebookCellExecutions.notifyQueueComplete(notebookUri);
            await clock.tickAsync(0);
        }

        /** Drives the same "output/metadata changed" event the service listens to while a save is pending. */
        function fireOutputChange(): void {
            const notebook = mock<NotebookDocument>();
            when(notebook.uri).thenReturn(Uri.parse(notebookUri));

            const event = mock<NotebookDocumentChangeEvent>();
            when(event.notebook).thenReturn(instance(notebook));
            when(event.cellChanges).thenReturn([{ outputs: [] } as unknown as NotebookDocumentCellChange]);

            changeEmitter.fire(instance(event));
        }

        test('does NOT save immediately when execution completes — only after the quiet period elapses (catches writing a snapshot before outputs settle)', async () => {
            await arm();

            // Just before the quiet window closes: nothing flushed yet.
            await clock.tickAsync(149);
            assert.isFalse(flush.called, 'save must not flush before the quiet period elapses');

            // Crossing the quiet window with no further changes flushes exactly once.
            await clock.tickAsync(1);
            assert.isTrue(flush.calledOnce, 'save must flush once the quiet period elapses');
        });

        test('re-arms (delays) the save when an output change arrives within the quiet window (catches flushing mid-output-stream)', async () => {
            await arm();

            await clock.tickAsync(100);
            assert.isFalse(flush.called);

            // An output change at t=100 resets the 150ms quiet window.
            fireOutputChange();

            // t=200: would have fired under the original arm (100+? ) but the re-arm pushed it out.
            await clock.tickAsync(100);
            assert.isFalse(flush.called, 'an in-window change must re-arm and delay the save');

            // t=250: 150ms after the re-arm — now it flushes.
            await clock.tickAsync(50);
            assert.isTrue(flush.calledOnce, 'save flushes one quiet period after the last change');
        });

        test('forces a flush at the max-wait bound even under continuous output changes (catches an unbounded deferral starving the save)', async () => {
            await arm();

            // Hammer an output change every 100ms; each one would reset the 150ms quiet window, but the
            // 2000ms max-wait measured from the first arm must force a flush regardless.
            for (let elapsed = 0; elapsed < 2000; elapsed += 100) {
                await clock.tickAsync(100);
                fireOutputChange();
            }

            // By t=2000 the max-wait bound has forced exactly one flush despite the continuous churn.
            assert.isTrue(flush.called, 'max-wait must force a flush under continuous changes');
        });

        test('cancels a pending save when a cell re-enters the executing state (catches writing a stale snapshot mid re-execution)', async () => {
            await arm();

            await clock.tickAsync(100);

            // Drive the real cell-state event: an Executing transition must cancel the armed save
            // (otherwise a snapshot from the *previous* run would be written during the new run).
            const cellNotebook = mock<NotebookDocument>();
            when(cellNotebook.uri).thenReturn(Uri.parse(notebookUri));

            const cell = mock<NotebookCell>();
            when(cell.notebook).thenReturn(instance(cellNotebook));
            when(cell.metadata).thenReturn({ id: 'cell-1' });

            notebookCellExecutions.changeCellState(instance(cell), NotebookCellExecutionState.Executing);

            await clock.tickAsync(1000);
            assert.isFalse(flush.called, 're-execution must cancel the pending deferred save');
        });

        test('cancels a pending save when the notebook is closed (catches a flush firing after the document is gone)', async () => {
            await arm();

            await clock.tickAsync(100);

            // The close handler registered in activate() cancels the pending save; once cancelled the
            // timer must never flush even after the full quiet/max-wait window.
            const closedDoc = mock<NotebookDocument>();
            when(closedDoc.uri).thenReturn(Uri.parse(notebookUri));

            closeEmitter.fire(instance(closedDoc));

            await clock.tickAsync(2000);
            assert.isFalse(flush.called, 'closing the notebook must cancel the pending deferred save');
        });

        test('does NOT arm a deferred save when an output change arrives with no save pending (guards the pending-save precondition)', async () => {
            // No prior queue completion: pendingSnapshotSaves is empty, so handleNotebookDocumentChange
            // must ignore even an output-bearing change rather than arming a fresh deferred save.
            fireOutputChange();

            // Well past the max-wait bound: had the change armed a save, it would have flushed by now.
            await clock.tickAsync(3000);
            assert.isFalse(flush.called, 'an output change with no pending save must not arm a deferred save');
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
            when(mockFs.stat(anything())).thenReturn(
                Promise.resolve({ type: FileType.Directory, ctime: 0, mtime: 0, size: 0 })
            );
            // Return same content as existing
            const existingYaml = `
metadata:
  createdAt: '2025-01-01T00:00:00Z'
version: '1.0.0'
project:
  id: test-project-id-123
  name: My Project
  notebooks:
    - id: notebook-1
      name: Notebook 1
      blocks:
        - id: block-1
          blockGroup: '1'
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
            when(mockFs.stat(anything())).thenReturn(
                Promise.resolve({ type: FileType.Directory, ctime: 0, mtime: 0, size: 0 })
            );
            when(mockFs.readFile(anything())).thenReject(new Error('ENOENT'));
            when(mockFs.writeFile(anything(), anything())).thenReject(new Error('Write failed'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            const result = await service.createSnapshot(projectUri, projectId, projectName, projectData);

            assert.isUndefined(result);
        });

        test('should return timestamped path even if latest write fails', async () => {
            const projectData = createProjectData();

            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.stat(anything())).thenReturn(
                Promise.resolve({ type: FileType.Directory, ctime: 0, mtime: 0, size: 0 })
            );
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

    // Metadata tracking tests drive the injected tracker directly and observe it through public getters.
    suite('execution metadata tracking', () => {
        const notebookUri = 'file:///path/to/notebook.deepnote';
        const cellId = 'cell-123';

        suite('recordCellExecutionStart (private)', () => {
            test('should record cell execution start time', () => {
                const startTime = Date.now();

                tracker.recordCellExecutionStart(notebookUri, cellId, startTime);

                const metadata = service.getBlockExecutionMetadata(notebookUri, cellId);
                assert.isDefined(metadata);
                assert.isDefined(metadata!.executionStartedAt);
                assert.isUndefined(metadata!.executionFinishedAt);
            });

            test('should initialize notebook execution state', () => {
                const startTime = Date.now();

                tracker.recordCellExecutionStart(notebookUri, cellId, startTime);

                const executionMetadata = service.getExecutionMetadata(notebookUri);
                // Should not have execution metadata yet since no cells have completed
                assert.isUndefined(executionMetadata);
            });

            test('should handle multiple cells in same notebook', () => {
                const startTime = Date.now();

                tracker.recordCellExecutionStart(notebookUri, 'cell-1', startTime);
                tracker.recordCellExecutionStart(notebookUri, 'cell-2', startTime + 1000);

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

                tracker.recordCellExecutionStart(notebookUri, cellId, startTime);
                tracker.recordCellExecutionEnd(notebookUri, cellId, endTime, true);

                const metadata = service.getBlockExecutionMetadata(notebookUri, cellId);
                assert.isDefined(metadata);
                assert.isDefined(metadata!.executionStartedAt);
                assert.isDefined(metadata!.executionFinishedAt);
            });

            test('should update execution summary on success', () => {
                const startTime = Date.now();
                const endTime = startTime + 1000;

                tracker.recordCellExecutionStart(notebookUri, cellId, startTime);
                tracker.recordCellExecutionEnd(notebookUri, cellId, endTime, true);

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

                tracker.recordCellExecutionStart(notebookUri, cellId, startTime);
                tracker.recordCellExecutionEnd(notebookUri, cellId, endTime, false);

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

                tracker.recordCellExecutionStart(notebookUri, cellId, startTime);
                tracker.recordCellExecutionEnd(notebookUri, cellId, endTime, false, error);

                const executionMetadata = service.getExecutionMetadata(notebookUri);
                assert.isDefined(executionMetadata);
                assert.isDefined(executionMetadata!.error);
                assert.strictEqual(executionMetadata!.error!.name, 'TypeError');
                assert.strictEqual(executionMetadata!.error!.message, 'undefined is not a function');
            });

            test('should accumulate multiple cell executions', () => {
                const startTime = Date.now();

                // Execute 3 cells: 2 successful, 1 failed
                tracker.recordCellExecutionStart(notebookUri, 'cell-1', startTime);
                tracker.recordCellExecutionEnd(notebookUri, 'cell-1', startTime + 100, true);

                tracker.recordCellExecutionStart(notebookUri, 'cell-2', startTime + 200);
                tracker.recordCellExecutionEnd(notebookUri, 'cell-2', startTime + 300, true);

                tracker.recordCellExecutionStart(notebookUri, 'cell-3', startTime + 400);
                tracker.recordCellExecutionEnd(notebookUri, 'cell-3', startTime + 500, false);

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

                tracker.recordCellExecutionStart(notebookUri, cellId, startTime);
                tracker.recordCellExecutionEnd(notebookUri, cellId, endTime, true);

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
                tracker.recordCellExecutionStart(notebookUri, cellId, startTime);

                const metadata = service.getExecutionMetadata(notebookUri);
                assert.isUndefined(metadata);
            });

            test('should include ISO timestamps', () => {
                const startTime = Date.now();
                tracker.recordCellExecutionStart(notebookUri, cellId, startTime);
                tracker.recordCellExecutionEnd(notebookUri, cellId, startTime + 1000, true);

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
                tracker.recordCellExecutionStart(notebookUri, cellId, startTime);

                const metadata = service.getBlockExecutionMetadata(notebookUri, 'unknown-cell');
                assert.isUndefined(metadata);
            });
        });

        suite('clearExecutionState', () => {
            test('should clear all state for a notebook', () => {
                const startTime = Date.now();
                tracker.recordCellExecutionStart(notebookUri, cellId, startTime);
                tracker.recordCellExecutionEnd(notebookUri, cellId, startTime + 1000, true);

                service.clearExecutionState(notebookUri);

                const executionMetadata = service.getExecutionMetadata(notebookUri);
                const blockMetadata = service.getBlockExecutionMetadata(notebookUri, cellId);

                assert.isUndefined(executionMetadata);
                assert.isUndefined(blockMetadata);
            });

            test('should only clear state for specified notebook', () => {
                const startTime = Date.now();
                const otherNotebookUri = 'file:///other/notebook.deepnote';

                tracker.recordCellExecutionStart(notebookUri, cellId, startTime);
                tracker.recordCellExecutionEnd(notebookUri, cellId, startTime + 1000, true);

                tracker.recordCellExecutionStart(otherNotebookUri, 'other-cell', startTime);
                tracker.recordCellExecutionEnd(otherNotebookUri, 'other-cell', startTime + 1000, true);

                service.clearExecutionState(notebookUri);

                // First notebook should be cleared
                assert.isUndefined(service.getExecutionMetadata(notebookUri));

                // Second notebook should still have state
                assert.isDefined(service.getExecutionMetadata(otherNotebookUri));
            });

            // Execution state is split across two owners — the tracker (cell metadata) and the service's
            // own environment map. Clearing must wipe BOTH; a half-clear would leak a stale environment
            // from the previous session into the next snapshot.
            test('clears the captured environment as well as the tracker metadata', async () => {
                const notebook = mock<NotebookDocument>();
                when(notebook.uri).thenReturn(Uri.parse(notebookUri));
                when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([instance(notebook)]);

                const capturedEnvironment: Environment = {
                    hash: 'sha256:abc',
                    packages: {},
                    platform: 'linux-x64',
                    python: { environment: 'venv', version: '3.12.0' }
                };
                when(mockEnvironmentCapture.captureEnvironment(anything())).thenResolve(capturedEnvironment);

                // Populate both sides: capture the environment and record a completed cell.
                await service.captureEnvironmentBeforeExecution(notebookUri);
                const startTime = Date.now();
                tracker.recordCellExecutionStart(notebookUri, cellId, startTime);
                tracker.recordCellExecutionEnd(notebookUri, cellId, startTime + 100, true);

                assert.isDefined(service.getExecutionMetadata(notebookUri));
                assert.deepStrictEqual(await service.getEnvironmentMetadata(notebookUri), capturedEnvironment);

                service.clearExecutionState(notebookUri);

                assert.isUndefined(service.getExecutionMetadata(notebookUri));
                assert.isUndefined(service.getBlockExecutionMetadata(notebookUri, cellId));
                // The environment side must be gone too — not a stale hit from the pre-clear capture.
                assert.isUndefined(await service.getEnvironmentMetadata(notebookUri));
            });
        });

        suite('default tracker (no injected tracker)', () => {
            test('records and reads metadata through an internally-created tracker', () => {
                // Construct WITHOUT the optional tracker: the constructor must default one, otherwise
                // every this.tracker.* call below would dereference undefined.
                const defaultService = new SnapshotService(instance(mockEnvironmentCapture), mockDisposables);
                installNotebookDocumentEmitters();
                defaultService.activate();

                const cellNotebook = mock<NotebookDocument>();
                when(cellNotebook.uri).thenReturn(Uri.parse(notebookUri));

                const cell = mock<NotebookCell>();
                when(cell.notebook).thenReturn(instance(cellNotebook));
                when(cell.metadata).thenReturn({ id: cellId });
                when(cell.executionSummary).thenReturn({ success: true });

                // Drive a full start->end cycle through the real cell-state events activate() subscribes to.
                notebookCellExecutions.changeCellState(instance(cell), NotebookCellExecutionState.Executing);
                notebookCellExecutions.changeCellState(instance(cell), NotebookCellExecutionState.Idle);

                const metadata = defaultService.getExecutionMetadata(notebookUri);
                assert.isDefined(metadata);
                assert.strictEqual(metadata!.summary!.blocksExecuted, 1);
                assert.strictEqual(metadata!.summary!.blocksSucceeded, 1);
                assert.isDefined(defaultService.getBlockExecutionMetadata(notebookUri, cellId));
            });
        });

        suite('multiple notebooks', () => {
            test('should track state independently for different notebooks', () => {
                const notebook1 = 'file:///notebook1.deepnote';
                const notebook2 = 'file:///notebook2.deepnote';
                const startTime = Date.now();

                // Execute cells in different notebooks
                tracker.recordCellExecutionStart(notebook1, 'cell-1', startTime);
                tracker.recordCellExecutionEnd(notebook1, 'cell-1', startTime + 100, true);

                tracker.recordCellExecutionStart(notebook2, 'cell-2', startTime);
                tracker.recordCellExecutionEnd(notebook2, 'cell-2', startTime + 200, false);

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
            let clock: fakeTimers.InstalledClock;

            setup(() => {
                clock = fakeTimers.install();
                installNotebookDocumentEmitters();
            });

            teardown(() => {
                clock.uninstall();
            });

            /** Records writeFile URIs so a save's write shape (timestamped vs latest) is observable. */
            function captureSnapshotWrites(): Uri[] {
                const writtenUris: Uri[] = [];
                const mockFs = mock<typeof import('vscode').workspace.fs>();

                when(mockFs.stat(anything())).thenReturn(
                    Promise.resolve({ type: FileType.Directory, ctime: 0, mtime: 0, size: 0 })
                );
                when(mockFs.readFile(anything())).thenReject(new Error('ENOENT'));
                when(mockFs.writeFile(anything(), anything())).thenCall((uri: Uri) => {
                    writtenUris.push(uri);

                    return Promise.resolve();
                });
                when(mockFs.copy(anything(), anything(), anything())).thenResolve();
                when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

                return writtenUris;
            }

            /** Fires queue completion and advances past the quiet window so the deferred save flushes. */
            async function flushDeferredSave(uri: string): Promise<void> {
                notebookCellExecutions.notifyQueueComplete(uri);
                await clock.tickAsync(0);
                await clock.tickAsync(150);
            }

            // Run-All writes a timestamped snapshot (…_<stamp>.snapshot.deepnote) then copies it to the
            // latest pointer; a partial run writes only …_latest.snapshot.deepnote. The written-URI shape
            // alone distinguishes the two branches.
            function wroteTimestampedSnapshot(uris: Uri[]): boolean {
                return uris.some((u) => u.path.endsWith('.snapshot.deepnote') && !u.path.includes('_latest'));
            }

            function wroteLatestSnapshot(uris: Uri[]): boolean {
                return uris.some((u) => u.path.includes('_latest.snapshot.deepnote'));
            }

            test('should detect Run All when all code cells are executed', async () => {
                // Set up mocks
                const mockConfig = mock<WorkspaceConfiguration>();
                when(mockConfig.get<boolean>('snapshots.enabled', true)).thenReturn(true);
                when(mockedVSCodeNamespaces.workspace.getConfiguration('deepnote')).thenReturn(instance(mockConfig));

                const projectId = 'test-project-id';
                const notebookId = 'test-notebook-id';

                // Create mock cells - 3 code cells and 1 markdown
                const mockNotebook = mockNotebookDoc({
                    uri: Uri.parse(notebookUri),
                    projectId,
                    notebookId,
                    cells: [
                        mockCell({ id: 'cell-1', source: 'print(1)' }),
                        mockCell({ id: 'cell-2', source: 'print(2)' }),
                        mockCell({
                            id: 'cell-md',
                            kind: NotebookCellKind.Markup,
                            languageId: 'markdown',
                            source: '# Title'
                        }),
                        mockCell({ id: 'cell-3', source: 'print(3)' })
                    ]
                });

                when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([mockNotebook]);

                // Create mock notebook manager with original project
                const originalProject: DeepnoteFile = {
                    metadata: { createdAt: '2025-01-01T00:00:00Z' },
                    version: '1.0.0',
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

                const mockNotebookManager = mock<IDeepnoteNotebookManager>();
                when(mockNotebookManager.getProjectForNotebook(anything(), anything())).thenReturn(originalProject);

                // Create a new service with the mock notebook manager
                const testService = new SnapshotService(
                    instance(mockEnvironmentCapture),
                    mockDisposables,
                    instance(mockNotebookManager),
                    tracker
                );

                // Record execution for all 3 code cells
                const startTime = Date.now();
                tracker.recordCellExecutionStart(notebookUri, 'cell-1', startTime);
                tracker.recordCellExecutionEnd(notebookUri, 'cell-1', startTime + 100, true);
                tracker.recordCellExecutionStart(notebookUri, 'cell-2', startTime + 200);
                tracker.recordCellExecutionEnd(notebookUri, 'cell-2', startTime + 300, true);
                tracker.recordCellExecutionStart(notebookUri, 'cell-3', startTime + 400);
                tracker.recordCellExecutionEnd(notebookUri, 'cell-3', startTime + 500, true);

                const writtenUris = captureSnapshotWrites();

                // onExecutionComplete arms a deferred (output-settled) save; drive it through the real
                // queue-completion event and the settle window to assert the Run-All-vs-partial routing.
                testService.activate();
                await flushDeferredSave(notebookUri);

                // Run-All writes a timestamped snapshot (and copies to latest), never a latest-only write.
                assert.isTrue(
                    wroteTimestampedSnapshot(writtenUris),
                    'a timestamped snapshot should be written when all code cells are executed'
                );
                assert.isFalse(
                    wroteLatestSnapshot(writtenUris),
                    'a latest-only snapshot must NOT be written when all code cells are executed'
                );
                assert.strictEqual(
                    writtenUris.length,
                    1,
                    'exactly one snapshot write — the deferred save must not double-flush'
                );
            });

            test('writes the snapshot next to the saved notebook, not a sibling that shares the project id', async () => {
                const mockConfig = mock<WorkspaceConfiguration>();
                when(mockConfig.get<boolean>('snapshots.enabled', true)).thenReturn(true);
                when(mockedVSCodeNamespaces.workspace.getConfiguration('deepnote')).thenReturn(instance(mockConfig));

                const sharedProjectId = 'shared-project-id';
                // Two single-notebook siblings share a project.id but live in DIFFERENT folders.
                const siblingAUri = 'file:///workspace/foo/a.deepnote';
                const targetBUri = 'file:///workspace/bar/b.deepnote';

                const siblingA = mockNotebookDoc({
                    uri: Uri.parse(siblingAUri),
                    projectId: sharedProjectId,
                    notebookId: 'notebook-a',
                    cells: [mockCell({ id: 'cell-a' })]
                });
                const notebookB = mockNotebookDoc({
                    uri: Uri.parse(targetBUri),
                    projectId: sharedProjectId,
                    notebookId: 'notebook-b',
                    cells: [mockCell({ id: 'cell-b' })]
                });

                // Sibling A is enumerated FIRST — a projectId-only lookup would pick A's folder.
                when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([siblingA, notebookB]);

                const originalProject: DeepnoteFile = {
                    metadata: { createdAt: '2025-01-01T00:00:00Z' },
                    version: '1.0.0',
                    project: {
                        id: sharedProjectId,
                        name: 'Test Project',
                        notebooks: [{ id: 'notebook-b', name: 'Notebook B', blocks: [] }]
                    }
                };
                const mockNotebookManager = mock<IDeepnoteNotebookManager>();
                when(mockNotebookManager.getProjectForNotebook(anything(), anything())).thenReturn(originalProject);

                const testService = new SnapshotService(
                    instance(mockEnvironmentCapture),
                    mockDisposables,
                    instance(mockNotebookManager),
                    tracker
                );

                const startTime = Date.now();
                tracker.recordCellExecutionStart(targetBUri, 'cell-b', startTime);
                tracker.recordCellExecutionEnd(targetBUri, 'cell-b', startTime + 100, true);

                const writtenUris = captureSnapshotWrites();

                testService.activate();
                await flushDeferredSave(targetBUri);

                // The snapshot dir derives from projectUri's parent, so the snapshot must land in notebook B's
                // OWN folder (/bar/snapshots), not sibling A's (/foo) — even though A shares the id and enumerates first.
                assert.isAtLeast(writtenUris.length, 1, 'a snapshot file must be written');
                assert.include(
                    writtenUris[0].path,
                    '/workspace/bar/snapshots/',
                    'snapshot must be written under the saved notebook own directory, not a sibling sharing the project id'
                );
                assert.notInclude(
                    writtenUris[0].path,
                    '/workspace/foo/',
                    'snapshot must not land in a sibling directory that merely shares the project id'
                );
            });

            // getExecutedBlockCount returns undefined (not 0) for a notebook the tracker never saw. The
            // Run-All predicate must treat undefined as "not Run-All"; collapsing it to 0 would make a
            // zero-code-cell notebook (0 === 0) falsely take the full-snapshot path.
            test('treats an untracked notebook as a partial run, never Run-All', async () => {
                const mockConfig = mock<WorkspaceConfiguration>();
                when(mockConfig.get<boolean>('snapshots.enabled', true)).thenReturn(true);
                when(mockedVSCodeNamespaces.workspace.getConfiguration('deepnote')).thenReturn(instance(mockConfig));

                const projectId = 'test-project-id';
                const notebookId = 'test-notebook-id';

                // A markdown-only notebook (zero code cells) whose URI was never recorded in the tracker.
                const mockNotebook = mockNotebookDoc({
                    uri: Uri.parse(notebookUri),
                    projectId,
                    notebookId,
                    cells: [
                        mockCell({
                            id: 'cell-md',
                            kind: NotebookCellKind.Markup,
                            languageId: 'markdown',
                            source: '# Title'
                        })
                    ]
                });
                when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([mockNotebook]);

                const originalProject: DeepnoteFile = {
                    metadata: { createdAt: '2025-01-01T00:00:00Z' },
                    version: '1.0.0',
                    project: {
                        id: projectId,
                        name: 'Test Project',
                        notebooks: [{ id: notebookId, name: 'Test Notebook', blocks: [] }]
                    }
                };
                const mockNotebookManager = mock<IDeepnoteNotebookManager>();
                when(mockNotebookManager.getProjectForNotebook(anything(), anything())).thenReturn(originalProject);

                const testService = new SnapshotService(
                    instance(mockEnvironmentCapture),
                    mockDisposables,
                    instance(mockNotebookManager),
                    tracker
                );

                const writtenUris = captureSnapshotWrites();

                testService.activate();
                await flushDeferredSave(notebookUri);

                assert.isFalse(
                    wroteTimestampedSnapshot(writtenUris),
                    'an untracked notebook must not take the Run-All (timestamped) path'
                );
                assert.isTrue(
                    wroteLatestSnapshot(writtenUris),
                    'an untracked notebook must take the partial-run (latest-only) path'
                );
            });
        });

        suite('captureEnvironmentBeforeExecution', () => {
            test('should not throw for valid notebook URI', async () => {
                await service.captureEnvironmentBeforeExecution(notebookUri);
                // Should complete without error
            });

            test('seeds startedAt at capture time, not the first recorded cell start', async () => {
                const captureBefore = Date.now();
                await service.captureEnvironmentBeforeExecution(notebookUri);
                const captureAfter = Date.now();

                // A cell that starts long after capture must not move the session start.
                const laterCellStart = captureAfter + 60_000;
                tracker.recordCellExecutionStart(notebookUri, 'cell-1', laterCellStart);
                tracker.recordCellExecutionEnd(notebookUri, 'cell-1', laterCellStart + 100, true);

                const metadata = service.getExecutionMetadata(notebookUri);
                assert.isDefined(metadata);

                const startedAtMs = new Date(metadata!.startedAt!).getTime();
                assert.isAtLeast(startedAtMs, captureBefore);
                assert.isAtMost(startedAtMs, captureAfter);
                assert.notStrictEqual(startedAtMs, laterCellStart);
            });

            test('a second capture does not reset the session startedAt (ensureExecutionState is idempotent)', async () => {
                await service.captureEnvironmentBeforeExecution(notebookUri);

                // Record a completed cell so the seeded startedAt becomes observable via the summary.
                const firstStart = Date.now();
                tracker.recordCellExecutionStart(notebookUri, cellId, firstStart);
                tracker.recordCellExecutionEnd(notebookUri, cellId, firstStart + 100, true);

                const seededStartedAt = service.getExecutionMetadata(notebookUri)!.startedAt;

                // A second capture (e.g. a re-run before the state is cleared) must not re-seed the
                // session; ensureExecutionState is a no-op once state exists.
                await service.captureEnvironmentBeforeExecution(notebookUri);

                assert.strictEqual(service.getExecutionMetadata(notebookUri)!.startedAt, seededStartedAt);
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
