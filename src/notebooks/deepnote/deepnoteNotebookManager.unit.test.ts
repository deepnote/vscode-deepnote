import * as assert from 'assert';

import { DeepnoteNotebookManager } from './deepnoteNotebookManager';
import type { DeepnoteProject } from './deepnoteTypes';

suite('DeepnoteNotebookManager', () => {
    let manager: DeepnoteNotebookManager;

    const mockProject: DeepnoteProject = {
        metadata: {
            createdAt: '2023-01-01T00:00:00Z',
            modifiedAt: '2023-01-02T00:00:00Z'
        },
        project: {
            id: 'project-123',
            name: 'Test Project',
            notebooks: [],
            settings: {}
        },
        version: '1.0'
    };

    setup(() => {
        manager = new DeepnoteNotebookManager();
    });

    suite('getCurrentNotebookId', () => {
        test('should return undefined for unknown project', () => {
            const result = manager.getCurrentNotebookId('unknown-project');

            assert.strictEqual(result, undefined);
        });

        test('should return notebook ID after storing project', () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-456');

            const result = manager.getCurrentNotebookId('project-123');

            assert.strictEqual(result, 'notebook-456');
        });

        test('should return updated notebook ID', () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-456');
            manager.updateCurrentNotebookId('project-123', 'notebook-789');

            const result = manager.getCurrentNotebookId('project-123');

            assert.strictEqual(result, 'notebook-789');
        });
    });

    suite('getOriginalProject', () => {
        test('should return undefined for unknown project', () => {
            const result = manager.getOriginalProject('unknown-project');

            assert.strictEqual(result, undefined);
        });

        test('should return original project after storing', () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-456');

            const result = manager.getOriginalProject('project-123');

            assert.deepStrictEqual(result, mockProject);
        });
    });

    suite('getTheSelectedNotebookForAProject', () => {
        test('should return undefined for unknown project', () => {
            const result = manager.getTheSelectedNotebookForAProject('unknown-project');

            assert.strictEqual(result, undefined);
        });

        test('should return notebook ID after setting', () => {
            manager.selectNotebookForProject('project-123', 'notebook-456');

            const result = manager.getTheSelectedNotebookForAProject('project-123');

            assert.strictEqual(result, 'notebook-456');
        });

        test('should handle multiple projects independently', () => {
            manager.selectNotebookForProject('project-1', 'notebook-1');
            manager.selectNotebookForProject('project-2', 'notebook-2');

            const result1 = manager.getTheSelectedNotebookForAProject('project-1');
            const result2 = manager.getTheSelectedNotebookForAProject('project-2');

            assert.strictEqual(result1, 'notebook-1');
            assert.strictEqual(result2, 'notebook-2');
        });
    });

    suite('selectNotebookForProject', () => {
        test('should store notebook selection for project', () => {
            manager.selectNotebookForProject('project-123', 'notebook-456');

            const selectedNotebook = manager.getTheSelectedNotebookForAProject('project-123');

            assert.strictEqual(selectedNotebook, 'notebook-456');
        });

        test('should overwrite existing selection', () => {
            manager.selectNotebookForProject('project-123', 'notebook-456');
            manager.selectNotebookForProject('project-123', 'notebook-789');

            const result = manager.getTheSelectedNotebookForAProject('project-123');

            assert.strictEqual(result, 'notebook-789');
        });

        test('should handle multiple projects independently', () => {
            manager.selectNotebookForProject('project-1', 'notebook-1');
            manager.selectNotebookForProject('project-2', 'notebook-2');

            const result1 = manager.getTheSelectedNotebookForAProject('project-1');
            const result2 = manager.getTheSelectedNotebookForAProject('project-2');

            assert.strictEqual(result1, 'notebook-1');
            assert.strictEqual(result2, 'notebook-2');
        });
    });

    suite('storeOriginalProject', () => {
        test('should store both project and current notebook ID', () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-456');

            const storedProject = manager.getOriginalProject('project-123');
            const currentNotebookId = manager.getCurrentNotebookId('project-123');

            assert.deepStrictEqual(storedProject, mockProject);
            assert.strictEqual(currentNotebookId, 'notebook-456');
        });

        test('should overwrite existing project data', () => {
            const updatedProject: DeepnoteProject = {
                ...mockProject,
                project: {
                    ...mockProject.project,
                    name: 'Updated Project'
                }
            };

            manager.storeOriginalProject('project-123', mockProject, 'notebook-456');
            manager.storeOriginalProject('project-123', updatedProject, 'notebook-789');

            const storedProject = manager.getOriginalProject('project-123');
            const currentNotebookId = manager.getCurrentNotebookId('project-123');

            assert.deepStrictEqual(storedProject, updatedProject);
            assert.strictEqual(currentNotebookId, 'notebook-789');
        });
    });

    suite('updateCurrentNotebookId', () => {
        test('should update notebook ID for existing project', () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-456');
            manager.updateCurrentNotebookId('project-123', 'notebook-789');

            const result = manager.getCurrentNotebookId('project-123');

            assert.strictEqual(result, 'notebook-789');
        });

        test('should set notebook ID for new project', () => {
            manager.updateCurrentNotebookId('new-project', 'notebook-123');

            const result = manager.getCurrentNotebookId('new-project');

            assert.strictEqual(result, 'notebook-123');
        });

        test('should handle multiple projects independently', () => {
            manager.updateCurrentNotebookId('project-1', 'notebook-1');
            manager.updateCurrentNotebookId('project-2', 'notebook-2');

            const result1 = manager.getCurrentNotebookId('project-1');
            const result2 = manager.getCurrentNotebookId('project-2');

            assert.strictEqual(result1, 'notebook-1');
            assert.strictEqual(result2, 'notebook-2');
        });
    });

    suite('integration scenarios', () => {
        test('should handle complete workflow for multiple projects', () => {
            manager.storeOriginalProject('project-1', mockProject, 'notebook-1');
            manager.selectNotebookForProject('project-1', 'notebook-1');

            manager.storeOriginalProject('project-2', mockProject, 'notebook-2');
            manager.selectNotebookForProject('project-2', 'notebook-2');

            assert.strictEqual(manager.getCurrentNotebookId('project-1'), 'notebook-1');
            assert.strictEqual(manager.getCurrentNotebookId('project-2'), 'notebook-2');
            assert.strictEqual(manager.getTheSelectedNotebookForAProject('project-1'), 'notebook-1');
            assert.strictEqual(manager.getTheSelectedNotebookForAProject('project-2'), 'notebook-2');
        });

        test('should handle notebook switching within same project', () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-1');
            manager.selectNotebookForProject('project-123', 'notebook-1');

            manager.updateCurrentNotebookId('project-123', 'notebook-2');
            manager.selectNotebookForProject('project-123', 'notebook-2');

            assert.strictEqual(manager.getCurrentNotebookId('project-123'), 'notebook-2');
            assert.strictEqual(manager.getTheSelectedNotebookForAProject('project-123'), 'notebook-2');
        });

        test('should maintain separation between current and selected notebook IDs', () => {
            // Store original project sets current notebook
            manager.storeOriginalProject('project-123', mockProject, 'notebook-original');

            // Selecting a different notebook for the project
            manager.selectNotebookForProject('project-123', 'notebook-selected');

            // Both should be maintained independently
            assert.strictEqual(manager.getCurrentNotebookId('project-123'), 'notebook-original');
            assert.strictEqual(manager.getTheSelectedNotebookForAProject('project-123'), 'notebook-selected');
        });
    });
});
