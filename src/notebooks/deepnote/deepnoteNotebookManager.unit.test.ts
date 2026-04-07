import * as assert from 'assert';

import { DeepnoteNotebookManager } from './deepnoteNotebookManager';
import type { DeepnoteProject } from '../../platform/deepnote/deepnoteTypes';
import { ProjectIntegration } from '../types';

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
        version: '1.0.0'
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

    suite('consumePendingNotebookResolution', () => {
        test('should return undefined when no pending resolution exists', () => {
            const result = manager.consumePendingNotebookResolution('unknown-project');

            assert.strictEqual(result, undefined);
        });

        test('should consume queued notebook resolutions in order', () => {
            manager.queueNotebookResolution('project-123', 'notebook-1');
            manager.queueNotebookResolution('project-123', 'notebook-2');

            assert.strictEqual(manager.consumePendingNotebookResolution('project-123'), 'notebook-1');
            assert.strictEqual(manager.consumePendingNotebookResolution('project-123'), 'notebook-2');
            assert.strictEqual(manager.consumePendingNotebookResolution('project-123'), undefined);
        });

        test('should keep pending resolutions isolated per project', () => {
            manager.queueNotebookResolution('project-1', 'notebook-1');
            manager.queueNotebookResolution('project-2', 'notebook-2');

            assert.strictEqual(manager.consumePendingNotebookResolution('project-1'), 'notebook-1');
            assert.strictEqual(manager.consumePendingNotebookResolution('project-2'), 'notebook-2');
        });
    });

    suite('queueNotebookResolution', () => {
        test('should queue a notebook resolution for later consumption', () => {
            manager.queueNotebookResolution('project-123', 'notebook-456');

            assert.strictEqual(manager.consumePendingNotebookResolution('project-123'), 'notebook-456');
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

    suite('updateOriginalProject', () => {
        test('should update project data without changing currentNotebookId', () => {
            const updatedProject: DeepnoteProject = {
                ...mockProject,
                project: {
                    ...mockProject.project,
                    name: 'Updated Name Only'
                }
            };

            manager.storeOriginalProject('project-123', mockProject, 'notebook-456');
            manager.updateOriginalProject('project-123', updatedProject);

            const storedProject = manager.getOriginalProject('project-123');
            const currentNotebookId = manager.getCurrentNotebookId('project-123');

            assert.deepStrictEqual(storedProject, updatedProject);
            assert.strictEqual(currentNotebookId, 'notebook-456');
        });

        test('should deep-clone project data so mutations to input do not affect stored state', () => {
            const updatedProject: DeepnoteProject = {
                ...mockProject,
                project: {
                    ...mockProject.project,
                    name: 'Before Mutation'
                }
            };

            manager.storeOriginalProject('project-123', mockProject, 'notebook-456');
            manager.updateOriginalProject('project-123', updatedProject);

            updatedProject.project.name = 'After Mutation';

            const storedProject = manager.getOriginalProject('project-123');

            assert.strictEqual(storedProject?.project.name, 'Before Mutation');
        });

        test('should overwrite existing project data while preserving currentNotebookId', () => {
            const firstUpdate: DeepnoteProject = {
                ...mockProject,
                project: { ...mockProject.project, name: 'First Update' }
            };
            const secondUpdate: DeepnoteProject = {
                ...mockProject,
                project: { ...mockProject.project, name: 'Second Update' }
            };

            manager.storeOriginalProject('project-123', mockProject, 'notebook-456');
            manager.updateOriginalProject('project-123', firstUpdate);
            manager.updateOriginalProject('project-123', secondUpdate);

            assert.strictEqual(manager.getCurrentNotebookId('project-123'), 'notebook-456');
            assert.strictEqual(manager.getOriginalProject('project-123')?.project.name, 'Second Update');
        });

        test('should store project when no currentNotebookId has been set', () => {
            const projectOnly: DeepnoteProject = {
                ...mockProject,
                project: { ...mockProject.project, name: 'No Notebook Id Yet' }
            };

            manager.updateOriginalProject('project-123', projectOnly);

            assert.strictEqual(manager.getCurrentNotebookId('project-123'), undefined);
            assert.deepStrictEqual(manager.getOriginalProject('project-123'), projectOnly);
        });
    });

    suite('updateProjectIntegrations', () => {
        test('should update integrations list for existing project and return true', () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-456');

            const integrations: ProjectIntegration[] = [
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

            const newIntegrations: ProjectIntegration[] = [
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

            const integrations: ProjectIntegration[] = [{ id: 'int-1', name: 'PostgreSQL', type: 'pgsql' }];

            const result = manager.updateProjectIntegrations('project-123', integrations);

            assert.strictEqual(result, true);

            const updatedProject = manager.getOriginalProject('project-123');
            assert.strictEqual(updatedProject?.project.id, mockProject.project.id);
            assert.strictEqual(updatedProject?.project.name, mockProject.project.name);
            assert.strictEqual(updatedProject?.version, mockProject.version);
            assert.deepStrictEqual(updatedProject?.metadata, mockProject.metadata);
        });

        test('should update integrations when currentNotebookId is undefined and return true', () => {
            // Use updateOriginalProject which doesn't set currentNotebookId
            manager.updateOriginalProject('project-123', mockProject);

            const integrations: ProjectIntegration[] = [
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
            manager.storeOriginalProject('project-2', mockProject, 'notebook-2');

            assert.strictEqual(manager.getCurrentNotebookId('project-1'), 'notebook-1');
            assert.strictEqual(manager.getCurrentNotebookId('project-2'), 'notebook-2');
        });

        test('should handle notebook switching within same project via storeOriginalProject', () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-1');
            manager.storeOriginalProject('project-123', mockProject, 'notebook-2');

            assert.strictEqual(manager.getCurrentNotebookId('project-123'), 'notebook-2');
        });
    });
});
