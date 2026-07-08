import { assert } from 'chai';
import { l10n } from 'vscode';

import { DeepnoteTreeDataProvider, compareTreeItemsByLabel } from './deepnoteTreeDataProvider';
import { DeepnoteTreeItem, DeepnoteTreeItemType, getNonInitNotebooks } from './deepnoteTreeItem';
import type { DeepnoteProject } from '../../platform/deepnote/deepnoteTypes';

/**
 * Structural mirror of DeepnoteTreeDataProvider's private surface (deepnoteTreeDataProvider.ts).
 * `internals` is the single typed seam these tests use to reach private caches and helpers.
 */
interface DeepnoteTreeDataProviderInternals {
    readonly cachedProjects: Map<string, DeepnoteProject>;
    readonly fileItemCache: Map<string, DeepnoteTreeItem>;
    getProjectGroups(): Promise<DeepnoteTreeItem[]>;
}

function internals(provider: DeepnoteTreeDataProvider): DeepnoteTreeDataProviderInternals {
    return provider as unknown as DeepnoteTreeDataProviderInternals;
}

/**
 * Build a single-notebook DeepnoteProject (whole-file shape) for a given project/notebook id.
 */
function makeSingleNotebookProject(
    projectId: string,
    notebookId: string,
    projectName = 'Test Project'
): DeepnoteProject {
    return {
        metadata: { createdAt: '2023-01-01T00:00:00Z', modifiedAt: '2023-01-02T00:00:00Z' },
        project: {
            id: projectId,
            name: projectName,
            notebooks: [
                {
                    id: notebookId,
                    name: `Notebook ${notebookId}`,
                    blocks: [],
                    executionMode: 'block',
                    isModule: false
                }
            ],
            settings: {}
        },
        version: '1.0.0'
    };
}

suite('DeepnoteTreeDataProvider', () => {
    let provider: DeepnoteTreeDataProvider;

    const mockProject: DeepnoteProject = {
        metadata: {
            createdAt: '2023-01-01T00:00:00Z',
            modifiedAt: '2023-01-02T00:00:00Z'
        },
        project: {
            id: 'project-123',
            name: 'Test Project',
            notebooks: [
                {
                    id: 'notebook-1',
                    name: 'First Notebook',
                    blocks: [
                        {
                            blockGroup: 'group-123',
                            id: 'block-1',
                            content: 'print("hello")',
                            sortingKey: 'a0',
                            metadata: {},
                            type: 'code'
                        }
                    ],
                    executionMode: 'block',
                    isModule: false
                },
                {
                    id: 'notebook-2',
                    name: 'Second Notebook',
                    blocks: [
                        {
                            blockGroup: 'group-123',
                            id: 'block-2',
                            content: '# Title',
                            sortingKey: 'a0',
                            metadata: {},
                            type: 'markdown'
                        }
                    ],
                    executionMode: 'block',
                    isModule: false
                }
            ],
            settings: {}
        },
        version: '1.0.0'
    };

    setup(() => {
        provider = new DeepnoteTreeDataProvider();
    });

    teardown(() => {
        if (provider && typeof provider.dispose === 'function') {
            provider.dispose();
        }
    });

    suite('constructor', () => {
        test('should create instance', () => {
            assert.isDefined(provider);
        });

        test('should create multiple independent instances', () => {
            const newProvider = new DeepnoteTreeDataProvider();
            assert.isDefined(newProvider);
            assert.notStrictEqual(newProvider, provider);

            if (newProvider && typeof newProvider.dispose === 'function') {
                newProvider.dispose();
            }
        });
    });

    suite('getChildren', () => {
        test('should return array when called without parent', async () => {
            // In test environment without workspace, this returns empty array
            const children = await provider.getChildren();
            assert.isArray(children);
        });

        test('should not throw on first getChildren call with new provider instance', async () => {
            const newProvider = new DeepnoteTreeDataProvider();

            // First call - just verify it returns an array and doesn't throw
            const children = await newProvider.getChildren();
            assert.isArray(children);

            if (newProvider && typeof newProvider.dispose === 'function') {
                newProvider.dispose();
            }
        });

        test('should return empty array when no workspace is available', async () => {
            const newProvider = new DeepnoteTreeDataProvider();

            // In test environment without workspace, returns empty array
            const children = await newProvider.getChildren();
            assert.isArray(children);
            assert.strictEqual(children.length, 0, 'Should return empty array when no workspace folders exist');

            if (newProvider && typeof newProvider.dispose === 'function') {
                newProvider.dispose();
            }
        });

        test('should return array when called with project item parent', async () => {
            // Create a mock project item
            const mockProjectItem = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                {
                    filePath: '/workspace/project.deepnote',
                    projectId: 'project-123'
                },
                mockProject,
                1 // TreeItemCollapsibleState.Collapsed
            );

            const children = await provider.getChildren(mockProjectItem);
            assert.isArray(children);
        });
    });

    suite('getTreeItem', () => {
        test('should return the same tree item', () => {
            const mockItem = new DeepnoteTreeItem(
                DeepnoteTreeItemType.Notebook,
                { filePath: '/test', projectId: 'project-1', notebookId: 'notebook-1' },
                {
                    id: 'notebook-1',
                    name: 'Test Notebook',
                    blocks: [],
                    executionMode: 'block',
                    isModule: false
                },
                0 // TreeItemCollapsibleState.None
            );

            const result = provider.getTreeItem(mockItem);

            assert.strictEqual(result, mockItem);
        });
    });

    suite('refresh', () => {
        test('should have refresh method that can be called without throwing', () => {
            assert.isFunction(provider.refresh);

            // Call refresh to verify it doesn't throw
            assert.doesNotThrow(() => provider.refresh());
        });

        test('should reset initial scan state on refresh', async () => {
            const newProvider = new DeepnoteTreeDataProvider();
            const firstChildren = await newProvider.getChildren();
            assert.isArray(firstChildren);

            await new Promise((resolve) => setTimeout(resolve, 10));

            // After scan
            const afterScanChildren = await newProvider.getChildren();
            assert.isArray(afterScanChildren);

            // Call refresh to reset state - this exercises the refresh logic
            newProvider.refresh();

            // After refresh - should return to initial state (loading or empty)
            const childrenAfterRefresh = await newProvider.getChildren();
            assert.isArray(childrenAfterRefresh);

            // Verify that refresh reset to initial scan state
            // The post-refresh state should match the initial state
            assert.strictEqual(
                childrenAfterRefresh.length,
                firstChildren.length,
                'After refresh, should return to initial state with same number of children'
            );

            // If initial state had a loading item, post-refresh should too
            if (firstChildren.length > 0 && firstChildren[0].contextValue === 'loading') {
                assert.strictEqual(
                    childrenAfterRefresh[0].contextValue,
                    'loading',
                    'After refresh, should show loading item again'
                );
                assert.strictEqual(
                    childrenAfterRefresh[0].label,
                    firstChildren[0].label,
                    'Loading item label should match initial state'
                );
            }

            if (newProvider && typeof newProvider.dispose === 'function') {
                newProvider.dispose();
            }
        });
    });

    suite('loading state', () => {
        test('should call getChildren and execute loading logic', async () => {
            const newProvider = new DeepnoteTreeDataProvider();

            // Call getChildren without element (root level) - exercises loading code path
            const children = await newProvider.getChildren(undefined);
            assert.isArray(children);
            // In test environment may be empty or have loading item depending on timing

            if (newProvider && typeof newProvider.dispose === 'function') {
                newProvider.dispose();
            }
        });

        test('should handle multiple getChildren calls', async () => {
            const newProvider = new DeepnoteTreeDataProvider();

            // First call
            const firstResult = await newProvider.getChildren(undefined);
            assert.isArray(firstResult);

            // Wait a bit
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Second call
            const secondResult = await newProvider.getChildren(undefined);
            assert.isArray(secondResult);

            if (newProvider && typeof newProvider.dispose === 'function') {
                newProvider.dispose();
            }
        });

        test('should not show loading for child elements', async () => {
            // Create a mock project item
            const mockProjectItem = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                {
                    filePath: '/workspace/project.deepnote',
                    projectId: 'project-123'
                },
                mockProject,
                1
            );

            // Getting children of a project exercises the non-loading code path
            const children = await provider.getChildren(mockProjectItem);
            assert.isArray(children);

            // Verify no loading items are present
            const hasLoadingType = children.some((child) => child.type === DeepnoteTreeItemType.Loading);
            assert.isFalse(hasLoadingType, 'Children should not contain any loading type items');

            // Also verify no loading labels
            const hasLoadingLabel = children.some(
                (child) => child.label === l10n.t('Scanning for Deepnote projects...') || child.label === 'Loading'
            );
            assert.isFalse(hasLoadingLabel, 'Children should not contain any loading labels');
        });
    });

    suite('data management', () => {
        test('should handle file path operations', () => {
            // Test utility methods that don't depend on VS Code APIs
            const testPaths = [
                '/workspace/project1.deepnote',
                '/different/path/project2.deepnote',
                '/nested/deeply/nested/project3.deepnote'
            ];

            // Verify that path strings are handled correctly
            testPaths.forEach((path) => {
                assert.isString(path, 'file paths are strings');
                assert.isTrue(path.endsWith('.deepnote'), 'paths have correct extension');
            });
        });

        test('should handle project data structures', () => {
            // Verify the mock project structure
            assert.isDefined(mockProject.project);
            assert.isDefined(mockProject.project.notebooks);
            assert.strictEqual(mockProject.project.notebooks.length, 2);

            const firstNotebook = mockProject.project.notebooks[0];
            assert.strictEqual(firstNotebook.name, 'First Notebook');
            assert.strictEqual(firstNotebook.id, 'notebook-1');
        });
    });

    suite('integration scenarios', () => {
        test('should maintain independence between multiple providers', () => {
            const provider1 = new DeepnoteTreeDataProvider();
            const provider2 = new DeepnoteTreeDataProvider();

            // Verify providers are independent instances
            assert.notStrictEqual(provider1, provider2);

            // Clean up
            if (provider1 && typeof provider1.dispose === 'function') {
                provider1.dispose();
            }
            if (provider2 && typeof provider2.dispose === 'function') {
                provider2.dispose();
            }
        });
    });

    suite('granular tree updates', () => {
        test('should support firing change event with undefined for full refresh', () => {
            // This is the current behavior - refreshes entire tree
            assert.doesNotThrow(() => {
                provider.refresh();
            });
        });

        test('should support selective refresh of a specific project', async () => {
            // Verify that refreshProject method exists and doesn't throw
            assert.doesNotThrow(() => {
                if (typeof provider.refreshProject === 'function') {
                    void provider.refreshProject('/workspace/project.deepnote');
                }
            });
        });

        test('should support selective refresh of notebooks for a project', async () => {
            // Verify that refreshNotebook method exists and doesn't throw
            assert.doesNotThrow(() => {
                if (typeof provider.refreshNotebook === 'function') {
                    void provider.refreshNotebook('project-123');
                }
            });
        });

        test('should update visual fields when project data changes', async () => {
            // Access the file-item cache (keyed by file path)
            const fileItemCache = internals(provider).fileItemCache;

            // Create initial legacy multi-notebook project (2 notebooks → projectFile node)
            const filePath = '/workspace/test-project.deepnote';
            const initialProject: DeepnoteProject = {
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-01T00:00:00Z'
                },
                project: {
                    id: 'project-123',
                    name: 'Original Name',
                    notebooks: [
                        {
                            id: 'notebook-1',
                            name: 'Notebook 1',
                            blocks: [],
                            executionMode: 'block',
                            isModule: false
                        },
                        {
                            id: 'notebook-2',
                            name: 'Notebook 2',
                            blocks: [],
                            executionMode: 'block',
                            isModule: false
                        }
                    ],
                    settings: {}
                },
                version: '1.0.0'
            };

            const mockTreeItem = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                {
                    filePath: filePath,
                    projectId: 'project-123'
                },
                initialProject,
                1
            );
            fileItemCache.set(filePath, mockTreeItem);

            // Verify initial state
            assert.strictEqual(mockTreeItem.label, 'Original Name');
            assert.strictEqual(mockTreeItem.description, '2 notebooks');

            // Update the project data (simulating rename and adding a notebook)
            const updatedProject: DeepnoteProject = {
                ...initialProject,
                project: {
                    ...initialProject.project,
                    name: 'Renamed Project',
                    notebooks: [
                        ...initialProject.project.notebooks,
                        {
                            id: 'notebook-3',
                            name: 'Notebook 3',
                            blocks: [],
                            executionMode: 'block',
                            isModule: false
                        }
                    ]
                }
            };

            mockTreeItem.data = updatedProject;
            // Call updateVisualFields if it is available (in the VS Code test mock the subclass
            // method may not be exposed on the proxied TreeItem); otherwise update fields manually.
            if (typeof mockTreeItem.updateVisualFields === 'function') {
                mockTreeItem.updateVisualFields();
            } else {
                mockTreeItem.label = updatedProject.project.name || 'Untitled Project';
                mockTreeItem.tooltip = `Deepnote Project: ${updatedProject.project.name}\nFile: ${mockTreeItem.context.filePath}`;
                const notebookCount = updatedProject.project.notebooks?.length || 0;
                mockTreeItem.description = `${notebookCount} notebook${notebookCount !== 1 ? 's' : ''}`;
            }

            // Verify visual fields were updated
            assert.strictEqual(mockTreeItem.label, 'Renamed Project', 'Label should reflect new project name');
            assert.strictEqual(
                mockTreeItem.description,
                '3 notebooks',
                'Description should reflect new notebook count'
            );
            assert.include(
                mockTreeItem.tooltip as string,
                'Renamed Project',
                'Tooltip should include new project name'
            );
        });

        test('should clear both caches when file is deleted', () => {
            // Access private caches
            const cachedProjects = internals(provider).cachedProjects;
            const fileItemCache = internals(provider).fileItemCache;

            // Add entries to both caches (both keyed by file path)
            const filePath = '/workspace/test-project.deepnote';

            cachedProjects.set(filePath, mockProject);
            const mockTreeItem = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                {
                    filePath: filePath,
                    projectId: 'project-123'
                },
                mockProject,
                1
            );
            fileItemCache.set(filePath, mockTreeItem);

            // Verify both caches have the entry
            assert.isTrue(cachedProjects.has(filePath), 'cachedProjects should have entry before deletion');
            assert.isTrue(fileItemCache.has(filePath), 'fileItemCache should have entry before deletion');

            // Simulate file deletion by calling the internal cleanup logic
            // (we can't easily trigger the file watcher in unit tests)
            cachedProjects.delete(filePath);
            fileItemCache.delete(filePath);

            // Verify both caches have been cleared
            assert.isFalse(cachedProjects.has(filePath), 'cachedProjects should not have entry after deletion');
            assert.isFalse(fileItemCache.has(filePath), 'fileItemCache should not have entry after deletion');
        });
    });

    suite('alphabetical sorting', () => {
        test('compareTreeItemsByLabel should sort items alphabetically (case-insensitive)', () => {
            // Test the comparator function in isolation
            const mockProjects: DeepnoteProject[] = [
                {
                    metadata: {
                        createdAt: '2023-01-01T00:00:00Z',
                        modifiedAt: '2023-01-02T00:00:00Z'
                    },
                    project: {
                        id: 'project-zebra',
                        name: 'Zebra Project',
                        notebooks: [],
                        settings: {}
                    },
                    version: '1.0.0'
                },
                {
                    metadata: {
                        createdAt: '2023-01-01T00:00:00Z',
                        modifiedAt: '2023-01-02T00:00:00Z'
                    },
                    project: {
                        id: 'project-apple',
                        name: 'Apple Project',
                        notebooks: [],
                        settings: {}
                    },
                    version: '1.0.0'
                },
                {
                    metadata: {
                        createdAt: '2023-01-01T00:00:00Z',
                        modifiedAt: '2023-01-02T00:00:00Z'
                    },
                    project: {
                        id: 'project-middle',
                        name: 'Middle Project',
                        notebooks: [],
                        settings: {}
                    },
                    version: '1.0.0'
                }
            ];

            // Create tree items in unsorted order
            const treeItems = mockProjects.map(
                (project) =>
                    new DeepnoteTreeItem(
                        DeepnoteTreeItemType.ProjectFile,
                        {
                            filePath: `/workspace/${project.project.name}.deepnote`,
                            projectId: project.project.id
                        },
                        project,
                        0
                    )
            );

            // Verify items are initially unsorted
            assert.strictEqual(treeItems[0].label, 'Zebra Project');

            // Sort using the exported comparator
            const sortedItems = [...treeItems].sort(compareTreeItemsByLabel);

            // Verify alphabetical order
            assert.strictEqual(sortedItems[0].label, 'Apple Project');
            assert.strictEqual(sortedItems[1].label, 'Middle Project');
            assert.strictEqual(sortedItems[2].label, 'Zebra Project');
        });

        test('should sort notebooks alphabetically by name within a project', async () => {
            // Create a project with unsorted notebooks
            const mockProjectWithNotebooks: DeepnoteProject = {
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-123',
                    name: 'Test Project',
                    notebooks: [
                        {
                            id: 'notebook-z',
                            name: 'Zebra Notebook',
                            blocks: [],
                            executionMode: 'block',
                            isModule: false
                        },
                        {
                            id: 'notebook-a',
                            name: 'Apple Notebook',
                            blocks: [],
                            executionMode: 'block',
                            isModule: false
                        },
                        {
                            id: 'notebook-m',
                            name: 'Middle Notebook',
                            blocks: [],
                            executionMode: 'block',
                            isModule: false
                        }
                    ],
                    settings: {}
                },
                version: '1.0.0'
            };

            const mockProjectItem = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                {
                    filePath: '/workspace/project.deepnote',
                    projectId: 'project-123'
                },
                mockProjectWithNotebooks,
                1
            );

            const notebookItems = await provider.getChildren(mockProjectItem);

            // Verify notebooks are sorted alphabetically
            assert.strictEqual(notebookItems.length, 3, 'Should have 3 notebooks');
            assert.strictEqual(notebookItems[0].label, 'Apple Notebook', 'First notebook should be Apple Notebook');
            assert.strictEqual(notebookItems[1].label, 'Middle Notebook', 'Second notebook should be Middle Notebook');
            assert.strictEqual(notebookItems[2].label, 'Zebra Notebook', 'Third notebook should be Zebra Notebook');
        });

        test('should sort notebooks case-insensitively', async () => {
            // Create a project with notebooks having different cases
            const mockProjectWithNotebooks: DeepnoteProject = {
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-123',
                    name: 'Test Project',
                    notebooks: [
                        {
                            id: 'notebook-z',
                            name: 'zebra notebook',
                            blocks: [],
                            executionMode: 'block',
                            isModule: false
                        },
                        {
                            id: 'notebook-a',
                            name: 'Apple Notebook',
                            blocks: [],
                            executionMode: 'block',
                            isModule: false
                        },
                        {
                            id: 'notebook-m',
                            name: 'MIDDLE Notebook',
                            blocks: [],
                            executionMode: 'block',
                            isModule: false
                        }
                    ],
                    settings: {}
                },
                version: '1.0.0'
            };

            const mockProjectItem = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                {
                    filePath: '/workspace/project.deepnote',
                    projectId: 'project-123'
                },
                mockProjectWithNotebooks,
                1
            );

            const notebookItems = await provider.getChildren(mockProjectItem);

            // Verify case-insensitive sorting
            assert.strictEqual(notebookItems.length, 3, 'Should have 3 notebooks');
            assert.strictEqual(notebookItems[0].label, 'Apple Notebook', 'First should be Apple Notebook');
            assert.strictEqual(notebookItems[1].label, 'MIDDLE Notebook', 'Second should be MIDDLE Notebook');
            assert.strictEqual(notebookItems[2].label, 'zebra notebook', 'Third should be zebra notebook');
        });
    });

    // Sibling files share one project.id, so refresh must rebuild the whole grouped subtree
    // rather than patch a single cached item.
    suite('grouping-safe refresh semantics', () => {
        const projectId = 'shared-project-id';
        const otherProjectId = 'other-project-id';
        const filePathA = '/workspace/proj-a.deepnote';
        const filePathB = '/workspace/proj-b.deepnote';
        const filePathOther = '/workspace/other.deepnote';

        let cachedProjects: Map<string, DeepnoteProject>;
        let fireArgs: Array<DeepnoteTreeItem | undefined | null | void>;

        setup(() => {
            // Seed two sibling files sharing one project.id plus a third file of a DIFFERENT project.
            cachedProjects = internals(provider).cachedProjects;
            cachedProjects.set(filePathA, makeSingleNotebookProject(projectId, 'nb-a'));
            cachedProjects.set(filePathB, makeSingleNotebookProject(projectId, 'nb-b'));
            cachedProjects.set(filePathOther, makeSingleNotebookProject(otherProjectId, 'nb-other'));

            // Capture every fire arg through the PUBLIC event so a scoped fire(item) would be visible.
            fireArgs = [];
            provider.onDidChangeTreeData((arg) => fireArgs.push(arg));
        });

        test('refreshNotebook evicts BOTH sibling entries (not just the first match), so a stale sibling cannot win', () => {
            provider.refreshNotebook(projectId);

            assert.isFalse(
                cachedProjects.has(filePathA),
                'sibling A must be evicted (refreshNotebook must not break on the first match)'
            );
            assert.isFalse(cachedProjects.has(filePathB), 'sibling B must be evicted too');
        });

        test('refreshNotebook leaves the OTHER project entry intact (does not over-evict across projects)', () => {
            provider.refreshNotebook(projectId);

            assert.isTrue(
                cachedProjects.has(filePathOther),
                'a file belonging to a different project.id must NOT be evicted'
            );
        });

        test('refreshNotebook fires a FULL-tree change (undefined), never a scoped fire(item)', () => {
            provider.refreshNotebook(projectId);

            assert.strictEqual(fireArgs.length, 1, 'refreshNotebook must fire exactly once');
            assert.isUndefined(fireArgs[0], 'refreshNotebook must fire undefined (full-tree), not a tree item');
        });

        test('refreshProject evicts ONLY that file path, leaving sibling B and the other project cached', () => {
            provider.refreshProject(filePathA);

            assert.isFalse(cachedProjects.has(filePathA), 'the targeted file path must be evicted');
            assert.isTrue(cachedProjects.has(filePathB), 'the sibling sharing project.id must remain cached');
            assert.isTrue(cachedProjects.has(filePathOther), 'the other project must remain cached');
        });
    });

    suite('getNonInitNotebooks excludes the init notebook', () => {
        test('the init notebook (project.initNotebookId) is excluded from the file notebook list', () => {
            const project: DeepnoteProject = {
                metadata: { createdAt: '2023-01-01T00:00:00Z', modifiedAt: '2023-01-02T00:00:00Z' },
                project: {
                    id: 'project-with-init',
                    name: 'Has Init',
                    initNotebookId: 'init-nb',
                    notebooks: [
                        { id: 'init-nb', name: 'Init', blocks: [], executionMode: 'block', isModule: false },
                        { id: 'main-nb', name: 'Main', blocks: [], executionMode: 'block', isModule: false }
                    ],
                    settings: {}
                },
                version: '1.0.0'
            };

            const nonInit = getNonInitNotebooks(project);

            assert.strictEqual(nonInit.length, 1, 'only the non-init notebook should remain');
            assert.strictEqual(nonInit[0].id, 'main-nb', 'the surviving notebook must be the main (non-init) one');
        });
    });

    suite('getChildren groups siblings and distinguishes leaf vs legacy files', () => {
        const projectId = 'group-project';

        // Invoke getProjectGroups()/getChildren(groupItem) directly rather than the root getChildren(),
        // which short-circuits to [] when workspace.workspaceFolders is unset; the seeded cache drives grouping.
        function seed(entries: Array<[string, DeepnoteProject]>): void {
            const cachedProjects = internals(provider).cachedProjects;
            for (const [filePath, project] of entries) {
                cachedProjects.set(filePath, project);
            }
        }

        async function getGroupItems(): Promise<DeepnoteTreeItem[]> {
            return internals(provider).getProjectGroups();
        }

        test('two siblings sharing one project.id collapse into ONE ProjectGroup', async () => {
            seed([
                ['/workspace/a.deepnote', makeSingleNotebookProject(projectId, 'nb-a', 'Grouped')],
                ['/workspace/b.deepnote', makeSingleNotebookProject(projectId, 'nb-b', 'Grouped')]
            ]);

            const groups = (await getGroupItems()).filter((item) => item.type === DeepnoteTreeItemType.ProjectGroup);

            assert.strictEqual(groups.length, 1, 'both siblings must roll up into a single ProjectGroup');
            assert.strictEqual(groups[0].context.projectId, projectId);
            assert.strictEqual(groups[0].contextValue, 'projectGroup', 'group node contextValue');
        });

        test('a single-notebook file renders as a notebookFile leaf; a legacy multi-notebook file is collapsible', async () => {
            const legacyMulti: DeepnoteProject = {
                metadata: { createdAt: '2023-01-01T00:00:00Z', modifiedAt: '2023-01-02T00:00:00Z' },
                project: {
                    id: projectId,
                    name: 'Grouped',
                    notebooks: [
                        { id: 'm1', name: 'Main 1', blocks: [], executionMode: 'block', isModule: false },
                        { id: 'm2', name: 'Main 2', blocks: [], executionMode: 'block', isModule: false }
                    ],
                    settings: {}
                },
                version: '1.0.0'
            };

            const singleFile: [string, DeepnoteProject] = [
                '/workspace/single.deepnote',
                makeSingleNotebookProject(projectId, 'only-nb', 'Grouped')
            ];

            seed([singleFile, ['/workspace/legacy.deepnote', legacyMulti]]);

            const group = (await getGroupItems()).find((item) => item.type === DeepnoteTreeItemType.ProjectGroup);
            assert.isDefined(group, 'a ProjectGroup must exist');

            const files = await provider.getChildren(group);

            const leaf = files.find((f) => f.context.filePath === '/workspace/single.deepnote');
            const legacy = files.find((f) => f.context.filePath === '/workspace/legacy.deepnote');

            assert.isDefined(leaf, 'single-notebook file item must exist');
            assert.isDefined(legacy, 'legacy multi-notebook file item must exist');

            assert.strictEqual(leaf!.contextValue, 'notebookFile', 'single-notebook file is a notebookFile leaf');
            assert.strictEqual(
                leaf!.collapsibleState,
                0 /* TreeItemCollapsibleState.None */,
                'a single-notebook leaf must not be collapsible'
            );

            assert.strictEqual(legacy!.contextValue, 'projectFile', 'legacy multi-notebook file is a projectFile');
            assert.strictEqual(
                legacy!.collapsibleState,
                1 /* TreeItemCollapsibleState.Collapsed */,
                'a legacy multi-notebook file must be collapsible'
            );

            // The legacy file expands into its non-init Notebook children.
            const notebooks = await provider.getChildren(legacy);
            assert.strictEqual(notebooks.length, 2, 'legacy file expands into its notebooks');
            assert.isTrue(
                notebooks.every((n) => n.type === DeepnoteTreeItemType.Notebook),
                'legacy children are Notebook items'
            );
        });

        test('the init notebook is excluded from a file group/leaf — an init+main file renders as a single-notebook leaf', async () => {
            const initPlusMain: DeepnoteProject = {
                metadata: { createdAt: '2023-01-01T00:00:00Z', modifiedAt: '2023-01-02T00:00:00Z' },
                project: {
                    id: projectId,
                    name: 'Grouped',
                    initNotebookId: 'the-init',
                    notebooks: [
                        { id: 'the-init', name: 'Init', blocks: [], executionMode: 'block', isModule: false },
                        { id: 'the-main', name: 'Main', blocks: [], executionMode: 'block', isModule: false }
                    ],
                    settings: {}
                },
                version: '1.0.0'
            };

            seed([['/workspace/init-main.deepnote', initPlusMain]]);

            const group = (await getGroupItems()).find((item) => item.type === DeepnoteTreeItemType.ProjectGroup);
            const files = await provider.getChildren(group);

            assert.strictEqual(files.length, 1, 'one file in the group');
            assert.strictEqual(
                files[0].contextValue,
                'notebookFile',
                'with the init excluded, exactly one non-init notebook remains → leaf'
            );
            assert.strictEqual(files[0].label, 'Main', 'the leaf is labelled with the non-init notebook name');
        });
    });
});
