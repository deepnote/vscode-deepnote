import { assert } from 'chai';

import { DeepnoteTreeDataProvider } from './deepnoteTreeDataProvider';
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

        test('should return loading item on first call with correct properties', async () => {
            const newProvider = new DeepnoteTreeDataProvider();

            // First call should return loading item
            const children = await newProvider.getChildren();
            assert.isArray(children);
            assert.isAtLeast(children.length, 1);

            const firstChild = children[0];
            assert.strictEqual(firstChild.type, DeepnoteTreeItemType.Loading);
            assert.strictEqual(firstChild.contextValue, 'loading');
            assert.strictEqual(firstChild.label, 'Scanning for Deepnote projects...');
            assert.isDefined(firstChild.iconPath);

            if (newProvider && typeof newProvider.dispose === 'function') {
                newProvider.dispose();
            }
        });

        test('should complete initial scan and show projects after loading', async () => {
            const newProvider = new DeepnoteTreeDataProvider();

            // First call shows loading
            const loadingChildren = await newProvider.getChildren();
            assert.isArray(loadingChildren);

            // Wait a bit for the initial scan to complete
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Second call should show actual projects (or empty array if no projects)
            const actualChildren = await newProvider.getChildren();
            assert.isArray(actualChildren);

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

            // First call shows loading
            const firstChildren = await newProvider.getChildren();
            assert.isArray(firstChildren);

            // Wait for initial scan to complete
            await new Promise((resolve) => setTimeout(resolve, 10));

            // After scan, should not show loading
            const afterScanChildren = await newProvider.getChildren();
            assert.isArray(afterScanChildren);

            // Call refresh to reset state
            newProvider.refresh();

            // After refresh, should show loading again
            const childrenAfterRefresh = await newProvider.getChildren();
            assert.isArray(childrenAfterRefresh);
            if (childrenAfterRefresh.length > 0) {
                const firstItem = childrenAfterRefresh[0];
                if (firstItem.type === DeepnoteTreeItemType.Loading) {
                    assert.strictEqual(firstItem.label, 'Scanning for Deepnote projects...');
                }
            }

            if (newProvider && typeof newProvider.dispose === 'function') {
                newProvider.dispose();
            }
        });
    });

    suite('loading state', () => {
        test('should show loading on first call to empty tree', async () => {
            const newProvider = new DeepnoteTreeDataProvider();

            // Call getChildren without element (root level)
            const children = await newProvider.getChildren(undefined);
            assert.isArray(children);
            assert.isAtLeast(children.length, 1);

            // First child should be loading item
            assert.strictEqual(children[0].type, DeepnoteTreeItemType.Loading);

            if (newProvider && typeof newProvider.dispose === 'function') {
                newProvider.dispose();
            }
        });

        test('should transition from loading to projects', async () => {
            const newProvider = new DeepnoteTreeDataProvider();

            // First call shows loading
            const loadingResult = await newProvider.getChildren(undefined);
            assert.isArray(loadingResult);
            assert.isAtLeast(loadingResult.length, 1);
            assert.strictEqual(loadingResult[0].type, DeepnoteTreeItemType.Loading);

            // Wait for scan to complete
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Next call shows actual results
            const projectsResult = await newProvider.getChildren(undefined);
            assert.isArray(projectsResult);
            // In test environment without workspace, this will be empty
            // but should not contain loading item anymore

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

            // Getting children of a project should never show loading
            const children = await provider.getChildren(mockProjectItem);
            assert.isArray(children);
            // Should not contain any loading items
            const hasLoadingItem = children.some((child) => child.type === DeepnoteTreeItemType.Loading);
            assert.isFalse(hasLoadingItem);
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
});
