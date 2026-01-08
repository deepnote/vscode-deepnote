import { assert } from 'chai';
import { Uri } from 'vscode';

import type { DeepnoteBlock } from '@deepnote/blocks';

import { SnapshotFileService } from './snapshotFileService.node';
import type { DeepnoteOutput } from '../../platform/deepnote/deepnoteTypes';

suite('SnapshotFileService', () => {
    let service: SnapshotFileService;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let serviceAny: any;

    setup(() => {
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
});
