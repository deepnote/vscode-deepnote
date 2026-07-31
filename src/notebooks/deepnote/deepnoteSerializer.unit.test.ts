import { deserializeDeepnoteFile, serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { assert } from 'chai';
import { parse as parseYaml } from 'yaml';

import { DeepnoteNotebookSerializer } from './deepnoteSerializer';
import { DeepnoteNotebookManager } from './deepnoteNotebookManager';
import { DeepnoteDataConverter } from './deepnoteDataConverter';

suite('DeepnoteNotebookSerializer', () => {
    let serializer: DeepnoteNotebookSerializer;
    let manager: DeepnoteNotebookManager;

    const mockProject: DeepnoteFile = {
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
                            sortingKey: 'a1',
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
        manager = new DeepnoteNotebookManager();
        serializer = new DeepnoteNotebookSerializer(manager);
    });

    /**
     * Helper function to convert a DeepnoteFile object with version to YAML format
     */
    function projectToYaml(projectData: DeepnoteFile): Uint8Array {
        const yamlString = serializeDeepnoteFile(projectData);
        return new TextEncoder().encode(yamlString);
    }

    suite('deserializeNotebook', () => {
        test('should deserialize valid project with selected notebook', async () => {
            const yamlContent = `
version: '1.0.0'
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
          blockGroup: 'group-1'
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
version: '1.0.0'
metadata:
  createdAt: '2023-01-01T00:00:00Z'
project:
  id: 'project-123'
  name: 'Test Project'
  notebooks: []
  settings: {}
`);

            await assert.isRejected(
                serializer.deserializeNotebook(contentWithoutNotebooks, {} as any),
                /no notebooks|notebooks.*must contain at least 1/i
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
                /Cannot determine which notebook to save/
            );
        });

        test('should throw error when notebook ID is missing from metadata', async () => {
            const mockNotebookData = {
                cells: [],
                metadata: {
                    deepnoteProjectId: 'project-123'
                }
            };

            await assert.isRejected(
                serializer.serializeNotebook(mockNotebookData, {} as any),
                /Cannot determine which notebook to save/
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
            manager.storeOriginalProject('project-123', 'notebook-1', mockProject);

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

        test('should exclude ephemeral cells from serialized output', async () => {
            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-ephemeral-exclude',
                    name: 'Ephemeral Exclude Test',
                    notebooks: [
                        {
                            id: 'notebook-1',
                            name: 'Test Notebook',
                            blocks: [
                                {
                                    id: 'block-1',
                                    content: 'print("persisted")',
                                    blockGroup: 'group-1',
                                    metadata: {},
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

            manager.storeOriginalProject('project-ephemeral-exclude', 'notebook-1', projectData);

            const mockNotebookData = {
                cells: [
                    {
                        kind: 2,
                        value: 'print("persisted")',
                        languageId: 'python',
                        metadata: { id: 'block-1' }
                    },
                    {
                        kind: 2,
                        value: 'print("ephemeral - should not persist")',
                        languageId: 'python',
                        metadata: { id: 'ephemeral-block', is_ephemeral: true }
                    }
                ],
                metadata: {
                    deepnoteProjectId: 'project-ephemeral-exclude',
                    deepnoteNotebookId: 'notebook-1'
                }
            };

            const result = await serializer.serializeNotebook(mockNotebookData as any, {} as any);
            const yamlString = new TextDecoder().decode(result);
            const parsedResult = deserializeDeepnoteFile(yamlString);

            const notebook = parsedResult.project.notebooks.find((nb) => nb.id === 'notebook-1');
            assert.isDefined(notebook);
            assert.strictEqual(notebook!.blocks.length, 1, 'Ephemeral cell should be excluded');
            assert.strictEqual(notebook!.blocks[0].content, 'print("persisted")');
        });

        suite('correct-sibling save (Chunk 2 anti-regression)', () => {
            const sharedProjectId = 'shared-project';
            const nbA = 'sibling-a';
            const nbB = 'sibling-b';

            // Two siblings of ONE project: same project.id, distinct single notebook each, with
            // distinguishable block ids/content so the serialized output reveals which one was saved.
            function siblingFile(notebookId: string, blockId: string, content: string): DeepnoteFile {
                return {
                    version: '1.0.0',
                    metadata: {
                        createdAt: '2023-01-01T00:00:00Z',
                        modifiedAt: '2023-01-02T00:00:00Z'
                    },
                    project: {
                        id: sharedProjectId,
                        name: 'Shared Project',
                        notebooks: [
                            {
                                id: notebookId,
                                name: notebookId,
                                blocks: [
                                    {
                                        id: blockId,
                                        content,
                                        sortingKey: 'a0',
                                        blockGroup: '1',
                                        metadata: {},
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
            }

            test('catches wrong-sibling save: with both siblings cached under one projectId, saving notebookId=B writes sibling B (not A)', async () => {
                manager.storeOriginalProject(sharedProjectId, nbA, siblingFile(nbA, 'block-a', 'print("A")'));
                manager.storeOriginalProject(sharedProjectId, nbB, siblingFile(nbB, 'block-b', 'print("B")'));

                // The document's metadata identifies sibling B; its cell carries B's block id.
                const notebookData = {
                    cells: [
                        {
                            kind: 2,
                            value: 'print("B")',
                            languageId: 'python',
                            metadata: { id: 'block-b' }
                        }
                    ],
                    metadata: {
                        deepnoteProjectId: sharedProjectId,
                        deepnoteNotebookId: nbB
                    }
                };

                const result = await serializer.serializeNotebook(notebookData as any, {} as any);
                const parsed = deserializeDeepnoteFile(new TextDecoder().decode(result));

                // Exactly sibling B's single notebook is serialized — never sibling A's.
                assert.strictEqual(parsed.project.notebooks.length, 1);
                assert.strictEqual(parsed.project.notebooks[0].id, nbB);
                assert.strictEqual(parsed.project.notebooks[0].blocks[0].id, 'block-b');
                assert.notStrictEqual(parsed.project.notebooks[0].id, nbA);
            });

            test('catches save-against-wrong-sibling-on-cache-miss: when only sibling A is cached, saving notebookId=B throws the clear error instead of saving against A', async () => {
                // Only sibling A is cached; the document is sibling B. An exact (projectId, notebookId)
                // lookup must miss and throw — it must NOT fall back to A (which shares project.id).
                manager.storeOriginalProject(sharedProjectId, nbA, siblingFile(nbA, 'block-a', 'print("A")'));

                const notebookData = {
                    cells: [
                        {
                            kind: 2,
                            value: 'print("B")',
                            languageId: 'python',
                            metadata: { id: 'block-b' }
                        }
                    ],
                    metadata: {
                        deepnoteProjectId: sharedProjectId,
                        deepnoteNotebookId: nbB
                    }
                };

                await assert.isRejected(
                    serializer.serializeNotebook(notebookData as any, {} as any),
                    /Original Deepnote project not found/
                );
            });
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
            assert.isFunction(manager.getProjectForNotebook, 'has getProjectForNotebook method');
            assert.isFunction(manager.storeOriginalProject, 'has storeOriginalProject method');
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

    suite('circular reference handling', () => {
        test('should serialize notebook with circular references in output metadata', async () => {
            // Create output with circular reference - this reproduces the bug
            // where saving fails with "Maximum call stack size exceeded"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const circularOutput: any = {
                output_type: 'execute_result',
                execution_count: 1,
                data: { 'text/plain': 'test' },
                metadata: {}
            };
            // Create circular reference
            circularOutput.metadata.self = circularOutput;

            const projectWithCircularRef: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-circular',
                    name: 'Circular Test',
                    notebooks: [
                        {
                            id: 'notebook-1',
                            name: 'Test Notebook',
                            blocks: [
                                {
                                    blockGroup: 'group-1',
                                    id: 'block-1',
                                    content: 'test',
                                    sortingKey: 'a0',
                                    metadata: {},
                                    type: 'code',
                                    outputs: [circularOutput]
                                }
                            ],
                            executionMode: 'block',
                            isModule: false
                        }
                    ],
                    settings: {}
                }
            };

            manager.storeOriginalProject('project-circular', 'notebook-1', projectWithCircularRef);

            const notebookData = {
                cells: [
                    {
                        kind: 2, // NotebookCellKind.Code
                        value: 'test',
                        languageId: 'python',
                        metadata: {}
                    }
                ],
                metadata: {
                    deepnoteProjectId: 'project-circular',
                    deepnoteNotebookId: 'notebook-1'
                }
            };

            // Should successfully serialize even with circular references
            const result = await serializer.serializeNotebook(notebookData as any, {} as any);

            assert.instanceOf(result, Uint8Array);
            const yamlString = new TextDecoder().decode(result);
            assert.include(yamlString, 'project-circular');
        });
    });

    suite('block ID preservation', () => {
        test('should preserve block IDs when serializing cells with proper metadata', async () => {
            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-id-test',
                    name: 'ID Test Project',
                    notebooks: [
                        {
                            id: 'notebook-1',
                            name: 'Test Notebook',
                            blocks: [
                                {
                                    blockGroup: 'group-1',
                                    id: 'original-block-id-1',
                                    content: 'print("hello")',
                                    sortingKey: 'a0',
                                    metadata: {},
                                    type: 'code'
                                },
                                {
                                    blockGroup: 'group-2',
                                    id: 'original-block-id-2',
                                    content: '# Markdown',
                                    sortingKey: 'a1',
                                    metadata: {},
                                    type: 'markdown'
                                }
                            ],
                            executionMode: 'block',
                            isModule: false
                        }
                    ],
                    settings: {}
                }
            };

            // Store the project
            manager.storeOriginalProject('project-id-test', 'notebook-1', projectData);

            // Create cells with the EXACT metadata structure that deserializeNotebook produces
            // This simulates what VS Code should preserve from deserialization
            const notebookData = {
                cells: [
                    {
                        kind: 2, // NotebookCellKind.Code
                        value: 'print("hello")',
                        languageId: 'python',
                        metadata: {
                            id: 'original-block-id-1',
                            __deepnoteBlockId: 'original-block-id-1',
                            __deepnotePocket: {
                                blockGroup: 'group-1',
                                type: 'code',
                                sortingKey: 'a0'
                            }
                        }
                    },
                    {
                        kind: 1, // NotebookCellKind.Markup
                        value: '# Markdown',
                        languageId: 'markdown',
                        metadata: {
                            id: 'original-block-id-2',
                            __deepnoteBlockId: 'original-block-id-2',
                            __deepnotePocket: {
                                blockGroup: 'group-2',
                                type: 'markdown',
                                sortingKey: 'a1'
                            }
                        }
                    }
                ],
                metadata: {
                    deepnoteProjectId: 'project-id-test',
                    deepnoteNotebookId: 'notebook-1'
                }
            };

            const result = await serializer.serializeNotebook(notebookData as any, {} as any);
            const yamlString = new TextDecoder().decode(result);
            const parsedResult = deserializeDeepnoteFile(yamlString);

            const notebook = parsedResult.project.notebooks.find((nb) => nb.id === 'notebook-1');
            assert.isDefined(notebook);
            assert.strictEqual(notebook!.blocks.length, 2);

            // Verify block IDs are preserved
            assert.strictEqual(notebook!.blocks[0].id, 'original-block-id-1', 'First block ID should be preserved');
            assert.strictEqual(notebook!.blocks[1].id, 'original-block-id-2', 'Second block ID should be preserved');
        });

        test('should recover id and blockGroup via content matching when cells lack metadata', async () => {
            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-recover-ids',
                    name: 'Recover ID Test',
                    notebooks: [
                        {
                            id: 'notebook-1',
                            name: 'Test Notebook',
                            blocks: [
                                {
                                    blockGroup: 'original-group',
                                    id: 'original-id',
                                    content: 'test',
                                    sortingKey: 'original-sorting-key',
                                    metadata: {},
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

            manager.storeOriginalProject('project-recover-ids', 'notebook-1', projectData);

            // Cells WITHOUT id metadata (simulating what VS Code might provide if it strips metadata)
            // But content matches the original block
            const notebookData = {
                cells: [
                    {
                        kind: 2,
                        value: 'test', // Same content as original block
                        languageId: 'python',
                        metadata: {} // No ID - this is the problem case!
                    }
                ],
                metadata: {
                    deepnoteProjectId: 'project-recover-ids',
                    deepnoteNotebookId: 'notebook-1'
                }
            };

            const result = await serializer.serializeNotebook(notebookData as any, {} as any);
            const yamlString = new TextDecoder().decode(result);
            const parsedResult = deserializeDeepnoteFile(yamlString);

            const notebook = parsedResult.project.notebooks.find((nb) => nb.id === 'notebook-1');
            assert.isDefined(notebook);

            // All key metadata should be recovered from original via content matching
            assert.strictEqual(notebook!.blocks[0].id, 'original-id', 'Block ID should be recovered');
            assert.strictEqual(
                notebook!.blocks[0].blockGroup,
                'original-group',
                'Block blockGroup should be recovered'
            );
        });

        test('should generate new IDs when content does not match any original block', async () => {
            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-new-content',
                    name: 'New Content Test',
                    notebooks: [
                        {
                            id: 'notebook-1',
                            name: 'Test Notebook',
                            blocks: [
                                {
                                    blockGroup: 'group-1',
                                    id: 'original-id',
                                    content: 'original content',
                                    sortingKey: 'a0',
                                    metadata: {},
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

            manager.storeOriginalProject('project-new-content', 'notebook-1', projectData);

            // Cell with different content than any original block
            const notebookData = {
                cells: [
                    {
                        kind: 2,
                        value: 'completely new content', // Different from original
                        languageId: 'python',
                        metadata: {}
                    }
                ],
                metadata: {
                    deepnoteProjectId: 'project-new-content',
                    deepnoteNotebookId: 'notebook-1'
                }
            };

            const result = await serializer.serializeNotebook(notebookData as any, {} as any);
            const yamlString = new TextDecoder().decode(result);
            const parsedResult = deserializeDeepnoteFile(yamlString);

            const notebook = parsedResult.project.notebooks.find((nb) => nb.id === 'notebook-1');
            assert.isDefined(notebook);

            // Block should have a newly generated ID since content doesn't match
            assert.isDefined(notebook!.blocks[0].id);
            assert.notStrictEqual(
                notebook!.blocks[0].id,
                'original-id',
                'Block ID should be newly generated when content differs'
            );
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
                version: '1.0.0',
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
                                    metadata: {},
                                    blockGroup: '1',
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
                                    metadata: {},
                                    blockGroup: '1',
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
                version: '1.0.0',
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
                                    blockGroup: '1',
                                    metadata: {},
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

        test('should select the first notebook when no initNotebookId', async () => {
            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-first',
                    name: 'Project First',
                    notebooks: [
                        {
                            id: 'zebra-notebook',
                            name: 'Zebra Notebook',
                            blocks: [
                                {
                                    id: 'block-z',
                                    content: 'print("zebra")',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
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
                                    blockGroup: '1',
                                    metadata: {},
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

            // Should select the first notebook in the file (no name-based sorting)
            assert.strictEqual(result.metadata?.deepnoteNotebookId, 'zebra-notebook');
            assert.strictEqual(result.metadata?.deepnoteNotebookName, 'Zebra Notebook');
        });

        test('should select the first non-init notebook when multiple notebooks exist', async () => {
            const projectData: DeepnoteFile = {
                version: '1.0.0',
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
                            id: 'init-notebook',
                            name: 'Init',
                            blocks: [
                                {
                                    id: 'block-init',
                                    content: 'print("init")',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
                                    type: 'code'
                                }
                            ],
                            executionMode: 'block',
                            isModule: false
                        },
                        {
                            id: 'charlie-notebook',
                            name: 'Charlie',
                            blocks: [
                                {
                                    id: 'block-c',
                                    content: 'print("charlie")',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
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
                                    blockGroup: '1',
                                    metadata: {},
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

            // Should select the first non-init notebook in file order (Charlie), skipping Init.
            assert.strictEqual(result.metadata?.deepnoteNotebookId, 'charlie-notebook');
            assert.strictEqual(result.metadata?.deepnoteNotebookName, 'Charlie');
        });
    });

    suite('first-non-init render (Chunk 2 use cases)', () => {
        // An [init, main] file where the init id matches project.initNotebookId.
        function initMainFile(): DeepnoteFile {
            return {
                version: '1.0.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-init-main',
                    name: 'Init + Main',
                    initNotebookId: 'init-notebook',
                    notebooks: [
                        {
                            id: 'init-notebook',
                            name: 'Init',
                            blocks: [
                                {
                                    id: 'init-block-1',
                                    content: 'import setup_only',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
                                    type: 'code'
                                },
                                {
                                    id: 'init-block-2',
                                    content: 'configure_environment()',
                                    sortingKey: 'a1',
                                    blockGroup: '1',
                                    metadata: {},
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
                                    id: 'main-block-1',
                                    content: 'print("main work")',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
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
        }

        test('catches init-first render: an [init, main] file renders main (not the init referenced by initNotebookId)', async () => {
            const content = projectToYaml(initMainFile());
            const result = await serializer.deserializeNotebook(content, {} as any);

            // The rendered notebook must be the main one, never the init.
            assert.strictEqual(result.metadata?.deepnoteNotebookId, 'main-notebook');
            assert.strictEqual(result.metadata?.deepnoteNotebookName, 'Main');
        });

        test('catches wrong-default render: a [main1, main2] file with no init renders the first (main1)', async () => {
            const file: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-two-mains',
                    name: 'Two Mains',
                    notebooks: [
                        {
                            id: 'main1',
                            name: 'Main One',
                            blocks: [
                                {
                                    id: 'm1-block',
                                    content: 'print("one")',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
                                    type: 'code'
                                }
                            ],
                            executionMode: 'block',
                            isModule: false
                        },
                        {
                            id: 'main2',
                            name: 'Main Two',
                            blocks: [
                                {
                                    id: 'm2-block',
                                    content: 'print("two")',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
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

            const content = projectToYaml(file);
            const result = await serializer.deserializeNotebook(content, {} as any);

            assert.strictEqual(result.metadata?.deepnoteNotebookId, 'main1');
            assert.strictEqual(result.metadata?.deepnoteNotebookName, 'Main One');
        });

        test('catches init composition at deserialize: an [init, main] file renders ONLY main blocks (init setup blocks are not merged)', async () => {
            const content = projectToYaml(initMainFile());
            const result = await serializer.deserializeNotebook(content, {} as any);

            // Exactly main's block count — init's two setup blocks are not composed in.
            assert.strictEqual(result.cells.length, 1, 'should render only the single main block');

            const renderedBlockIds = result.cells.map((cell) => cell.metadata?.id);
            assert.deepStrictEqual(renderedBlockIds, ['main-block-1']);

            // No init block id may leak into the rendered cells.
            assert.notInclude(renderedBlockIds, 'init-block-1');
            assert.notInclude(renderedBlockIds, 'init-block-2');

            // And the rendered content is main's, not init's setup code.
            const renderedValues = result.cells.map((cell) => cell.value);
            assert.deepStrictEqual(renderedValues, ['print("main work")']);
            assert.notInclude(renderedValues, 'import setup_only');
            assert.notInclude(renderedValues, 'configure_environment()');
        });

        test('catches lost init fallback: a standalone init file (the init is the only notebook) renders that init notebook', async () => {
            const file: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-standalone-init',
                    name: 'Standalone Init',
                    initNotebookId: 'init-notebook',
                    notebooks: [
                        {
                            id: 'init-notebook',
                            name: 'Init',
                            blocks: [
                                {
                                    id: 'init-only-block',
                                    content: 'print("init")',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
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

            const content = projectToYaml(file);
            const result = await serializer.deserializeNotebook(content, {} as any);

            // The `?? notebooks[0]` fallback: when the init is the ONLY notebook, it is rendered.
            assert.strictEqual(result.metadata?.deepnoteNotebookId, 'init-notebook');
            assert.strictEqual(result.metadata?.deepnoteNotebookName, 'Init');
            assert.deepStrictEqual(
                result.cells.map((cell) => cell.metadata?.id),
                ['init-only-block']
            );
        });
    });

    suite('detectContentChanges', () => {
        test('should detect no changes when content is identical', () => {
            const project: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2023-01-01T00:00:00Z' },
                project: {
                    id: 'project-1',
                    name: 'Test',
                    notebooks: [
                        {
                            id: 'nb-1',
                            name: 'Notebook',
                            blocks: [
                                {
                                    id: 'b1',
                                    type: 'code',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
                                    content: 'print(1)'
                                }
                            ]
                        }
                    ]
                }
            };

            const serializerAny = serializer as any;
            const projectCopy = structuredClone(project);
            const result = serializerAny.detectContentChanges(project, projectCopy, 'nb-1');

            assert.isFalse(result);
        });

        test('should detect changes when block content differs', () => {
            const newProject: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2023-01-01T00:00:00Z' },
                project: {
                    id: 'project-1',
                    name: 'Test',
                    notebooks: [
                        {
                            id: 'nb-1',
                            name: 'Notebook',
                            blocks: [
                                {
                                    id: 'b1',
                                    type: 'code',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
                                    content: 'print(2)'
                                }
                            ]
                        }
                    ]
                }
            };

            const originalProject: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2023-01-01T00:00:00Z' },
                project: {
                    id: 'project-1',
                    name: 'Test',
                    notebooks: [
                        {
                            id: 'nb-1',
                            name: 'Notebook',
                            blocks: [
                                {
                                    id: 'b1',
                                    type: 'code',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
                                    content: 'print(1)'
                                }
                            ]
                        }
                    ]
                }
            };

            const serializerAny = serializer as any;
            const result = serializerAny.detectContentChanges(newProject, originalProject, 'nb-1');

            assert.isTrue(result);
        });

        test('should detect changes when block type differs', () => {
            const newProject: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2023-01-01T00:00:00Z' },
                project: {
                    id: 'project-1',
                    name: 'Test',
                    notebooks: [
                        {
                            id: 'nb-1',
                            name: 'Notebook',
                            blocks: [
                                {
                                    id: 'b1',
                                    type: 'markdown',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
                                    content: '# Hello'
                                }
                            ]
                        }
                    ]
                }
            };

            const originalProject: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2023-01-01T00:00:00Z' },
                project: {
                    id: 'project-1',
                    name: 'Test',
                    notebooks: [
                        {
                            id: 'nb-1',
                            name: 'Notebook',
                            blocks: [
                                {
                                    id: 'b1',
                                    type: 'code',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
                                    content: '# Hello'
                                }
                            ]
                        }
                    ]
                }
            };

            const serializerAny = serializer as any;
            const result = serializerAny.detectContentChanges(newProject, originalProject, 'nb-1');

            assert.isTrue(result);
        });

        test('should detect changes when block count differs', () => {
            const newProject: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2023-01-01T00:00:00Z' },
                project: {
                    id: 'project-1',
                    name: 'Test',
                    notebooks: [
                        {
                            id: 'nb-1',
                            name: 'Notebook',
                            blocks: [
                                {
                                    id: 'b1',
                                    type: 'code',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
                                    content: 'print(1)'
                                },
                                {
                                    id: 'b2',
                                    type: 'code',
                                    sortingKey: 'a1',
                                    blockGroup: '1',
                                    metadata: {},
                                    content: 'print(2)'
                                }
                            ]
                        }
                    ]
                }
            };

            const originalProject: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2023-01-01T00:00:00Z' },
                project: {
                    id: 'project-1',
                    name: 'Test',
                    notebooks: [
                        {
                            id: 'nb-1',
                            name: 'Notebook',
                            blocks: [
                                {
                                    id: 'b1',
                                    type: 'code',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
                                    content: 'print(1)'
                                }
                            ]
                        }
                    ]
                }
            };

            const serializerAny = serializer as any;
            const result = serializerAny.detectContentChanges(newProject, originalProject, 'nb-1');

            assert.isTrue(result);
        });

        test('should ignore output changes', () => {
            const newProject: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2023-01-01T00:00:00Z' },
                project: {
                    id: 'project-1',
                    name: 'Test',
                    notebooks: [
                        {
                            id: 'nb-1',
                            name: 'Notebook',
                            blocks: [
                                {
                                    id: 'b1',
                                    type: 'code',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
                                    content: 'print(1)',
                                    outputs: [{ output_type: 'stream', text: '1\n' }]
                                }
                            ]
                        }
                    ]
                }
            };

            const originalProject: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2023-01-01T00:00:00Z' },
                project: {
                    id: 'project-1',
                    name: 'Test',
                    notebooks: [
                        {
                            id: 'nb-1',
                            name: 'Notebook',
                            blocks: [
                                {
                                    id: 'b1',
                                    type: 'code',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
                                    content: 'print(1)'
                                }
                            ]
                        }
                    ]
                }
            };

            const serializerAny = serializer as any;
            const result = serializerAny.detectContentChanges(newProject, originalProject, 'nb-1');

            assert.isFalse(result);
        });

        test('should ignore execution metadata changes', () => {
            const newProject: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2023-01-01T00:00:00Z' },
                project: {
                    id: 'project-1',
                    name: 'Test',
                    notebooks: [
                        {
                            id: 'nb-1',
                            name: 'Notebook',
                            blocks: [
                                {
                                    id: 'b1',
                                    type: 'code',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
                                    content: 'print(1)',
                                    executionCount: 5,
                                    executionStartedAt: '2025-01-01T00:00:00Z',
                                    executionFinishedAt: '2025-01-01T00:00:01Z'
                                }
                            ]
                        }
                    ]
                }
            };

            const originalProject: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2023-01-01T00:00:00Z' },
                project: {
                    id: 'project-1',
                    name: 'Test',
                    notebooks: [
                        {
                            id: 'nb-1',
                            name: 'Notebook',
                            blocks: [
                                {
                                    id: 'b1',
                                    type: 'code',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
                                    content: 'print(1)'
                                }
                            ]
                        }
                    ]
                }
            };

            const serializerAny = serializer as any;
            const result = serializerAny.detectContentChanges(newProject, originalProject, 'nb-1');

            assert.isFalse(result);
        });

        // Notebook-level field changes must be detected even when the blocks are byte-identical.
        // A single-notebook file with overridable notebook-level fields.
        function singleNotebookFile(overrides: Record<string, unknown>): DeepnoteFile {
            return {
                version: '1.0.0',
                metadata: { createdAt: '2023-01-01T00:00:00Z' },
                project: {
                    id: 'project-nb-fields',
                    name: 'Test',
                    notebooks: [
                        {
                            id: 'nb-1',
                            name: 'Notebook',
                            executionMode: 'block',
                            isModule: false,
                            workingDirectory: '/work',
                            blocks: [
                                {
                                    id: 'b1',
                                    type: 'code',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
                                    content: 'print(1)'
                                }
                            ],
                            ...overrides
                        }
                    ]
                }
            };
        }

        const notebookLevelFieldCases: Array<{ field: string; original: unknown; changed: unknown }> = [
            { field: 'name', original: 'Notebook', changed: 'Renamed Notebook' },
            { field: 'executionMode', original: 'block', changed: 'notebook' },
            { field: 'isModule', original: false, changed: true },
            { field: 'workingDirectory', original: '/work', changed: '/different' }
        ];

        for (const { field, original, changed } of notebookLevelFieldCases) {
            test(`catches missed notebook-level diff: a change to '${field}' is detected even with identical blocks`, () => {
                const originalProject = singleNotebookFile({ [field]: original });
                const newProject = singleNotebookFile({ [field]: changed });

                const serializerAny = serializer as any;
                const result = serializerAny.detectContentChanges(newProject, originalProject, 'nb-1');

                assert.isTrue(result, `change to notebook-level field '${field}' should be detected`);
            });
        }

        test('catches missed block-id diff: a block id change (same content/type) is detected', () => {
            const originalProject = singleNotebookFile({});
            const newProject = singleNotebookFile({});
            newProject.project.notebooks[0].blocks[0].id = 'b1-renamed';

            const serializerAny = serializer as any;
            const result = serializerAny.detectContentChanges(newProject, originalProject, 'nb-1');

            assert.isTrue(result);
        });

        test('matches the edited notebook by id, not the [0] slot (legacy [init, main] file)', () => {
            // Legacy shape: init at index 0, the edited/rendered notebook (main) at index 1. Comparing
            // a fixed [0] slot would compare the (unchanged) init and miss real edits to main.
            const makeFile = (mainContent: string): DeepnoteFile => ({
                version: '1.0.0',
                metadata: { createdAt: '2023-01-01T00:00:00Z' },
                project: {
                    id: 'project-1',
                    name: 'Test',
                    initNotebookId: 'init-1',
                    notebooks: [
                        { id: 'init-1', name: 'Init', blocks: [] },
                        {
                            id: 'main-1',
                            name: 'Main',
                            blocks: [
                                {
                                    id: 'b1',
                                    type: 'code',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
                                    content: mainContent
                                }
                            ]
                        }
                    ]
                }
            });

            const serializerAny = serializer as any;

            // Editing main (index 1) IS detected when matching by id; the old [0] comparison missed it.
            assert.isTrue(serializerAny.detectContentChanges(makeFile('print(2)'), makeFile('print(1)'), 'main-1'));
            // Identical main → no content change.
            assert.isFalse(serializerAny.detectContentChanges(makeFile('print(1)'), makeFile('print(1)'), 'main-1'));
        });
    });

    suite('snapshotHash', () => {
        test('should add snapshotHash to metadata when serializing', async () => {
            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-snapshot-hash',
                    name: 'Snapshot Hash Test',
                    notebooks: [
                        {
                            id: 'notebook-1',
                            name: 'Test Notebook',
                            blocks: [
                                {
                                    id: 'block-1',
                                    content: 'print("hello")',
                                    blockGroup: '1',
                                    metadata: {},
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

            manager.storeOriginalProject('project-snapshot-hash', 'notebook-1', projectData);

            const notebookData = {
                cells: [
                    {
                        kind: 2,
                        value: 'print("hello")',
                        languageId: 'python',
                        metadata: { id: 'block-1' }
                    }
                ],
                metadata: {
                    deepnoteProjectId: 'project-snapshot-hash',
                    deepnoteNotebookId: 'notebook-1'
                }
            };

            const result = await serializer.serializeNotebook(notebookData as any, {} as any);
            const yamlString = new TextDecoder().decode(result);
            const parsedResult = parseYaml(yamlString) as DeepnoteFile & {
                metadata: { snapshotHash?: string };
            };

            assert.isDefined(parsedResult.metadata.snapshotHash);
            assert.match(parsedResult.metadata.snapshotHash!, /^sha256:[a-f0-9]+$/);
        });

        test('should produce deterministic hash for same content', async () => {
            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-deterministic',
                    name: 'Deterministic Test',
                    notebooks: [
                        {
                            id: 'notebook-1',
                            name: 'Test Notebook',
                            blocks: [
                                {
                                    id: 'block-1',
                                    content: 'print("test")',
                                    blockGroup: '1',
                                    metadata: {},
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

            const notebookData = {
                cells: [
                    {
                        kind: 2,
                        value: 'print("test")',
                        languageId: 'python',
                        metadata: { id: 'block-1' }
                    }
                ],
                metadata: {
                    deepnoteProjectId: 'project-deterministic',
                    deepnoteNotebookId: 'notebook-1'
                }
            };

            // Serialize twice
            manager.storeOriginalProject('project-deterministic', 'notebook-1', structuredClone(projectData));
            const result1 = await serializer.serializeNotebook(notebookData as any, {} as any);
            const parsed1 = parseYaml(new TextDecoder().decode(result1)) as DeepnoteFile & {
                metadata: { snapshotHash?: string };
            };

            manager.storeOriginalProject('project-deterministic', 'notebook-1', structuredClone(projectData));
            const result2 = await serializer.serializeNotebook(notebookData as any, {} as any);
            const parsed2 = parseYaml(new TextDecoder().decode(result2)) as DeepnoteFile & {
                metadata: { snapshotHash?: string };
            };

            assert.strictEqual(parsed1.metadata.snapshotHash, parsed2.metadata.snapshotHash);
        });

        test('should generate identical hash across multiple serializations', async () => {
            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-multi-serialize',
                    name: 'Multi Serialize Test',
                    integrations: [
                        { id: 'int-1', name: 'Database', type: 'postgres' },
                        { id: 'int-2', name: 'S3 Bucket', type: 's3' }
                    ],
                    notebooks: [
                        {
                            id: 'notebook-1',
                            name: 'Notebook A',
                            blocks: [
                                {
                                    id: 'block-1',
                                    content: 'import pandas as pd',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
                                    type: 'code'
                                },
                                {
                                    id: 'block-2',
                                    content: '# Analysis',
                                    sortingKey: 'a1',
                                    blockGroup: '1',
                                    metadata: {},
                                    type: 'markdown'
                                }
                            ],
                            executionMode: 'block',
                            isModule: false
                        },
                        {
                            id: 'notebook-2',
                            name: 'Notebook B',
                            blocks: [
                                {
                                    id: 'block-3',
                                    content: 'print("hello")',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
                                    type: 'code'
                                }
                            ],
                            executionMode: 'block',
                            isModule: false
                        }
                    ],
                    settings: {}
                },
                environment: { hash: 'env-abc123' }
            };

            const notebookData = {
                cells: [
                    {
                        kind: 2,
                        value: 'import pandas as pd',
                        languageId: 'python',
                        metadata: { id: 'block-1' }
                    },
                    {
                        kind: 1,
                        value: '# Analysis',
                        languageId: 'markdown',
                        metadata: { id: 'block-2' }
                    }
                ],
                metadata: {
                    deepnoteProjectId: 'project-multi-serialize',
                    deepnoteNotebookId: 'notebook-1'
                }
            };

            const hashes: string[] = [];

            // Serialize 5 times and collect all hashes
            for (let i = 0; i < 5; i++) {
                manager.storeOriginalProject('project-multi-serialize', 'notebook-1', structuredClone(projectData));
                const result = await serializer.serializeNotebook(notebookData as any, {} as any);
                const parsed = parseYaml(new TextDecoder().decode(result)) as DeepnoteFile & {
                    metadata: { snapshotHash?: string };
                };

                hashes.push(parsed.metadata.snapshotHash!);
            }

            // All hashes should be identical
            const firstHash = hashes[0];

            for (let i = 1; i < hashes.length; i++) {
                assert.strictEqual(hashes[i], firstHash, `Hash at iteration ${i} should match first hash`);
            }
        });

        test('should change hash when block content changes', async () => {
            const projectData1: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-content-change',
                    name: 'Content Change Test',
                    notebooks: [
                        {
                            id: 'notebook-1',
                            name: 'Test Notebook',
                            blocks: [
                                {
                                    id: 'block-1',
                                    content: 'print("original")',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
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

            manager.storeOriginalProject('project-content-change', 'notebook-1', projectData1);

            const notebookData1 = {
                cells: [
                    {
                        kind: 2,
                        value: 'print("original")',
                        languageId: 'python',
                        metadata: { id: 'block-1' }
                    }
                ],
                metadata: {
                    deepnoteProjectId: 'project-content-change',
                    deepnoteNotebookId: 'notebook-1'
                }
            };

            const result1 = await serializer.serializeNotebook(notebookData1 as any, {} as any);
            const parsed1 = parseYaml(new TextDecoder().decode(result1)) as DeepnoteFile & {
                metadata: { snapshotHash?: string };
            };

            // Now change content
            const notebookData2 = {
                cells: [
                    {
                        kind: 2,
                        value: 'print("modified")',
                        languageId: 'python',
                        metadata: { id: 'block-1' }
                    }
                ],
                metadata: {
                    deepnoteProjectId: 'project-content-change',
                    deepnoteNotebookId: 'notebook-1'
                }
            };

            const result2 = await serializer.serializeNotebook(notebookData2 as any, {} as any);
            const parsed2 = parseYaml(new TextDecoder().decode(result2)) as DeepnoteFile & {
                metadata: { snapshotHash?: string };
            };

            assert.notStrictEqual(parsed1.metadata.snapshotHash, parsed2.metadata.snapshotHash);
        });

        test('should change hash when version changes', async () => {
            const projectData1: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-version-change',
                    name: 'Version Change Test',
                    notebooks: [
                        {
                            id: 'notebook-1',
                            name: 'Test Notebook',
                            blocks: [
                                {
                                    id: 'block-1',
                                    content: 'test',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
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

            manager.storeOriginalProject('project-version-change', 'notebook-1', projectData1);

            const notebookData = {
                cells: [
                    {
                        kind: 2,
                        value: 'test',
                        languageId: 'python',
                        metadata: { id: 'block-1' }
                    }
                ],
                metadata: {
                    deepnoteProjectId: 'project-version-change',
                    deepnoteNotebookId: 'notebook-1'
                }
            };

            const result1 = await serializer.serializeNotebook(notebookData as any, {} as any);
            const parsed1 = parseYaml(new TextDecoder().decode(result1)) as DeepnoteFile & {
                metadata: { snapshotHash?: string };
            };

            // Change version
            const projectData2: DeepnoteFile = { ...structuredClone(projectData1), version: '2.0' };
            manager.storeOriginalProject('project-version-change', 'notebook-1', projectData2);

            const result2 = await serializer.serializeNotebook(notebookData as any, {} as any);
            const parsed2 = parseYaml(new TextDecoder().decode(result2)) as DeepnoteFile & {
                metadata: { snapshotHash?: string };
            };

            assert.notStrictEqual(parsed1.metadata.snapshotHash, parsed2.metadata.snapshotHash);
        });

        test('should change hash when integrations change', async () => {
            const projectData1: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-integrations-change',
                    name: 'Integrations Change Test',
                    notebooks: [
                        {
                            id: 'notebook-1',
                            name: 'Test Notebook',
                            blocks: [
                                {
                                    id: 'block-1',
                                    content: 'test',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
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

            manager.storeOriginalProject('project-integrations-change', 'notebook-1', projectData1);

            const notebookData = {
                cells: [
                    {
                        kind: 2,
                        value: 'test',
                        languageId: 'python',
                        metadata: { id: 'block-1' }
                    }
                ],
                metadata: {
                    deepnoteProjectId: 'project-integrations-change',
                    deepnoteNotebookId: 'notebook-1'
                }
            };

            const result1 = await serializer.serializeNotebook(notebookData as any, {} as any);
            const parsed1 = parseYaml(new TextDecoder().decode(result1)) as DeepnoteFile & {
                metadata: { snapshotHash?: string };
            };

            // Add integrations
            const projectData2 = structuredClone(projectData1);
            projectData2.project.integrations = [{ id: 'int-1', name: 'PostgreSQL', type: 'postgres' }];
            manager.storeOriginalProject('project-integrations-change', 'notebook-1', projectData2);

            const result2 = await serializer.serializeNotebook(notebookData as any, {} as any);
            const parsed2 = parseYaml(new TextDecoder().decode(result2)) as DeepnoteFile & {
                metadata: { snapshotHash?: string };
            };

            assert.notStrictEqual(parsed1.metadata.snapshotHash, parsed2.metadata.snapshotHash);
        });

        test('should include environment hash when present', async () => {
            const projectData1: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: 'project-env-hash',
                    name: 'Environment Hash Test',
                    notebooks: [
                        {
                            id: 'notebook-1',
                            name: 'Test Notebook',
                            blocks: [
                                {
                                    id: 'block-1',
                                    content: 'test',
                                    sortingKey: 'a0',
                                    blockGroup: '1',
                                    metadata: {},
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

            manager.storeOriginalProject('project-env-hash', 'notebook-1', projectData1);

            const notebookData = {
                cells: [
                    {
                        kind: 2,
                        value: 'test',
                        languageId: 'python',
                        metadata: { id: 'block-1' }
                    }
                ],
                metadata: {
                    deepnoteProjectId: 'project-env-hash',
                    deepnoteNotebookId: 'notebook-1'
                }
            };

            const result1 = await serializer.serializeNotebook(notebookData as any, {} as any);
            const parsed1 = parseYaml(new TextDecoder().decode(result1)) as DeepnoteFile & {
                metadata: { snapshotHash?: string };
            };

            // Add environment hash
            const projectData2 = structuredClone(projectData1);
            projectData2.environment = { hash: 'env-hash-123' };
            manager.storeOriginalProject('project-env-hash', 'notebook-1', projectData2);

            const result2 = await serializer.serializeNotebook(notebookData as any, {} as any);
            const parsed2 = parseYaml(new TextDecoder().decode(result2)) as DeepnoteFile & {
                metadata: { snapshotHash?: string };
            };

            assert.notStrictEqual(parsed1.metadata.snapshotHash, parsed2.metadata.snapshotHash);
        });
    });
});
