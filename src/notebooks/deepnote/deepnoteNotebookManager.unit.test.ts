import type { DeepnoteFile } from '@deepnote/blocks';
import * as assert from 'assert';

import { DeepnoteNotebookManager } from './deepnoteNotebookManager';
import { createDeepnoteFile, createDeepnoteNotebook, createDeepnoteProject } from './deepnoteTestHelpers';
import { ProjectIntegration } from '../types';

suite('DeepnoteNotebookManager', () => {
    let manager: DeepnoteNotebookManager;

    const mockProject: DeepnoteFile = createDeepnoteFile({
        metadata: { createdAt: '2023-01-01T00:00:00Z', modifiedAt: '2023-01-02T00:00:00Z' },
        project: createDeepnoteProject({ id: 'project-123', notebooks: [], settings: {} })
    });

    setup(() => {
        manager = new DeepnoteNotebookManager();
    });

    suite('getProjectForNotebook', () => {
        test('should return undefined for unknown project', () => {
            const result = manager.getProjectForNotebook('unknown-project', 'notebook-456');

            assert.strictEqual(result, undefined);
        });
    });

    suite('storeOriginalProject', () => {
        test('should store the project for the (projectId, notebookId) pair', () => {
            manager.storeOriginalProject('project-123', 'notebook-456', mockProject);

            const storedProject = manager.getProjectForNotebook('project-123', 'notebook-456');

            assert.deepStrictEqual(storedProject, mockProject);
        });

        test('should overwrite existing project data', () => {
            const updatedProject: DeepnoteFile = {
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

    suite('updateProjectIntegrationsForNotebook', () => {
        test('replaces the list of the entry and keeps every other field of it', () => {
            manager.storeOriginalProject('project-123', 'notebook-456', {
                ...mockProject,
                project: { ...mockProject.project, integrations: [{ id: 'old-int', name: 'Old', type: 'pgsql' }] }
            });

            const integrations: ProjectIntegration[] = [{ id: 'int-1', name: 'PostgreSQL', type: 'pgsql' }];

            manager.updateProjectIntegrationsForNotebook('project-123', 'notebook-456', integrations);

            assert.deepStrictEqual(manager.getProjectForNotebook('project-123', 'notebook-456'), {
                ...mockProject,
                project: { ...mockProject.project, integrations }
            });
        });

        test('caches nothing for a project or notebook that is not cached', () => {
            manager.storeOriginalProject('project-123', 'notebook-456', mockProject);
            const integrations: ProjectIntegration[] = [{ id: 'int-1', name: 'PostgreSQL', type: 'pgsql' }];

            manager.updateProjectIntegrationsForNotebook('unknown-project', 'notebook-456', integrations);
            manager.updateProjectIntegrationsForNotebook('project-123', 'unknown-notebook', integrations);

            assert.strictEqual(manager.getProjectForNotebook('unknown-project', 'notebook-456'), undefined);
            assert.strictEqual(manager.getProjectForNotebook('project-123', 'unknown-notebook'), undefined);
            assert.deepStrictEqual(manager.getProjectForNotebook('project-123', 'notebook-456'), mockProject);
        });
    });

    // Two sibling .deepnote files of one project share project.id but hold different single notebooks.
    // These pin the nested (projectId, notebookId) storage with an exact, no-fallback lookup.
    suite('nested sibling storage', () => {
        const projectId = 'shared-project-id';
        const nbA = 'notebook-A';
        const nbB = 'notebook-B';

        // A project (whole DeepnoteFile) for one sibling: same projectId, distinct notebook.
        function siblingProject(notebookId: string, notebookName: string): DeepnoteFile {
            return createDeepnoteFile({
                metadata: { createdAt: '2023-01-01T00:00:00Z', modifiedAt: '2023-01-02T00:00:00Z' },
                project: createDeepnoteProject({
                    id: projectId,
                    settings: {},
                    notebooks: [createDeepnoteNotebook({ id: notebookId, name: notebookName })]
                })
            });
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

            // The exact lookup must NOT fall back to a cached sibling of the same project — a save
            // path relies on this to never write against the wrong sibling's project.
            const result = manager.getProjectForNotebook(projectId, 'not-cached');

            assert.strictEqual(result, undefined);
        });

        test('updateProjectIntegrationsForNotebook updates that entry alone, leaving the siblings on their own lists', () => {
            const siblingIntegrations: ProjectIntegration[] = [{ id: 'int-b', name: 'MySQL', type: 'mysql' }];
            const projectB = siblingProject(nbB, 'Sibling B');
            projectB.project.integrations = siblingIntegrations;
            manager.storeOriginalProject(projectId, nbA, siblingProject(nbA, 'Sibling A'));
            manager.storeOriginalProject(projectId, nbB, projectB);

            const integrations: ProjectIntegration[] = [{ id: 'int-1', name: 'PostgreSQL', type: 'pgsql' }];

            manager.updateProjectIntegrationsForNotebook(projectId, nbA, integrations);

            assert.deepStrictEqual(manager.getProjectForNotebook(projectId, nbA)?.project.integrations, integrations);
            assert.deepStrictEqual(
                manager.getProjectForNotebook(projectId, nbB)?.project.integrations,
                siblingIntegrations
            );
        });

        test('updateProjectIntegrationsForNotebook deep-clones integrations so the cache is isolated from the caller', () => {
            manager.storeOriginalProject(projectId, nbA, siblingProject(nbA, 'Sibling A'));

            const pg: ProjectIntegration = { id: 'int-1', name: 'PostgreSQL', type: 'pgsql' };
            const integrations: ProjectIntegration[] = [pg];

            manager.updateProjectIntegrationsForNotebook(projectId, nbA, integrations);

            pg.name = 'MUTATED';
            integrations.push({ id: 'int-2', name: 'BigQuery', type: 'big-query' });

            assert.deepStrictEqual(manager.getProjectForNotebook(projectId, nbA)?.project.integrations, [
                { id: 'int-1', name: 'PostgreSQL', type: 'pgsql' }
            ]);
        });
    });
});
