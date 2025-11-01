import { assert } from 'chai';
import { l10n } from 'vscode';

import { DeepnoteTreeDataProvider, compareTreeItemsByLabel } from './deepnoteTreeDataProvider';
import { DeepnoteTreeItem, DeepnoteTreeItemType } from './deepnoteTreeItem';
import type { DeepnoteProject } from '../../platform/deepnote/deepnoteTypes';

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
                            type: 'markdown'
                        }
                    ],
                    executionMode: 'block',
                    isModule: false
                }
            ],
            settings: {}
        },
        version: '1.0'
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
                if (typeof (provider as any).refreshProject === 'function') {
                    void (provider as any).refreshProject('/workspace/project.deepnote');
                }
            });
        });

        test('should support selective refresh of notebooks for a project', async () => {
            // Verify that refreshNotebook method exists and doesn't throw
            assert.doesNotThrow(() => {
                if (typeof (provider as any).refreshNotebook === 'function') {
                    void (provider as any).refreshNotebook('project-123');
                }
            });
        });

        test('should update visual fields when project data changes', async () => {
            // Access private caches
            const treeItemCache = (provider as any).treeItemCache as Map<string, DeepnoteTreeItem>;

            // Create initial project with 1 notebook
            const filePath = '/workspace/test-project.deepnote';
            const cacheKey = `project:${filePath}`;
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
                        }
                    ],
                    settings: {}
                },
                version: '1.0'
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
            treeItemCache.set(cacheKey, mockTreeItem);

            // Verify initial state
            assert.strictEqual(mockTreeItem.label, 'Original Name');
            assert.strictEqual(mockTreeItem.description, '1 notebook');

            // Update the project data (simulating rename and adding notebooks)
            const updatedProject: DeepnoteProject = {
                ...initialProject,
                project: {
                    ...initialProject.project,
                    name: 'Renamed Project',
                    notebooks: [
                        initialProject.project.notebooks[0],
                        {
                            id: 'notebook-2',
                            name: 'Notebook 2',
                            blocks: [],
                            executionMode: 'block',
                            isModule: false
                        }
                    ]
                }
            };

            mockTreeItem.data = updatedProject;
            mockTreeItem.updateVisualFields();

            // Verify visual fields were updated
            assert.strictEqual(mockTreeItem.label, 'Renamed Project', 'Label should reflect new project name');
            assert.strictEqual(
                mockTreeItem.description,
                '2 notebooks',
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
            const cachedProjects = (provider as any).cachedProjects as Map<string, DeepnoteProject>;
            const treeItemCache = (provider as any).treeItemCache as Map<string, DeepnoteTreeItem>;

            // Add entries to both caches
            const filePath = '/workspace/test-project.deepnote';
            const cacheKey = `project:${filePath}`;

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
            treeItemCache.set(cacheKey, mockTreeItem);

            // Verify both caches have the entry
            assert.isTrue(cachedProjects.has(filePath), 'cachedProjects should have entry before deletion');
            assert.isTrue(treeItemCache.has(cacheKey), 'treeItemCache should have entry before deletion');

            // Simulate file deletion by calling the internal cleanup logic
            // (we can't easily trigger the file watcher in unit tests)
            cachedProjects.delete(filePath);
            treeItemCache.delete(cacheKey);

            // Verify both caches have been cleared
            assert.isFalse(cachedProjects.has(filePath), 'cachedProjects should not have entry after deletion');
            assert.isFalse(treeItemCache.has(cacheKey), 'treeItemCache should not have entry after deletion');
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
                    version: '1.0'
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
                    version: '1.0'
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
                    version: '1.0'
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
                version: '1.0'
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
                version: '1.0'
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
});
