import * as assert from 'assert';

import { DeepnoteNotebookManager } from './deepnoteNotebookManager';
import type { DeepnoteProject } from '../../platform/deepnote/deepnoteTypes';

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

    suite('updateProjectIntegrations', () => {
        test('should update integrations list for existing project and return true', () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-456');

            const integrations = [
                { id: 'int-1', name: 'PostgreSQL', type: 'pgsql' },
                { id: 'int-2', name: 'BigQuery', type: 'big-query' }
            ];

            const result = manager.updateProjectIntegrations('project-123', integrations);

            assert.strictEqual(result, true);

            const updatedProject = manager.getOriginalProject('project-123');
            assert.deepStrictEqual(updatedProject?.project.integrations, integrations);
        });

        test('should replace existing integrations list and return true', () => {
            const projectWithIntegrations: DeepnoteProject = {
                ...mockProject,
                project: {
                    ...mockProject.project,
                    integrations: [{ id: 'old-int', name: 'Old Integration', type: 'pgsql' }]
                }
            };

            manager.storeOriginalProject('project-123', projectWithIntegrations, 'notebook-456');

            const newIntegrations = [
                { id: 'new-int-1', name: 'New Integration 1', type: 'pgsql' },
                { id: 'new-int-2', name: 'New Integration 2', type: 'big-query' }
            ];

            const result = manager.updateProjectIntegrations('project-123', newIntegrations);

            assert.strictEqual(result, true);

            const updatedProject = manager.getOriginalProject('project-123');
            assert.deepStrictEqual(updatedProject?.project.integrations, newIntegrations);
        });

        test('should handle empty integrations array and return true', () => {
            const projectWithIntegrations: DeepnoteProject = {
                ...mockProject,
                project: {
                    ...mockProject.project,
                    integrations: [{ id: 'int-1', name: 'Integration 1', type: 'pgsql' }]
                }
            };

            manager.storeOriginalProject('project-123', projectWithIntegrations, 'notebook-456');

            const result = manager.updateProjectIntegrations('project-123', []);

            assert.strictEqual(result, true);

            const updatedProject = manager.getOriginalProject('project-123');
            assert.deepStrictEqual(updatedProject?.project.integrations, []);
        });

        test('should return false for unknown project', () => {
            const result = manager.updateProjectIntegrations('unknown-project', [
                { id: 'int-1', name: 'Integration', type: 'pgsql' }
            ]);

            assert.strictEqual(result, false);

            const project = manager.getOriginalProject('unknown-project');
            assert.strictEqual(project, undefined);
        });

        test('should preserve other project properties and return true', () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-456');

            const integrations = [{ id: 'int-1', name: 'PostgreSQL', type: 'pgsql' }];

            const result = manager.updateProjectIntegrations('project-123', integrations);

            assert.strictEqual(result, true);

            const updatedProject = manager.getOriginalProject('project-123');
            assert.strictEqual(updatedProject?.project.id, mockProject.project.id);
            assert.strictEqual(updatedProject?.project.name, mockProject.project.name);
            assert.strictEqual(updatedProject?.version, mockProject.version);
            assert.deepStrictEqual(updatedProject?.metadata, mockProject.metadata);
        });

        test('should update integrations when currentNotebookId is undefined and return true', () => {
            // Store project with a notebook ID, then clear it to simulate the edge case
            manager.storeOriginalProject('project-123', mockProject, 'notebook-456');
            manager.updateCurrentNotebookId('project-123', undefined as any);

            const integrations = [
                { id: 'int-1', name: 'PostgreSQL', type: 'pgsql' },
                { id: 'int-2', name: 'BigQuery', type: 'big-query' }
            ];

            const result = manager.updateProjectIntegrations('project-123', integrations);

            assert.strictEqual(result, true);

            const updatedProject = manager.getOriginalProject('project-123');
            assert.deepStrictEqual(updatedProject?.project.integrations, integrations);
            // Verify other properties remain unchanged
            assert.strictEqual(updatedProject?.project.id, mockProject.project.id);
            assert.strictEqual(updatedProject?.project.name, mockProject.project.name);
            assert.strictEqual(updatedProject?.version, mockProject.version);
            assert.deepStrictEqual(updatedProject?.metadata, mockProject.metadata);
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
