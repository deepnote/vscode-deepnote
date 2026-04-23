import { assert } from 'chai';
import { TreeItemCollapsibleState, ThemeIcon } from 'vscode';

import {
    DeepnoteTreeItem,
    DeepnoteTreeItemType,
    DeepnoteTreeItemContext,
    NOTEBOOK_FILE_CONTEXT_VALUE,
    getSingleNonInitNotebook
} from './deepnoteTreeItem';
import type { DeepnoteProject, DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';

suite('DeepnoteTreeItem', () => {
    // A project with a single non-init notebook. Under the refactored rules this means
    // the `ProjectFile` row should adopt the notebook's label and `notebookFile` contextValue.
    const singleNotebookProject: DeepnoteProject = {
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
                    executionMode: 'block',
                    isModule: false
                }
            ],
            settings: {}
        },
        version: '1.0.0'
    };

    // A legacy multi-notebook project. The `ProjectFile` row should use the file basename
    // as its label and keep the default `projectFile` contextValue.
    const multiNotebookProject: DeepnoteProject = {
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
                    executionMode: 'block',
                    isModule: false
                },
                {
                    id: 'notebook-2',
                    name: 'Second Notebook',
                    blocks: [],
                    executionMode: 'block',
                    isModule: false
                }
            ],
            settings: {}
        },
        version: '1.0.0'
    };

    const mockNotebook: DeepnoteNotebook = {
        id: 'notebook-456',
        name: 'Analysis Notebook',
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
    };

    suite('constructor', () => {
        test('should create multi-notebook project file item with basic properties', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                multiNotebookProject,
                TreeItemCollapsibleState.Collapsed
            );

            assert.strictEqual(item.type, DeepnoteTreeItemType.ProjectFile);
            assert.deepStrictEqual(item.context, context);
            assert.strictEqual(item.collapsibleState, TreeItemCollapsibleState.Collapsed);
            assert.strictEqual(item.label, 'project.deepnote');
            assert.strictEqual(item.description, '0 cells');
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
                multiNotebookProject,
                TreeItemCollapsibleState.Expanded
            );

            assert.strictEqual(item.collapsibleState, TreeItemCollapsibleState.Expanded);
        });
    });

    suite('ProjectFile type (single non-init notebook)', () => {
        test('should use the sole notebook name as label and notebookFile contextValue', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/workspace/my-project.deepnote',
                projectId: 'project-456'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                singleNotebookProject,
                TreeItemCollapsibleState.None
            );

            assert.strictEqual(item.label, 'First Notebook');
            assert.strictEqual(item.contextValue, NOTEBOOK_FILE_CONTEXT_VALUE);
            assert.strictEqual(item.contextValue, 'notebookFile');
            assert.strictEqual(item.tooltip, 'Deepnote Project: Test Project\nFile: /workspace/my-project.deepnote');
        });

        test('should fall back to project name when notebook name is empty', () => {
            const projectWithEmptyNotebookName: DeepnoteProject = {
                ...singleNotebookProject,
                project: {
                    ...singleNotebookProject.project,
                    notebooks: [
                        {
                            id: 'notebook-1',
                            name: '',
                            blocks: [],
                            executionMode: 'block',
                            isModule: false
                        }
                    ]
                }
            };

            const context: DeepnoteTreeItemContext = {
                filePath: '/workspace/my-project.deepnote',
                projectId: 'project-456'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                projectWithEmptyNotebookName,
                TreeItemCollapsibleState.None
            );

            assert.strictEqual(item.label, 'Test Project');
            assert.strictEqual(item.contextValue, NOTEBOOK_FILE_CONTEXT_VALUE);
        });

        test('should fall back to Untitled Notebook when both notebook and project names are empty', () => {
            const projectWithNoNames: DeepnoteProject = {
                ...singleNotebookProject,
                project: {
                    ...singleNotebookProject.project,
                    name: '',
                    notebooks: [
                        {
                            id: 'notebook-1',
                            name: '',
                            blocks: [],
                            executionMode: 'block',
                            isModule: false
                        }
                    ]
                }
            };

            const context: DeepnoteTreeItemContext = {
                filePath: '/workspace/my-project.deepnote',
                projectId: 'project-456'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                projectWithNoNames,
                TreeItemCollapsibleState.None
            );

            assert.strictEqual(item.label, 'Untitled Notebook');
            assert.strictEqual(item.contextValue, NOTEBOOK_FILE_CONTEXT_VALUE);
        });

        test('should treat a file with one non-init notebook as single-notebook even when an init notebook exists', () => {
            const projectWithInit: DeepnoteProject = {
                ...singleNotebookProject,
                project: {
                    ...singleNotebookProject.project,
                    initNotebookId: 'init-notebook',
                    notebooks: [
                        {
                            id: 'init-notebook',
                            name: 'Init',
                            blocks: [],
                            executionMode: 'block',
                            isModule: false
                        },
                        {
                            id: 'notebook-1',
                            name: 'Only Real Notebook',
                            blocks: [],
                            executionMode: 'block',
                            isModule: false
                        }
                    ]
                }
            };

            const context: DeepnoteTreeItemContext = {
                filePath: '/workspace/my-project.deepnote',
                projectId: 'project-456'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                projectWithInit,
                TreeItemCollapsibleState.None
            );

            assert.strictEqual(item.label, 'Only Real Notebook');
            assert.strictEqual(item.contextValue, NOTEBOOK_FILE_CONTEXT_VALUE);
        });
    });

    suite('ProjectFile type (legacy multi-notebook)', () => {
        test('should have correct properties for project file', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/workspace/my-project.deepnote',
                projectId: 'project-456'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                multiNotebookProject,
                TreeItemCollapsibleState.Collapsed
            );

            assert.strictEqual(item.label, 'my-project.deepnote');
            assert.strictEqual(item.type, DeepnoteTreeItemType.ProjectFile);
            assert.strictEqual(item.collapsibleState, TreeItemCollapsibleState.Collapsed);
            assert.strictEqual(item.contextValue, 'projectFile');
            assert.strictEqual(item.tooltip, 'Deepnote Project: Test Project\nFile: /workspace/my-project.deepnote');
            assert.strictEqual(item.description, '0 cells');

            // Should have file-code icon for project files
            assert.instanceOf(item.iconPath, ThemeIcon);
            assert.strictEqual((item.iconPath as ThemeIcon).id, 'file-code');

            // Should have command for project files
            assert.isDefined(item.command);
            assert.strictEqual(item.command!.command, 'deepnote.openNotebook');
        });

        test('should handle project with three notebooks', () => {
            const projectWithMultipleNotebooks: DeepnoteProject = {
                ...multiNotebookProject,
                project: {
                    ...multiNotebookProject.project,
                    notebooks: [
                        {
                            id: 'notebook-1',
                            name: 'First',
                            blocks: [],
                            executionMode: 'block' as const,
                            isModule: false
                        },
                        {
                            id: 'notebook-2',
                            name: 'Second',
                            blocks: [],
                            executionMode: 'block' as const,
                            isModule: false
                        },
                        {
                            id: 'notebook-3',
                            name: 'Third',
                            blocks: [],
                            executionMode: 'block' as const,
                            isModule: false
                        }
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

            assert.strictEqual(item.description, '0 cells');
            assert.strictEqual(item.label, 'project.deepnote');
            assert.strictEqual(item.contextValue, 'projectFile');
        });

        test('should handle project with no notebooks (label falls back to basename)', () => {
            const projectWithNoNotebooks = {
                ...multiNotebookProject,
                project: {
                    ...multiNotebookProject.project,
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

            assert.strictEqual(item.description, '0 cells');
            assert.strictEqual(item.label, 'project.deepnote');
            assert.strictEqual(item.contextValue, 'projectFile');
        });

        test('should handle unnamed project', () => {
            const unnamedProject = {
                ...multiNotebookProject,
                project: {
                    ...multiNotebookProject.project,
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

            assert.strictEqual(item.label, 'project.deepnote');
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
            assert.strictEqual(item.tooltip, 'Notebook: Analysis Notebook\nExecution Mode: block');
            assert.strictEqual(item.description, '1 cell');

            // Should have file-code icon for notebooks
            assert.instanceOf(item.iconPath, ThemeIcon);
            assert.strictEqual((item.iconPath as ThemeIcon).id, 'file-code');

            // Should have open notebook command
            assert.isDefined(item.command);
            assert.strictEqual(item.command!.command, 'deepnote.openNotebook');
            assert.strictEqual(item.command!.title, 'Open Notebook');
            assert.deepStrictEqual(item.command!.arguments, [context]);

            // Should not have resource URI
            assert.isUndefined(item.resourceUri);
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
                        metadata: {},
                        type: 'code' as const
                    },
                    {
                        blockGroup: 'group-123',
                        id: 'block-2',
                        content: '# Analysis',
                        sortingKey: 'a1',
                        metadata: {},
                        type: 'markdown' as const
                    },
                    {
                        blockGroup: 'group-123',
                        id: 'block-3',
                        content: 'df = pd.read_csv("data.csv")',
                        sortingKey: 'a2',
                        metadata: {},
                        type: 'code' as const
                    },
                    {
                        blockGroup: 'group-123',
                        id: 'block-4',
                        content: 'print(df.head())',
                        sortingKey: 'a3',
                        metadata: {},
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

            // Multi-notebook project file -> contextValue 'projectFile'
            const projectItem = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                baseContext,
                multiNotebookProject,
                TreeItemCollapsibleState.Collapsed
            );

            // Single-notebook project file -> contextValue 'notebookFile'
            const notebookFileItem = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                baseContext,
                singleNotebookProject,
                TreeItemCollapsibleState.None
            );

            const notebookItem = new DeepnoteTreeItem(
                DeepnoteTreeItemType.Notebook,
                { ...baseContext, notebookId: 'notebook-1' },
                mockNotebook,
                TreeItemCollapsibleState.None
            );

            assert.strictEqual(projectItem.contextValue, 'projectFile');
            assert.strictEqual(notebookFileItem.contextValue, NOTEBOOK_FILE_CONTEXT_VALUE);
            assert.strictEqual(notebookItem.contextValue, 'notebook');
        });
    });

    suite('command configuration', () => {
        test('should create command for project files', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                multiNotebookProject,
                TreeItemCollapsibleState.Collapsed
            );

            assert.isDefined(item.command);
            assert.strictEqual(item.command!.command, 'deepnote.openNotebook');
            assert.strictEqual(item.command!.title, 'Open Notebook');
            assert.deepStrictEqual(item.command!.arguments, [context]);
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
        test('should use file-code icon for project files', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                multiNotebookProject,
                TreeItemCollapsibleState.Collapsed
            );

            assert.instanceOf(item.iconPath, ThemeIcon);
            assert.strictEqual((item.iconPath as ThemeIcon).id, 'file-code');
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
                ...multiNotebookProject,
                project: {
                    ...multiNotebookProject.project,
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

            const notebookWithDetails: DeepnoteNotebook = {
                ...mockNotebook,
                name: 'Data Analysis',
                executionMode: 'block'
            };

            const notebookItem = new DeepnoteTreeItem(
                DeepnoteTreeItemType.Notebook,
                context,
                notebookWithDetails,
                TreeItemCollapsibleState.None
            );

            assert.strictEqual(notebookItem.tooltip, 'Notebook: Data Analysis\nExecution Mode: block');
        });

        test('should handle special characters in names', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/test/project.deepnote',
                projectId: 'project-123',
                notebookId: 'notebook-456'
            };

            const notebookWithSpecialChars: DeepnoteNotebook = {
                ...mockNotebook,
                name: 'Notebook with "quotes" & special chars',
                executionMode: 'block'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.Notebook,
                context,
                notebookWithSpecialChars,
                TreeItemCollapsibleState.None
            );

            assert.strictEqual(item.tooltip, 'Notebook: Notebook with "quotes" & special chars\nExecution Mode: block');
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

    suite('Loading type', () => {
        test('should create loading item with null data', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '',
                projectId: ''
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.Loading,
                context,
                null,
                TreeItemCollapsibleState.None
            );

            assert.strictEqual(item.type, DeepnoteTreeItemType.Loading);
            assert.strictEqual(item.contextValue, 'loading');
            assert.strictEqual(item.collapsibleState, TreeItemCollapsibleState.None);
            assert.isNull(item.data);
        });

        test('should set minimal visuals for loading items', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '',
                projectId: ''
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.Loading,
                context,
                null,
                TreeItemCollapsibleState.None
            );

            // Loading items should have minimal visuals set to show a readable placeholder
            assert.isDefined(item);
            assert.strictEqual(item.type, DeepnoteTreeItemType.Loading);

            // Verify minimal visuals are set
            assert.strictEqual(item.label, 'Loading…');
            assert.strictEqual(item.tooltip, 'Loading…');
            assert.strictEqual(item.description, '');
            assert.isDefined(item.iconPath);
        });
    });

    suite('updateVisualFields', () => {
        // VS Code's mock TreeItem is a Proxy-based class (see build/mocha-esm-loader.js);
        // when DeepnoteTreeItem extends it, `super(...)` creates a plain TreeItem-mock
        // instance rather than a DeepnoteTreeItem, so instance methods on the subclass
        // prototype are NOT reachable via the usual `item.updateVisualFields()` call.
        // We invoke the method by reading it off the class prototype and calling it on
        // the instance — same behavior, just side-steps the proxy's prototype chain loss.
        function callUpdateVisualFields(item: DeepnoteTreeItem): void {
            const method = DeepnoteTreeItem.prototype.updateVisualFields;

            assert.isFunction(method, 'updateVisualFields should be defined on the prototype');
            method.call(item);
        }

        test('should keep notebook label and notebookFile contextValue for single-notebook ProjectFile', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/workspace/my-project.deepnote',
                projectId: 'project-456'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                singleNotebookProject,
                TreeItemCollapsibleState.None
            );

            // Pre-conditions set in constructor
            assert.strictEqual(item.label, 'First Notebook');
            assert.strictEqual(item.contextValue, NOTEBOOK_FILE_CONTEXT_VALUE);

            callUpdateVisualFields(item);

            assert.strictEqual(item.label, 'First Notebook');
            assert.strictEqual(item.contextValue, NOTEBOOK_FILE_CONTEXT_VALUE);
        });

        test('should keep file basename label and projectFile contextValue for multi-notebook ProjectFile', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/workspace/my-project.deepnote',
                projectId: 'project-456'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                multiNotebookProject,
                TreeItemCollapsibleState.Collapsed
            );

            // Pre-conditions set in constructor
            assert.strictEqual(item.label, 'my-project.deepnote');
            assert.strictEqual(item.contextValue, 'projectFile');

            callUpdateVisualFields(item);

            assert.strictEqual(item.label, 'my-project.deepnote');
            assert.strictEqual(item.contextValue, 'projectFile');
        });

        test('should flip contextValue back to projectFile when data is mutated from single to multi notebook', () => {
            const context: DeepnoteTreeItemContext = {
                filePath: '/workspace/my-project.deepnote',
                projectId: 'project-456'
            };

            const item = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                singleNotebookProject,
                TreeItemCollapsibleState.None
            );

            assert.strictEqual(item.contextValue, NOTEBOOK_FILE_CONTEXT_VALUE);

            // Mutate data to a multi-notebook project
            item.data = multiNotebookProject;
            callUpdateVisualFields(item);

            assert.strictEqual(item.contextValue, 'projectFile');
            assert.strictEqual(item.label, 'my-project.deepnote');
        });
    });

    suite('getSingleNonInitNotebook', () => {
        test('returns the sole non-init notebook when there is exactly one', () => {
            const result = getSingleNonInitNotebook(singleNotebookProject);

            assert.isDefined(result);
            assert.strictEqual(result!.id, 'notebook-1');
            assert.strictEqual(result!.name, 'First Notebook');
        });

        test('returns undefined when there are multiple non-init notebooks', () => {
            assert.isUndefined(getSingleNonInitNotebook(multiNotebookProject));
        });

        test('returns undefined when there are zero notebooks', () => {
            const empty: DeepnoteProject = {
                ...singleNotebookProject,
                project: { ...singleNotebookProject.project, notebooks: [] }
            };

            assert.isUndefined(getSingleNonInitNotebook(empty));
        });

        test('excludes init notebook from the non-init count', () => {
            const projectWithInitAndOneNotebook: DeepnoteProject = {
                ...singleNotebookProject,
                project: {
                    ...singleNotebookProject.project,
                    initNotebookId: 'init-nb',
                    notebooks: [
                        {
                            id: 'init-nb',
                            name: 'Init',
                            blocks: [],
                            executionMode: 'block',
                            isModule: false
                        },
                        {
                            id: 'notebook-1',
                            name: 'Real',
                            blocks: [],
                            executionMode: 'block',
                            isModule: false
                        }
                    ]
                }
            };

            const result = getSingleNonInitNotebook(projectWithInitAndOneNotebook);

            assert.isDefined(result);
            assert.strictEqual(result!.id, 'notebook-1');
        });
    });

    suite('integration scenarios', () => {
        test('should create valid tree structure hierarchy', () => {
            // Create parent project file (multi-notebook so it stays a projectFile row)
            const projectContext: DeepnoteTreeItemContext = {
                filePath: '/workspace/research-project.deepnote',
                projectId: 'research-123'
            };

            const projectItem = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                projectContext,
                multiNotebookProject,
                TreeItemCollapsibleState.Expanded
            );

            // Create child notebook items
            const notebooks: Array<{ context: DeepnoteTreeItemContext; data: DeepnoteNotebook }> = [
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
                        executionMode: 'block',
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
                        executionMode: 'block',
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
                        multiNotebookProject,
                        TreeItemCollapsibleState.Collapsed
                    )
            );

            // Verify each item has correct file path
            items.forEach((item, index) => {
                assert.strictEqual(item.context.filePath, contexts[index].filePath);
                assert.strictEqual(item.context.projectId, contexts[index].projectId);
                assert.isDefined(item.command); // Project files have commands
                assert.strictEqual(item.command!.command, 'deepnote.openNotebook');
            });
        });
    });
});
