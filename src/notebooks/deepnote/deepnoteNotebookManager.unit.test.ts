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

    suite('getOriginalProject', () => {
        test('should return undefined for unknown project', () => {
            const result = manager.getOriginalProject('unknown-project');

            assert.strictEqual(result, undefined);
        });

        test('should return original project after storing', () => {
            manager.storeOriginalProject('project-123', mockProject);

            const result = manager.getOriginalProject('project-123');

            assert.deepStrictEqual(result, mockProject);
        });
    });

    suite('storeOriginalProject', () => {
        test('should store project data', () => {
            manager.storeOriginalProject('project-123', mockProject);

            const storedProject = manager.getOriginalProject('project-123');

            assert.deepStrictEqual(storedProject, mockProject);
        });

        test('should overwrite existing project data', () => {
            const updatedProject: DeepnoteProject = {
                ...mockProject,
                project: {
                    ...mockProject.project,
                    name: 'Updated Project'
                }
            };

            manager.storeOriginalProject('project-123', mockProject);
            manager.storeOriginalProject('project-123', updatedProject);

            const storedProject = manager.getOriginalProject('project-123');

            assert.deepStrictEqual(storedProject, updatedProject);
        });
    });

    suite('updateOriginalProject', () => {
        test('should update project data', () => {
            const updatedProject: DeepnoteProject = {
                ...mockProject,
                project: {
                    ...mockProject.project,
                    name: 'Updated Name Only'
                }
            };

            manager.storeOriginalProject('project-123', mockProject);
            manager.updateOriginalProject('project-123', updatedProject);

            const storedProject = manager.getOriginalProject('project-123');

            assert.deepStrictEqual(storedProject, updatedProject);
        });

        test('should deep-clone project data so mutations to input do not affect stored state', () => {
            const updatedProject: DeepnoteProject = {
                ...mockProject,
                project: {
                    ...mockProject.project,
                    name: 'Before Mutation'
                }
            };

            manager.storeOriginalProject('project-123', mockProject);
            manager.updateOriginalProject('project-123', updatedProject);

            updatedProject.project.name = 'After Mutation';

            const storedProject = manager.getOriginalProject('project-123');

            assert.strictEqual(storedProject?.project.name, 'Before Mutation');
        });

        test('should overwrite existing project data on successive updates', () => {
            const firstUpdate: DeepnoteProject = {
                ...mockProject,
                project: { ...mockProject.project, name: 'First Update' }
            };
            const secondUpdate: DeepnoteProject = {
                ...mockProject,
                project: { ...mockProject.project, name: 'Second Update' }
            };

            manager.storeOriginalProject('project-123', mockProject);
            manager.updateOriginalProject('project-123', firstUpdate);
            manager.updateOriginalProject('project-123', secondUpdate);

            assert.strictEqual(manager.getOriginalProject('project-123')?.project.name, 'Second Update');
        });

        test('should store project when no prior data exists', () => {
            const projectOnly: DeepnoteProject = {
                ...mockProject,
                project: { ...mockProject.project, name: 'No Notebook Id Yet' }
            };

            manager.updateOriginalProject('project-123', projectOnly);

            assert.deepStrictEqual(manager.getOriginalProject('project-123'), projectOnly);
        });
    });

    suite('updateProjectIntegrations', () => {
        test('should update integrations list for existing project and return true', () => {
            manager.storeOriginalProject('project-123', mockProject);

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

            manager.storeOriginalProject('project-123', projectWithIntegrations);

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

            manager.storeOriginalProject('project-123', projectWithIntegrations);

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
            manager.storeOriginalProject('project-123', mockProject);

            const integrations: ProjectIntegration[] = [{ id: 'int-1', name: 'PostgreSQL', type: 'pgsql' }];

            const result = manager.updateProjectIntegrations('project-123', integrations);

            assert.strictEqual(result, true);

            const updatedProject = manager.getOriginalProject('project-123');
            assert.strictEqual(updatedProject?.project.id, mockProject.project.id);
            assert.strictEqual(updatedProject?.project.name, mockProject.project.name);
            assert.strictEqual(updatedProject?.version, mockProject.version);
            assert.deepStrictEqual(updatedProject?.metadata, mockProject.metadata);
        });

        test('should update integrations when project was stored via updateOriginalProject and return true', () => {
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

    suite('hasInitNotebookBeenRun', () => {
        test('should return false for unknown project', () => {
            assert.strictEqual(manager.hasInitNotebookBeenRun('unknown-project'), false);
        });

        test('should return true after marking init notebook as run', () => {
            manager.markInitNotebookAsRun('project-123');

            assert.strictEqual(manager.hasInitNotebookBeenRun('project-123'), true);
        });
    });

    suite('markInitNotebookAsRun', () => {
        test('should mark init notebook as run for a project', () => {
            manager.markInitNotebookAsRun('project-123');

            assert.strictEqual(manager.hasInitNotebookBeenRun('project-123'), true);
        });
    });

    suite('integration scenarios', () => {
        test('should handle complete workflow for multiple projects', () => {
            manager.storeOriginalProject('project-1', mockProject);
            manager.storeOriginalProject('project-2', mockProject);

            assert.deepStrictEqual(manager.getOriginalProject('project-1'), mockProject);
            assert.deepStrictEqual(manager.getOriginalProject('project-2'), mockProject);
        });
    });
});
