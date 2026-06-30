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

    suite('getProjectForNotebook', () => {
        test('should return undefined for unknown project', () => {
            const result = manager.getProjectForNotebook('unknown-project', 'notebook-456');

            assert.strictEqual(result, undefined);
        });

        test('should return original project after storing', () => {
            manager.storeOriginalProject('project-123', 'notebook-456', mockProject);

            const result = manager.getProjectForNotebook('project-123', 'notebook-456');

            assert.deepStrictEqual(result, mockProject);
        });
    });

    suite('storeOriginalProject', () => {
        test('should store the project for the (projectId, notebookId) pair', () => {
            manager.storeOriginalProject('project-123', 'notebook-456', mockProject);

            const storedProject = manager.getProjectForNotebook('project-123', 'notebook-456');

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

            manager.storeOriginalProject('project-123', 'notebook-456', mockProject);
            manager.storeOriginalProject('project-123', 'notebook-456', updatedProject);

            const storedProject = manager.getProjectForNotebook('project-123', 'notebook-456');

            assert.deepStrictEqual(storedProject, updatedProject);
        });
    });

    suite('updateProjectIntegrations', () => {
        test('should update integrations list for existing project and return true', () => {
            manager.storeOriginalProject('project-123', 'notebook-456', mockProject);

            const integrations: ProjectIntegration[] = [
                { id: 'int-1', name: 'PostgreSQL', type: 'pgsql' },
                { id: 'int-2', name: 'BigQuery', type: 'big-query' }
            ];

            const result = manager.updateProjectIntegrations('project-123', integrations);

            assert.strictEqual(result, true);

            const updatedProject = manager.getProjectForNotebook('project-123', 'notebook-456');
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

            manager.storeOriginalProject('project-123', 'notebook-456', projectWithIntegrations);

            const newIntegrations: ProjectIntegration[] = [
                { id: 'new-int-1', name: 'New Integration 1', type: 'pgsql' },
                { id: 'new-int-2', name: 'New Integration 2', type: 'big-query' }
            ];

            const result = manager.updateProjectIntegrations('project-123', newIntegrations);

            assert.strictEqual(result, true);

            const updatedProject = manager.getProjectForNotebook('project-123', 'notebook-456');
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

            manager.storeOriginalProject('project-123', 'notebook-456', projectWithIntegrations);

            const result = manager.updateProjectIntegrations('project-123', []);

            assert.strictEqual(result, true);

            const updatedProject = manager.getProjectForNotebook('project-123', 'notebook-456');
            assert.deepStrictEqual(updatedProject?.project.integrations, []);
        });

        test('should return false for unknown project', () => {
            const result = manager.updateProjectIntegrations('unknown-project', [
                { id: 'int-1', name: 'Integration', type: 'pgsql' }
            ]);

            assert.strictEqual(result, false);

            const project = manager.getProjectForNotebook('unknown-project', 'notebook-456');
            assert.strictEqual(project, undefined);
        });

        test('should preserve other project properties and return true', () => {
            manager.storeOriginalProject('project-123', 'notebook-456', mockProject);

            const integrations: ProjectIntegration[] = [{ id: 'int-1', name: 'PostgreSQL', type: 'pgsql' }];

            const result = manager.updateProjectIntegrations('project-123', integrations);

            assert.strictEqual(result, true);

            const updatedProject = manager.getProjectForNotebook('project-123', 'notebook-456');
            assert.strictEqual(updatedProject?.project.id, mockProject.project.id);
            assert.strictEqual(updatedProject?.project.name, mockProject.project.name);
            assert.strictEqual(updatedProject?.version, mockProject.version);
            assert.deepStrictEqual(updatedProject?.metadata, mockProject.metadata);
        });
    });

    suite('integration scenarios', () => {
        test('should store and retrieve projects for multiple project ids independently', () => {
            const projectOne: DeepnoteProject = {
                ...mockProject,
                project: { ...mockProject.project, id: 'project-1' }
            };
            const projectTwo: DeepnoteProject = {
                ...mockProject,
                project: { ...mockProject.project, id: 'project-2' }
            };

            manager.storeOriginalProject('project-1', 'notebook-1', projectOne);
            manager.storeOriginalProject('project-2', 'notebook-2', projectTwo);

            assert.deepStrictEqual(manager.getProjectForNotebook('project-1', 'notebook-1'), projectOne);
            assert.deepStrictEqual(manager.getProjectForNotebook('project-2', 'notebook-2'), projectTwo);
        });
    });

    // Two sibling .deepnote files of ONE project share project.id but each holds a
    // different single notebook. These tests pin the load-bearing new semantics:
    // nested (projectId, notebookId) storage with an exact, no-fallback lookup.
    suite('nested sibling storage', () => {
        const projectId = 'shared-project-id';
        const nbA = 'notebook-A';
        const nbB = 'notebook-B';

        // A project (whole DeepnoteFile) for one sibling: same projectId, distinct notebook.
        function siblingProject(notebookId: string, notebookName: string): DeepnoteProject {
            return {
                ...mockProject,
                project: {
                    ...mockProject.project,
                    id: projectId,
                    notebooks: [
                        {
                            id: notebookId,
                            name: notebookName,
                            blocks: []
                        }
                    ]
                }
            };
        }

        test('stores two siblings of the same project without clobbering each other', () => {
            const projectA = siblingProject(nbA, 'Sibling A');
            const projectB = siblingProject(nbB, 'Sibling B');

            manager.storeOriginalProject(projectId, nbA, projectA);
            manager.storeOriginalProject(projectId, nbB, projectB);

            assert.deepStrictEqual(manager.getProjectForNotebook(projectId, nbA), projectA);
            assert.deepStrictEqual(manager.getProjectForNotebook(projectId, nbB), projectB);
        });

        test('getProjectForNotebook is exact: returns undefined for an uncached notebook even though a sibling IS cached (NO fallback)', () => {
            manager.storeOriginalProject(projectId, nbA, siblingProject(nbA, 'Sibling A'));

            // A different notebook of the SAME project is cached, but the requested one is not.
            // The exact lookup must NOT fall back to the sibling — this is the key anti-regression
            // (a save path relies on it to never write against the wrong sibling's project).
            const result = manager.getProjectForNotebook(projectId, 'not-cached');

            assert.strictEqual(result, undefined);
        });

        test('updateProjectIntegrations updates every cached notebook entry under the project', () => {
            manager.storeOriginalProject(projectId, nbA, siblingProject(nbA, 'Sibling A'));
            manager.storeOriginalProject(projectId, nbB, siblingProject(nbB, 'Sibling B'));

            const integrations: ProjectIntegration[] = [
                { id: 'int-1', name: 'PostgreSQL', type: 'pgsql' },
                { id: 'int-2', name: 'BigQuery', type: 'big-query' }
            ];

            const updated = manager.updateProjectIntegrations(projectId, integrations);

            assert.strictEqual(updated, true);
            // BOTH siblings of the project must see the new integrations.
            assert.deepStrictEqual(manager.getProjectForNotebook(projectId, nbA)?.project.integrations, integrations);
            assert.deepStrictEqual(manager.getProjectForNotebook(projectId, nbB)?.project.integrations, integrations);
        });
    });
});
