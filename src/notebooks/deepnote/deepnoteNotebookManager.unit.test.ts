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
            manager.storeOriginalProject('project-123', 'notebook-456', mockProject);

            const result = manager.getCurrentNotebookId('project-123');

            assert.strictEqual(result, 'notebook-456');
        });

        test('should return updated notebook ID', () => {
            manager.storeOriginalProject('project-123', 'notebook-456', mockProject);
            manager.updateCurrentNotebookId('project-123', 'notebook-789');

            const result = manager.getCurrentNotebookId('project-123');

            assert.strictEqual(result, 'notebook-789');
        });
    });

    suite('getOriginalProject', () => {
        test('should return undefined for unknown project', () => {
            const result = manager.getOriginalProject('unknown-project', 'notebook-456');

            assert.strictEqual(result, undefined);
        });

        test('should return original project after storing', () => {
            manager.storeOriginalProject('project-123', 'notebook-456', mockProject);

            const result = manager.getOriginalProject('project-123', 'notebook-456');

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
            manager.storeOriginalProject('project-123', 'notebook-456', mockProject);

            const storedProject = manager.getOriginalProject('project-123', 'notebook-456');
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

            manager.storeOriginalProject('project-123', 'notebook-456', mockProject);
            manager.storeOriginalProject('project-123', 'notebook-456', updatedProject);

            const storedProject = manager.getOriginalProject('project-123', 'notebook-456');
            const currentNotebookId = manager.getCurrentNotebookId('project-123');

            assert.deepStrictEqual(storedProject, updatedProject);
            assert.strictEqual(currentNotebookId, 'notebook-456');
        });
    });

    suite('updateCurrentNotebookId', () => {
        test('should update notebook ID for existing project', () => {
            manager.storeOriginalProject('project-123', 'notebook-456', mockProject);
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
            manager.storeOriginalProject('project-123', 'notebook-456', mockProject);

            const integrations: ProjectIntegration[] = [
                { id: 'int-1', name: 'PostgreSQL', type: 'pgsql' },
                { id: 'int-2', name: 'BigQuery', type: 'big-query' }
            ];

            const result = manager.updateProjectIntegrations('project-123', integrations);

            assert.strictEqual(result, true);

            const updatedProject = manager.getOriginalProject('project-123', 'notebook-456');
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

            const updatedProject = manager.getOriginalProject('project-123', 'notebook-456');
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

            const updatedProject = manager.getOriginalProject('project-123', 'notebook-456');
            assert.deepStrictEqual(updatedProject?.project.integrations, []);
        });

        test('should return false for unknown project', () => {
            const result = manager.updateProjectIntegrations('unknown-project', [
                { id: 'int-1', name: 'Integration', type: 'pgsql' }
            ]);

            assert.strictEqual(result, false);

            const project = manager.getOriginalProject('unknown-project', 'notebook-456');
            assert.strictEqual(project, undefined);
        });

        test('should preserve other project properties and return true', () => {
            manager.storeOriginalProject('project-123', 'notebook-456', mockProject);

            const integrations: ProjectIntegration[] = [{ id: 'int-1', name: 'PostgreSQL', type: 'pgsql' }];

            const result = manager.updateProjectIntegrations('project-123', integrations);

            assert.strictEqual(result, true);

            const updatedProject = manager.getOriginalProject('project-123', 'notebook-456');
            assert.strictEqual(updatedProject?.project.id, mockProject.project.id);
            assert.strictEqual(updatedProject?.project.name, mockProject.project.name);
            assert.strictEqual(updatedProject?.version, mockProject.version);
            assert.deepStrictEqual(updatedProject?.metadata, mockProject.metadata);
        });

        test('should update integrations when currentNotebookId is undefined and return true', () => {
            // Store project with a notebook ID, then clear it to simulate the edge case
            manager.storeOriginalProject('project-123', 'notebook-456', mockProject);
            manager.updateCurrentNotebookId('project-123', undefined as any);

            const integrations: ProjectIntegration[] = [
                { id: 'int-1', name: 'PostgreSQL', type: 'pgsql' },
                { id: 'int-2', name: 'BigQuery', type: 'big-query' }
            ];

            const result = manager.updateProjectIntegrations('project-123', integrations);

            assert.strictEqual(result, true);

            const updatedProject = manager.getOriginalProject('project-123', 'notebook-456');
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
            manager.storeOriginalProject('project-1', 'notebook-1', mockProject);
            manager.selectNotebookForProject('project-1', 'notebook-1');

            manager.storeOriginalProject('project-2', 'notebook-2', mockProject);
            manager.selectNotebookForProject('project-2', 'notebook-2');

            assert.strictEqual(manager.getCurrentNotebookId('project-1'), 'notebook-1');
            assert.strictEqual(manager.getCurrentNotebookId('project-2'), 'notebook-2');
            assert.strictEqual(manager.getTheSelectedNotebookForAProject('project-1'), 'notebook-1');
            assert.strictEqual(manager.getTheSelectedNotebookForAProject('project-2'), 'notebook-2');
        });

        test('should handle notebook switching within same project', () => {
            manager.storeOriginalProject('project-123', 'notebook-1', mockProject);
            manager.selectNotebookForProject('project-123', 'notebook-1');

            manager.updateCurrentNotebookId('project-123', 'notebook-2');
            manager.selectNotebookForProject('project-123', 'notebook-2');

            assert.strictEqual(manager.getCurrentNotebookId('project-123'), 'notebook-2');
            assert.strictEqual(manager.getTheSelectedNotebookForAProject('project-123'), 'notebook-2');
        });

        test('should maintain separation between current and selected notebook IDs', () => {
            // Store original project sets current notebook
            manager.storeOriginalProject('project-123', 'notebook-original', mockProject);

            // Selecting a different notebook for the project
            manager.selectNotebookForProject('project-123', 'notebook-selected');

            // Both should be maintained independently
            assert.strictEqual(manager.getCurrentNotebookId('project-123'), 'notebook-original');
            assert.strictEqual(manager.getTheSelectedNotebookForAProject('project-123'), 'notebook-selected');
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

            assert.deepStrictEqual(manager.getOriginalProject(projectId, nbA), projectA);
            assert.deepStrictEqual(manager.getOriginalProject(projectId, nbB), projectB);
        });

        test('getOriginalProject is exact: returns undefined for an uncached notebook even though a sibling IS cached (NO fallback)', () => {
            manager.storeOriginalProject(projectId, nbA, siblingProject(nbA, 'Sibling A'));

            // A different notebook of the SAME project is cached, but the requested one is not.
            // The exact lookup must NOT fall back to the sibling — this is the key anti-regression
            // (a save path relies on it to never write against the wrong sibling's project).
            const result = manager.getOriginalProject(projectId, 'not-cached');

            assert.strictEqual(result, undefined);
        });

        test('getAnyProjectEntry returns one of the project entries (project-level)', () => {
            const projectA = siblingProject(nbA, 'Sibling A');
            const projectB = siblingProject(nbB, 'Sibling B');

            manager.storeOriginalProject(projectId, nbA, projectA);
            manager.storeOriginalProject(projectId, nbB, projectB);

            const result = manager.getAnyProjectEntry(projectId);

            assert.notStrictEqual(result, undefined);
            // It must be one of the project's own cached entries.
            const isOneOfTheSiblings =
                JSON.stringify(result) === JSON.stringify(projectA) ||
                JSON.stringify(result) === JSON.stringify(projectB);
            assert.strictEqual(
                isOneOfTheSiblings,
                true,
                'getAnyProjectEntry should return one of the cached sibling projects'
            );
        });

        test('getAnyProjectEntry returns undefined for an unknown project', () => {
            manager.storeOriginalProject(projectId, nbA, siblingProject(nbA, 'Sibling A'));

            assert.strictEqual(manager.getAnyProjectEntry('unknown-project'), undefined);
        });

        test('updateOriginalProject refreshes the exact entry without affecting the sibling', () => {
            const projectA = siblingProject(nbA, 'Sibling A');
            const projectB = siblingProject(nbB, 'Sibling B');

            manager.storeOriginalProject(projectId, nbA, projectA);
            manager.storeOriginalProject(projectId, nbB, projectB);

            const renamedA: DeepnoteProject = {
                ...projectA,
                project: { ...projectA.project, name: 'Sibling A Renamed' }
            };

            manager.updateOriginalProject(projectId, nbA, renamedA);

            assert.deepStrictEqual(manager.getOriginalProject(projectId, nbA), renamedA);
            // Sibling B must be untouched by the update to A.
            assert.deepStrictEqual(manager.getOriginalProject(projectId, nbB), projectB);
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
            assert.deepStrictEqual(manager.getOriginalProject(projectId, nbA)?.project.integrations, integrations);
            assert.deepStrictEqual(manager.getOriginalProject(projectId, nbB)?.project.integrations, integrations);
        });
    });
});
