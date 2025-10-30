import { assert } from 'chai';
import * as yaml from 'js-yaml';

import { DeepnoteNotebookSerializer } from './deepnoteSerializer';
import { DeepnoteNotebookManager } from './deepnoteNotebookManager';
import { DeepnoteDataConverter } from './deepnoteDataConverter';
import type { DeepnoteFile, DeepnoteProject } from '../../platform/deepnote/deepnoteTypes';

suite('DeepnoteNotebookSerializer', () => {
    let serializer: DeepnoteNotebookSerializer;
    let manager: DeepnoteNotebookManager;

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
                            sortingKey: 'a1',
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
        manager = new DeepnoteNotebookManager();
        serializer = new DeepnoteNotebookSerializer(manager);
    });

    /**
     * Helper function to convert a DeepnoteProject object with version to YAML format
     */
    function projectToYaml(projectData: DeepnoteFile): Uint8Array {
        const yamlString = yaml.dump(projectData);
        return new TextEncoder().encode(yamlString);
    }

    suite('deserializeNotebook', () => {
        test('should deserialize valid project with selected notebook', async () => {
            // Set up the manager to select the first notebook
            manager.selectNotebookForProject('project-123', 'notebook-1');

            const yamlContent = `
version: 1.0
metadata:
  createdAt: '2023-01-01T00:00:00Z'
  modifiedAt: '2023-01-02T00:00:00Z'
project:
  id: 'project-123'
  name: 'Test Project'
  notebooks:
    - id: 'notebook-1'
      name: 'First Notebook'
      blocks:
        - id: 'block-1'
          content: 'print("hello")'
          sortingKey: 'a0'
          type: 'code'
      executionMode: 'block'
      isModule: false
  settings: {}
`;

            const content = new TextEncoder().encode(yamlContent);
            const result = await serializer.deserializeNotebook(content, {} as any);

            // Should return a proper NotebookData object
            assert.isDefined(result);
            assert.isDefined(result.cells);
            assert.isArray(result.cells);
            assert.strictEqual(result.cells.length, 1);
            assert.strictEqual(result.metadata?.deepnoteProjectId, 'project-123');
            assert.strictEqual(result.metadata?.deepnoteNotebookId, 'notebook-1');
        });

        test('should throw error for empty content', async () => {
            const emptyContent = new TextEncoder().encode('');

            await assert.isRejected(
                serializer.deserializeNotebook(emptyContent, {} as any),
                /Failed to parse Deepnote file/
            );
        });

        test('should throw error for invalid YAML', async () => {
            const invalidContent = new TextEncoder().encode('invalid yaml: [unclosed bracket');

            await assert.isRejected(
                serializer.deserializeNotebook(invalidContent, {} as any),
                /Failed to parse Deepnote file/
            );
        });

        test('should throw error when no notebooks found', async () => {
            const contentWithoutNotebooks = new TextEncoder().encode(`
version: 1.0
project:
  id: 'project-123'
  name: 'Test Project'
  settings: {}
`);

            await assert.isRejected(
                serializer.deserializeNotebook(contentWithoutNotebooks, {} as any),
                /Invalid Deepnote file: no notebooks found/
            );
        });
    });

    suite('serializeNotebook', () => {
        test('should throw error when no project ID in metadata', async () => {
            const mockNotebookData = {
                cells: [],
                metadata: {}
            };

            await assert.isRejected(
                serializer.serializeNotebook(mockNotebookData, {} as any),
                /Missing Deepnote project ID in notebook metadata/
            );
        });

        test('should throw error when original project not found', async () => {
            const mockNotebookData = {
                cells: [],
                metadata: {
                    deepnoteProjectId: 'unknown-project',
                    deepnoteNotebookId: 'notebook-1'
                }
            };

            await assert.isRejected(
                serializer.serializeNotebook(mockNotebookData, {} as any),
                /Original Deepnote project not found/
            );
        });

        test('should serialize notebook when original project exists', async () => {
            // First store the original project
            manager.storeOriginalProject('project-123', mockProject, 'notebook-1');

            const mockNotebookData = {
                cells: [
                    {
                        kind: 2, // NotebookCellKind.Code
                        value: 'print("updated code")',
                        languageId: 'python',
                        metadata: {}
                    }
                ],
                metadata: {
                    deepnoteProjectId: 'project-123',
                    deepnoteNotebookId: 'notebook-1'
                }
            };

            const result = await serializer.serializeNotebook(mockNotebookData as any, {} as any);

            assert.instanceOf(result, Uint8Array);

            // Verify the result is valid YAML
            const yamlString = new TextDecoder().decode(result);
            assert.include(yamlString, 'project-123');
            assert.include(yamlString, 'notebook-1');
        });
    });

    suite('findCurrentNotebookId', () => {
        test('should return stored notebook ID when available', () => {
            manager.selectNotebookForProject('project-123', 'notebook-456');

            const result = serializer.findCurrentNotebookId('project-123');

            assert.strictEqual(result, 'notebook-456');
        });

        test('should return undefined for unknown project', () => {
            const result = serializer.findCurrentNotebookId('unknown-project');

            assert.strictEqual(result, undefined);
        });

        test('should prioritize stored selection over fallback', () => {
            manager.selectNotebookForProject('project-123', 'stored-notebook');

            const result = serializer.findCurrentNotebookId('project-123');

            assert.strictEqual(result, 'stored-notebook');
        });

        test('should handle multiple projects independently', () => {
            manager.selectNotebookForProject('project-1', 'notebook-1');
            manager.selectNotebookForProject('project-2', 'notebook-2');

            const result1 = serializer.findCurrentNotebookId('project-1');
            const result2 = serializer.findCurrentNotebookId('project-2');

            assert.strictEqual(result1, 'notebook-1');
            assert.strictEqual(result2, 'notebook-2');
        });
    });

    suite('component integration', () => {
        test('should maintain component references', () => {
            const internalManager = (serializer as any).notebookManager;
            const converter = (serializer as any).converter;

            // Verify references are consistent
            assert.strictEqual(manager, internalManager);
            assert.isDefined(converter);

            // Verify types
            assert.instanceOf(manager, DeepnoteNotebookManager);
            assert.instanceOf(converter, DeepnoteDataConverter);
        });

        test('should handle data conversion workflows', () => {
            const converter = (serializer as any).converter;

            // Test that converter methods exist
            assert.isFunction(converter.convertBlocksToCells, 'has convertBlocksToCells method');
            assert.isFunction(converter.convertCellsToBlocks, 'has convertCellsToBlocks method');
        });

        test('should handle manager state operations', () => {
            assert.isFunction(manager.getCurrentNotebookId, 'has getCurrentNotebookId method');
            assert.isFunction(manager.getOriginalProject, 'has getOriginalProject method');
            assert.isFunction(
                manager.getTheSelectedNotebookForAProject,
                'has getTheSelectedNotebookForAProject method'
            );
            assert.isFunction(manager.selectNotebookForProject, 'has selectNotebookForProject method');
            assert.isFunction(manager.storeOriginalProject, 'has storeOriginalProject method');
        });

        test('should have findCurrentNotebookId method', () => {
            assert.isFunction(serializer.findCurrentNotebookId, 'has findCurrentNotebookId method');
        });
    });

    suite('data structure handling', () => {
        test('should work with project data structures', () => {
            // Verify the mock project structure is well-formed
            assert.isDefined(mockProject.project);
            assert.isDefined(mockProject.project.notebooks);
            assert.strictEqual(mockProject.project.notebooks.length, 2);

            const firstNotebook = mockProject.project.notebooks[0];
            assert.strictEqual(firstNotebook.name, 'First Notebook');
            assert.strictEqual(firstNotebook.blocks.length, 1);
            assert.strictEqual(firstNotebook.blocks[0].type, 'code');
        });

        test('should handle notebook metadata', () => {
            const notebook = mockProject.project.notebooks[0];

            assert.strictEqual(notebook.executionMode, 'block');
            assert.strictEqual(notebook.isModule, false);
            assert.isDefined(notebook.blocks);
            assert.isArray(notebook.blocks);
        });
    });

    suite('integration scenarios', () => {
        test('should maintain independence between serializer instances', () => {
            const manager1 = new DeepnoteNotebookManager();
            const manager2 = new DeepnoteNotebookManager();
            const serializer1 = new DeepnoteNotebookSerializer(manager1);
            const serializer2 = new DeepnoteNotebookSerializer(manager2);

            // Verify serializers are independent
            assert.notStrictEqual(serializer1, serializer2);
            assert.notStrictEqual(manager1, manager2);

            assert.instanceOf(manager1, DeepnoteNotebookManager);
            assert.instanceOf(manager2, DeepnoteNotebookManager);
            assert.notStrictEqual(manager1, manager2);
        });

        test('should handle serializer lifecycle', () => {
            const testManager = new DeepnoteNotebookManager();
            const testSerializer = new DeepnoteNotebookSerializer(testManager);

            // Verify serializer has expected interface
            assert.isFunction(testSerializer.deserializeNotebook, 'has deserializeNotebook method');
            assert.isFunction(testSerializer.serializeNotebook, 'has serializeNotebook method');

            // Verify manager is accessible
            assert.instanceOf(testManager, DeepnoteNotebookManager);
        });
    });

    suite('default notebook selection', () => {
        test('should not select Init notebook when other notebooks are available', async () => {
            const projectData: DeepnoteFile = {
                version: '1.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-with-init',
                    name: 'Project with Init',
                    initNotebookId: 'init-notebook',
                    notebooks: [
                        {
                            id: 'init-notebook',
                            name: 'Init',
                            blocks: [
                                {
                                    id: 'block-init',
                                    content: 'print("init")',
                                    sortingKey: 'a0',
                                    type: 'code'
                                }
                            ],
                            executionMode: 'block',
                            isModule: false
                        },
                        {
                            id: 'main-notebook',
                            name: 'Main',
                            blocks: [
                                {
                                    id: 'block-main',
                                    content: 'print("main")',
                                    sortingKey: 'a0',
                                    type: 'code'
                                }
                            ],
                            executionMode: 'block',
                            isModule: false
                        }
                    ],
                    settings: {}
                }
            };

            const content = projectToYaml(projectData);
            const result = await serializer.deserializeNotebook(content, {} as any);

            // Should select the Main notebook, not the Init notebook
            assert.strictEqual(result.metadata?.deepnoteNotebookId, 'main-notebook');
            assert.strictEqual(result.metadata?.deepnoteNotebookName, 'Main');
        });

        test('should select Init notebook when it is the only notebook', async () => {
            const projectData: DeepnoteFile = {
                version: '1.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-only-init',
                    name: 'Project with only Init',
                    initNotebookId: 'init-notebook',
                    notebooks: [
                        {
                            id: 'init-notebook',
                            name: 'Init',
                            blocks: [
                                {
                                    id: 'block-init',
                                    content: 'print("init")',
                                    sortingKey: 'a0',
                                    type: 'code'
                                }
                            ],
                            executionMode: 'block',
                            isModule: false
                        }
                    ],
                    settings: {}
                }
            };

            const content = projectToYaml(projectData);
            const result = await serializer.deserializeNotebook(content, {} as any);

            // Should select the Init notebook since it's the only one
            assert.strictEqual(result.metadata?.deepnoteNotebookId, 'init-notebook');
            assert.strictEqual(result.metadata?.deepnoteNotebookName, 'Init');
        });

        test('should select alphabetically first notebook when no initNotebookId', async () => {
            const projectData: DeepnoteFile = {
                version: '1.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-alphabetical',
                    name: 'Project Alphabetical',
                    notebooks: [
                        {
                            id: 'zebra-notebook',
                            name: 'Zebra Notebook',
                            blocks: [
                                {
                                    id: 'block-z',
                                    content: 'print("zebra")',
                                    sortingKey: 'a0',
                                    type: 'code'
                                }
                            ],
                            executionMode: 'block',
                            isModule: false
                        },
                        {
                            id: 'alpha-notebook',
                            name: 'Alpha Notebook',
                            blocks: [
                                {
                                    id: 'block-a',
                                    content: 'print("alpha")',
                                    sortingKey: 'a0',
                                    type: 'code'
                                }
                            ],
                            executionMode: 'block',
                            isModule: false
                        },
                        {
                            id: 'bravo-notebook',
                            name: 'Bravo Notebook',
                            blocks: [
                                {
                                    id: 'block-b',
                                    content: 'print("bravo")',
                                    sortingKey: 'a0',
                                    type: 'code'
                                }
                            ],
                            executionMode: 'block',
                            isModule: false
                        }
                    ],
                    settings: {}
                }
            };

            const content = projectToYaml(projectData);
            const result = await serializer.deserializeNotebook(content, {} as any);

            // Should select the alphabetically first notebook
            assert.strictEqual(result.metadata?.deepnoteNotebookId, 'alpha-notebook');
            assert.strictEqual(result.metadata?.deepnoteNotebookName, 'Alpha Notebook');
        });

        test('should sort Init notebook last when multiple notebooks exist', async () => {
            const projectData: DeepnoteFile = {
                version: '1.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-multiple',
                    name: 'Project with Multiple',
                    initNotebookId: 'init-notebook',
                    notebooks: [
                        {
                            id: 'charlie-notebook',
                            name: 'Charlie',
                            blocks: [
                                {
                                    id: 'block-c',
                                    content: 'print("charlie")',
                                    sortingKey: 'a0',
                                    type: 'code'
                                }
                            ],
                            executionMode: 'block',
                            isModule: false
                        },
                        {
                            id: 'init-notebook',
                            name: 'Init',
                            blocks: [
                                {
                                    id: 'block-init',
                                    content: 'print("init")',
                                    sortingKey: 'a0',
                                    type: 'code'
                                }
                            ],
                            executionMode: 'block',
                            isModule: false
                        },
                        {
                            id: 'alpha-notebook',
                            name: 'Alpha',
                            blocks: [
                                {
                                    id: 'block-a',
                                    content: 'print("alpha")',
                                    sortingKey: 'a0',
                                    type: 'code'
                                }
                            ],
                            executionMode: 'block',
                            isModule: false
                        }
                    ],
                    settings: {}
                }
            };

            const content = projectToYaml(projectData);
            const result = await serializer.deserializeNotebook(content, {} as any);

            // Should select Alpha, not Init even though "Init" comes before "Alpha" alphabetically when in upper case
            assert.strictEqual(result.metadata?.deepnoteNotebookId, 'alpha-notebook');
            assert.strictEqual(result.metadata?.deepnoteNotebookName, 'Alpha');
        });
    });
});
