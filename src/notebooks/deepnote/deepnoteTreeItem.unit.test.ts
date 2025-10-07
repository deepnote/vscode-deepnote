import { assert } from 'chai';
import { TreeItemCollapsibleState, ThemeIcon } from 'vscode';

import { DeepnoteTreeItem, DeepnoteTreeItemType, DeepnoteTreeItemContext } from './deepnoteTreeItem';
import type { DeepnoteProject, DeepnoteNotebook } from './deepnoteTypes';

suite('DeepnoteTreeItem', () => {
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
                    blocks: [],
                    executionMode: 'python',
                    isModule: false
                }
            ],
            settings: {}
        },
        version: '1.0'
    };

    const mockNotebook: DeepnoteNotebook = {
        id: 'notebook-456',
        name: 'Analysis Notebook',
        blocks: [{ blockGroup: 'group-123', id: 'block-1', content: 'print("hello")', sortingKey: 'a0', type: 'code' }],
        executionMode: 'python',
        isModule: false
    };

    suite('constructor', () => {
        test('should create project file item with basic properties', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                mockProject,
                TreeItemCollapsibleState.Collapsed
            );

            assert.strictEqual(item.type, DeepnoteTreeItemType.ProjectFile);
            assert.deepStrictEqual(item.context, context);
            assert.strictEqual(item.collapsibleState, TreeItemCollapsibleState.Collapsed);
            assert.strictEqual(item.label, 'Test Project');
            assert.strictEqual(item.description, '1 notebook');
        });

        test('should create notebook item with basic properties', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123',
                notebookId: 'notebook-456'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.Notebook,
                context,
                mockNotebook,
                TreeItemCollapsibleState.None
            );

            assert.strictEqual(item.type, DeepnoteTreeItemType.Notebook);
            assert.deepStrictEqual(item.context, context);
            assert.strictEqual(item.collapsibleState, TreeItemCollapsibleState.None);
            assert.strictEqual(item.label, 'Analysis Notebook');
            assert.strictEqual(item.description, '1 cell');
        });

        test('should accept custom collapsible state', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                mockProject,
                TreeItemCollapsibleState.Expanded
            );

            assert.strictEqual(item.collapsibleState, TreeItemCollapsibleState.Expanded);
        });
    });

    suite('ProjectFile type', () => {
        test('should have correct properties for project file', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/workspace/my-project.deepnote',
                projectId: 'project-456'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                mockProject,
                TreeItemCollapsibleState.Collapsed
            );

            assert.strictEqual(item.label, 'Test Project');
            assert.strictEqual(item.type, DeepnoteTreeItemType.ProjectFile);
            assert.strictEqual(item.collapsibleState, TreeItemCollapsibleState.Collapsed);
            assert.strictEqual(item.contextValue, 'projectFile');
            assert.strictEqual(item.tooltip, 'Deepnote Project: Test Project\nFile: /workspace/my-project.deepnote');
            assert.strictEqual(item.description, '1 notebook');

            // Should have notebook icon for project files
            assert.instanceOf(item.iconPath, ThemeIcon);
            assert.strictEqual((item.iconPath as ThemeIcon).id, 'notebook');

            // Should not have command for project files
            assert.isUndefined(item.command);
        });

        test('should handle project with multiple notebooks', () => {
            const projectWithMultipleNotebooks = {
                ...mockProject,
                project: {
                    ...mockProject.project,
                    notebooks: [
                        { id: 'notebook-1', name: 'First', blocks: [], executionMode: 'python', isModule: false },
                        { id: 'notebook-2', name: 'Second', blocks: [], executionMode: 'python', isModule: false },
                        { id: 'notebook-3', name: 'Third', blocks: [], executionMode: 'python', isModule: false }
                    ]
                }
            };

            const context: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                projectWithMultipleNotebooks,
                TreeItemCollapsibleState.Collapsed
            );

            assert.strictEqual(item.description, '3 notebooks');
        });

        test('should handle project with no notebooks', () => {
            const projectWithNoNotebooks = {
                ...mockProject,
                project: {
                    ...mockProject.project,
                    notebooks: []
                }
            };

            const context: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                projectWithNoNotebooks,
                TreeItemCollapsibleState.Collapsed
            );

            assert.strictEqual(item.description, '0 notebooks');
        });

        test('should handle unnamed project', () => {
            const unnamedProject = {
                ...mockProject,
                project: {
                    ...mockProject.project,
                    name: undefined
                }
            };

            const context: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                unnamedProject as any,
                TreeItemCollapsibleState.Collapsed
            );

            assert.strictEqual(item.label, 'Untitled Project');
        });
    });

    suite('Notebook type', () => {
        test('should have correct properties for notebook', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/workspace/project.deepnote',
                projectId: 'project-123',
                notebookId: 'notebook-789'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.Notebook,
                context,
                mockNotebook,
                TreeItemCollapsibleState.None
            );

            assert.strictEqual(item.label, 'Analysis Notebook');
            assert.strictEqual(item.type, DeepnoteTreeItemType.Notebook);
            assert.strictEqual(item.collapsibleState, TreeItemCollapsibleState.None);
            assert.strictEqual(item.contextValue, 'notebook');
            assert.strictEqual(item.tooltip, 'Notebook: Analysis Notebook\nExecution Mode: python');
            assert.strictEqual(item.description, '1 cell');

            // Should have file-code icon for notebooks
            assert.instanceOf(item.iconPath, ThemeIcon);
            assert.strictEqual((item.iconPath as ThemeIcon).id, 'file-code');

            // Should have open notebook command
            assert.isDefined(item.command);
            assert.strictEqual(item.command!.command, 'deepnote.openNotebook');
            assert.strictEqual(item.command!.title, 'Open Notebook');
            assert.deepStrictEqual(item.command!.arguments, [context]);

            // Should have resource URI
            assert.isDefined(item.resourceUri);
            assert.strictEqual(
                item.resourceUri!.toString(),
                'deepnote-notebook:/workspace/project.deepnote#notebook-789'
            );
        });

        test('should handle notebook with multiple blocks', () => {
            const notebookWithMultipleBlocks = {
                ...mockNotebook,
                blocks: [
                    {
                        blockGroup: 'group-123',
                        id: 'block-1',
                        content: 'import pandas',
                        sortingKey: 'a0',
                        type: 'code' as const
                    },
                    {
                        blockGroup: 'group-123',
                        id: 'block-2',
                        content: '# Analysis',
                        sortingKey: 'a1',
                        type: 'markdown' as const
                    },
                    {
                        blockGroup: 'group-123',
                        id: 'block-3',
                        content: 'df = pd.read_csv("data.csv")',
                        sortingKey: 'a2',
                        type: 'code' as const
                    },
                    {
                        blockGroup: 'group-123',
                        id: 'block-4',
                        content: 'print(df.head())',
                        sortingKey: 'a3',
                        type: 'code' as const
                    }
                ]
            };

            const context: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123',
                notebookId: 'notebook-456'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.Notebook,
                context,
                notebookWithMultipleBlocks,
                TreeItemCollapsibleState.None
            );

            assert.strictEqual(item.description, '4 cells');
        });

        test('should handle notebook with no blocks', () => {
            const notebookWithNoBlocks = {
                ...mockNotebook,
                blocks: []
            };

            const context: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123',
                notebookId: 'notebook-456'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.Notebook,
                context,
                notebookWithNoBlocks,
                TreeItemCollapsibleState.None
            );

            assert.strictEqual(item.description, '0 cells');
        });

        test('should handle unnamed notebook', () => {
            const unnamedNotebook = {
                ...mockNotebook,
                name: undefined
            };

            const context: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123',
                notebookId: 'notebook-456'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.Notebook,
                context,
                unnamedNotebook as any,
                TreeItemCollapsibleState.None
            );

            assert.strictEqual(item.label, 'Untitled Notebook');
        });

        test('should handle notebook without notebookId in context', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/workspace/project.deepnote',
                projectId: 'project-123'
                // No notebookId
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.Notebook,
                context,
                mockNotebook,
                TreeItemCollapsibleState.None
            );

            // Should still create the item with proper command
            assert.strictEqual(item.type, DeepnoteTreeItemType.Notebook);
            assert.isDefined(item.command);
            assert.strictEqual(item.command!.command, 'deepnote.openNotebook');
            assert.deepStrictEqual(item.command!.arguments, [context]);

            // Should not have resource URI
            assert.isUndefined(item.resourceUri);
        });
    });

    suite('context value generation', () => {
        test('should generate correct context values for different types', () => {
            const baseContext: DeepnoteTreeItemContext = {
                filePath: '/test/file.deepnote',
                projectId: 'project-1'
            };

            const projectItem = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                baseContext,
                mockProject,
                TreeItemCollapsibleState.Collapsed
            );

            const notebookItem = new DeepnoteTreeItem(
                DeepnoteTreeItemType.Notebook,
                { ...baseContext, notebookId: 'notebook-1' },
                mockNotebook,
                TreeItemCollapsibleState.None
            );

            assert.strictEqual(projectItem.contextValue, 'projectFile');
            assert.strictEqual(notebookItem.contextValue, 'notebook');
        });
    });

    suite('command configuration', () => {
        test('should not create command for project files', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                mockProject,
                TreeItemCollapsibleState.Collapsed
            );

            assert.isUndefined(item.command);
        });

        test('should create correct command for notebooks', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123',
                notebookId: 'notebook-456'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.Notebook,
                context,
                mockNotebook,
                TreeItemCollapsibleState.None
            );

            assert.isDefined(item.command);
            assert.strictEqual(item.command!.command, 'deepnote.openNotebook');
            assert.strictEqual(item.command!.title, 'Open Notebook');
            assert.strictEqual(item.command!.arguments!.length, 1);
            assert.deepStrictEqual(item.command!.arguments![0], context);
        });
    });

    suite('icon configuration', () => {
        test('should use notebook icon for project files', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                mockProject,
                TreeItemCollapsibleState.Collapsed
            );

            assert.instanceOf(item.iconPath, ThemeIcon);
            assert.strictEqual((item.iconPath as ThemeIcon).id, 'notebook');
        });

        test('should use file-code icon for notebooks', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123',
                notebookId: 'notebook-456'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.Notebook,
                context,
                mockNotebook,
                TreeItemCollapsibleState.None
            );

            assert.instanceOf(item.iconPath, ThemeIcon);
            assert.strictEqual((item.iconPath as ThemeIcon).id, 'file-code');
        });
    });

    suite('tooltip generation', () => {
        test('should generate tooltip with project info', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/test/amazing-project.deepnote',
                projectId: 'project-123'
            };

            const projectWithName = {
                ...mockProject,
                project: {
                    ...mockProject.project,
                    name: 'My Amazing Project'
                }
            };

            const projectItem = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                projectWithName,
                TreeItemCollapsibleState.Collapsed
            );

            assert.strictEqual(
                projectItem.tooltip,
                'Deepnote Project: My Amazing Project\nFile: /test/amazing-project.deepnote'
            );
        });

        test('should generate tooltip with notebook info', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123',
                notebookId: 'notebook-1'
            };

            const notebookWithDetails = {
                ...mockNotebook,
                name: 'Data Analysis',
                executionMode: 'python'
            };

            const notebookItem = new DeepnoteTreeItem(
                DeepnoteTreeItemType.Notebook,
                context,
                notebookWithDetails,
                TreeItemCollapsibleState.None
            );

            assert.strictEqual(notebookItem.tooltip, 'Notebook: Data Analysis\nExecution Mode: python');
        });

        test('should handle special characters in names', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123',
                notebookId: 'notebook-456'
            };

            const notebookWithSpecialChars = {
                ...mockNotebook,
                name: 'Notebook with "quotes" & special chars',
                executionMode: 'python'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.Notebook,
                context,
                notebookWithSpecialChars,
                TreeItemCollapsibleState.None
            );

            assert.strictEqual(
                item.tooltip,
                'Notebook: Notebook with "quotes" & special chars\nExecution Mode: python'
            );
        });
    });

    suite('context object immutability', () => {
        test('should not modify context object after creation', () => {
            const originalContext: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123',
                notebookId: 'notebook-456'
            };

            // Create a copy to compare against
            const expectedContext = { ...originalContext };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.Notebook,
                originalContext,
                mockNotebook,
                TreeItemCollapsibleState.None
            );

            // Verify context wasn't modified
            assert.deepStrictEqual(originalContext, expectedContext);
            assert.deepStrictEqual(item.context, expectedContext);
        });
    });

    suite('integration scenarios', () => {
        test('should create valid tree structure hierarchy', () => {
            // Create parent project file
            const projectContext: DeepnoteTreeItemContext = {
                filePath: '/workspace/research-project.deepnote',
                projectId: 'research-123'
            };

            const projectItem = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                projectContext,
                mockProject,
                TreeItemCollapsibleState.Expanded
            );

            // Create child notebook items
            const notebooks = [
                {
                    context: {
                        filePath: '/workspace/research-project.deepnote',
                        projectId: 'research-123',
                        notebookId: 'analysis-notebook'
                    },
                    data: {
                        id: 'analysis-notebook',
                        name: 'Data Analysis',
                        blocks: [],
                        executionMode: 'python',
                        isModule: false
                    }
                },
                {
                    context: {
                        filePath: '/workspace/research-project.deepnote',
                        projectId: 'research-123',
                        notebookId: 'visualization-notebook'
                    },
                    data: {
                        id: 'visualization-notebook',
                        name: 'Data Visualization',
                        blocks: [],
                        executionMode: 'python',
                        isModule: false
                    }
                }
            ];

            const notebookItems = notebooks.map(
                (nb) =>
                    new DeepnoteTreeItem(
                        DeepnoteTreeItemType.Notebook,
                        nb.context,
                        nb.data,
                        TreeItemCollapsibleState.None
                    )
            );

            // Verify project structure
            assert.strictEqual(projectItem.type, DeepnoteTreeItemType.ProjectFile);
            assert.strictEqual(projectItem.collapsibleState, TreeItemCollapsibleState.Expanded);
            assert.strictEqual(projectItem.contextValue, 'projectFile');

            // Verify notebook structure
            assert.strictEqual(notebookItems.length, 2);
            notebookItems.forEach((item) => {
                assert.strictEqual(item.type, DeepnoteTreeItemType.Notebook);
                assert.strictEqual(item.collapsibleState, TreeItemCollapsibleState.None);
                assert.strictEqual(item.contextValue, 'notebook');
                assert.isDefined(item.command);
                assert.strictEqual(item.command!.command, 'deepnote.openNotebook');
            });

            // Verify they reference the same project
            assert.strictEqual(notebookItems[0].context.projectId, projectItem.context.projectId);
            assert.strictEqual(notebookItems[1].context.projectId, projectItem.context.projectId);
            assert.strictEqual(notebookItems[0].context.filePath, projectItem.context.filePath);
            assert.strictEqual(notebookItems[1].context.filePath, projectItem.context.filePath);
        });

        test('should handle different file paths correctly', () => {
            const contexts = [
                {
                    filePath: '/workspace/project1.deepnote',
                    projectId: 'project-1'
                },
                {
                    filePath: '/different/path/project2.deepnote',
                    projectId: 'project-2'
                },
                {
                    filePath: '/nested/deeply/nested/project3.deepnote',
                    projectId: 'project-3'
                }
            ];

            const items = contexts.map(
                (context) =>
                    new DeepnoteTreeItem(
                        DeepnoteTreeItemType.ProjectFile,
                        context,
                        mockProject,
                        TreeItemCollapsibleState.Collapsed
                    )
            );

            // Verify each item has correct file path
            items.forEach((item, index) => {
                assert.strictEqual(item.context.filePath, contexts[index].filePath);
                assert.strictEqual(item.context.projectId, contexts[index].projectId);
                assert.isUndefined(item.command); // Project files don't have commands
            });
        });
    });
});
