import { deserializeDeepnoteFile, serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { assert } from 'chai';
import { parse as parseYaml } from 'yaml';
import { when } from 'ts-mockito';
import type { NotebookDocument } from 'vscode';

import { DeepnoteNotebookSerializer } from './deepnoteSerializer';
import { DeepnoteNotebookManager } from './deepnoteNotebookManager';
import { DeepnoteDataConverter } from './deepnoteDataConverter';
import { mockedVSCodeNamespaces } from '../../test/vscode-mock';

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
     * Helper function to convert a DeepnoteProject object with version to YAML format
     */
    function projectToYaml(projectData: DeepnoteFile): Uint8Array {
        const yamlString = serializeDeepnoteFile(projectData);
        return new TextEncoder().encode(yamlString);
    }

    function createNotebookDoc(notebookId: string, projectId: string = 'project-123'): NotebookDocument {
        return {
            cellAt: () => ({}) as any,
            cellCount: 0,
            getCells: () => [],
            isClosed: false,
            isDirty: false,
            isUntitled: false,
            metadata: {
                deepnoteNotebookId: notebookId,
                deepnoteProjectId: projectId
            },
            notebookType: 'deepnote',
            save: async () => true,
            then: undefined,
            uri: {} as any,
            version: 1
        } as NotebookDocument;
    }

    suite('deserializeNotebook', () => {
        test('should deserialize valid project with queued notebook resolution', async () => {
            manager.queueNotebookResolution('project-123', 'notebook-1');

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

        test('should deserialize the specified notebook when notebookId is passed', async () => {
            const content = projectToYaml(mockProject);
            const result = await serializer.deserializeNotebook(content, {} as any, 'notebook-2');

            assert.strictEqual(result.metadata?.deepnoteNotebookId, 'notebook-2');
            assert.strictEqual(result.metadata?.deepnoteNotebookName, 'Second Notebook');
            assert.strictEqual(result.cells.length, 1);
            assert.include(result.cells[0].value, 'Title');
        });

        test('should ignore queued resolution when explicit notebookId is provided', async () => {
            manager.queueNotebookResolution('project-123', 'notebook-1');
            const content = projectToYaml(mockProject);
            const result = await serializer.deserializeNotebook(content, {} as any, 'notebook-2');

            assert.strictEqual(result.metadata?.deepnoteNotebookId, 'notebook-2');
            assert.strictEqual(result.metadata?.deepnoteNotebookName, 'Second Notebook');
        });

        test('should fall back to findCurrentNotebookId when notebookId is undefined', async () => {
            manager.queueNotebookResolution('project-123', 'notebook-1');
            const content = projectToYaml(mockProject);
            const result = await serializer.deserializeNotebook(content, {} as any);

            assert.strictEqual(result.metadata?.deepnoteNotebookId, 'notebook-1');
            assert.strictEqual(result.metadata?.deepnoteNotebookName, 'First Notebook');
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

        test('should use current notebook ID when metadata notebook ID is missing', async () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-2');

            const mockNotebookData = {
                cells: [
                    {
                        kind: 1, // NotebookCellKind.Markup
                        value: '# Updated second notebook',
                        languageId: 'markdown',
                        metadata: {}
                    }
                ],
                metadata: {
                    deepnoteProjectId: 'project-123'
                }
            };

            const result = await serializer.serializeNotebook(mockNotebookData as any, {} as any);
            const serializedProject = deserializeDeepnoteFile(new TextDecoder().decode(result));

            assert.strictEqual(serializedProject.project.notebooks[0].id, 'notebook-1');
            assert.strictEqual(serializedProject.project.notebooks[1].id, 'notebook-2');
            assert.strictEqual(serializedProject.project.notebooks[0].blocks?.[0].content, 'print("hello")');
            assert.strictEqual(serializedProject.project.notebooks[1].blocks?.[0].content, '# Updated second notebook');
        });

        suite('multi-notebook save scenarios', () => {
            teardown(() => {
                when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);
                when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([]);
            });

            test('serializing notebook-1 should not change currentNotebookId', async () => {
                manager.queueNotebookResolution('project-123', 'notebook-2');
                await serializer.deserializeNotebook(projectToYaml(mockProject), {} as any);

                assert.strictEqual(manager.getCurrentNotebookId('project-123'), 'notebook-2');

                const mockNotebookData = {
                    cells: [
                        {
                            kind: 2,
                            languageId: 'python',
                            metadata: {},
                            value: 'print("edited nb1")'
                        }
                    ],
                    metadata: {
                        deepnoteNotebookId: 'notebook-1',
                        deepnoteProjectId: 'project-123'
                    }
                };

                await serializer.serializeNotebook(mockNotebookData as any, {} as any);

                assert.strictEqual(manager.getCurrentNotebookId('project-123'), 'notebook-2');
            });

            test('serializing notebook-1 then deserializing without explicit ID should resolve to sibling notebook-2', async () => {
                const yamlBytes = projectToYaml(mockProject);

                manager.queueNotebookResolution('project-123', 'notebook-1');
                await serializer.deserializeNotebook(yamlBytes, {} as any);
                manager.queueNotebookResolution('project-123', 'notebook-2');
                await serializer.deserializeNotebook(yamlBytes, {} as any);

                const notebookDoc1 = createNotebookDoc('notebook-1');
                const notebookDoc2 = createNotebookDoc('notebook-2');

                when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookDoc1, notebookDoc2]);

                const mockNotebookData = {
                    cells: [
                        {
                            kind: 2,
                            languageId: 'python',
                            metadata: {},
                            value: 'print("saved from nb1")'
                        }
                    ],
                    metadata: {
                        deepnoteNotebookId: 'notebook-1',
                        deepnoteProjectId: 'project-123'
                    }
                };

                const saved = await serializer.serializeNotebook(mockNotebookData as any, {} as any);
                const afterSave = await serializer.deserializeNotebook(saved, {} as any);

                assert.strictEqual(afterSave.metadata?.deepnoteNotebookId, 'notebook-2');
            });

            test('sequential saves: contextless deserialize returns the sibling after each serialize', async () => {
                const yamlBytes = projectToYaml(mockProject);

                manager.queueNotebookResolution('project-123', 'notebook-1');
                await serializer.deserializeNotebook(yamlBytes, {} as any);
                manager.queueNotebookResolution('project-123', 'notebook-2');
                await serializer.deserializeNotebook(yamlBytes, {} as any);

                const notebookDoc1 = createNotebookDoc('notebook-1');
                const notebookDoc2 = createNotebookDoc('notebook-2');

                when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookDoc1, notebookDoc2]);

                const dataNb1 = {
                    cells: [
                        {
                            kind: 2,
                            languageId: 'python',
                            metadata: {},
                            value: 'print("round-a")'
                        }
                    ],
                    metadata: {
                        deepnoteNotebookId: 'notebook-1',
                        deepnoteProjectId: 'project-123'
                    }
                };
                let bytes = await serializer.serializeNotebook(dataNb1 as any, {} as any);
                let meta = await serializer.deserializeNotebook(bytes, {} as any);

                assert.strictEqual(meta.metadata?.deepnoteNotebookId, 'notebook-2');

                const dataNb2 = {
                    cells: [
                        {
                            kind: 1,
                            languageId: 'markdown',
                            metadata: {},
                            value: '# round-b'
                        }
                    ],
                    metadata: {
                        deepnoteNotebookId: 'notebook-2',
                        deepnoteProjectId: 'project-123'
                    }
                };
                bytes = await serializer.serializeNotebook(dataNb2 as any, {} as any);
                meta = await serializer.deserializeNotebook(bytes, {} as any);

                assert.strictEqual(meta.metadata?.deepnoteNotebookId, 'notebook-1');
            });
        });
    });

    suite('findCurrentNotebookId', () => {
        teardown(() => {
            // Reset only the specific mocks used in this suite
            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);
            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([]);
            when(mockedVSCodeNamespaces.window.tabGroups).thenReturn({ all: [] } as any);
        });

        test('should return queued notebook resolution when available', () => {
            manager.queueNotebookResolution('project-123', 'queued-notebook');

            const result = serializer.findCurrentNotebookId('project-123');

            assert.strictEqual(result, 'queued-notebook');
        });

        test('should consume queued notebook resolution only once', () => {
            manager.queueNotebookResolution('project-123', 'queued-notebook');

            assert.strictEqual(serializer.findCurrentNotebookId('project-123'), 'queued-notebook');
            assert.strictEqual(serializer.findCurrentNotebookId('project-123'), undefined);
        });

        test('should prioritize queued notebook resolution over current notebook and open documents', () => {
            manager.queueNotebookResolution('project-123', 'queued-notebook');
            manager.storeOriginalProject('project-123', mockProject, 'current-notebook');

            const mockNotebookDoc = {
                then: undefined,
                notebookType: 'deepnote',
                metadata: {
                    deepnoteProjectId: 'project-123',
                    deepnoteNotebookId: 'open-notebook'
                },
                uri: {} as any,
                version: 1,
                isDirty: false,
                isUntitled: false,
                isClosed: false,
                cellCount: 0,
                cellAt: () => ({}) as any,
                getCells: () => [],
                save: async () => true
            } as NotebookDocument;

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([mockNotebookDoc]);

            const result = serializer.findCurrentNotebookId('project-123');

            assert.strictEqual(result, 'queued-notebook');
        });

        test('should return current notebook ID when no pending resolution exists', () => {
            manager.storeOriginalProject('project-123', mockProject, 'current-notebook');

            const result = serializer.findCurrentNotebookId('project-123');

            assert.strictEqual(result, 'current-notebook');
        });

        test('should return the only open notebook when current notebook ID is unavailable', () => {
            const mockNotebookDoc = {
                then: undefined,
                notebookType: 'deepnote',
                metadata: {
                    deepnoteProjectId: 'project-123',
                    deepnoteNotebookId: 'notebook-from-workspace'
                },
                uri: {} as any,
                version: 1,
                isDirty: false,
                isUntitled: false,
                isClosed: false,
                cellCount: 0,
                cellAt: () => ({}) as any,
                getCells: () => [],
                save: async () => true
            } as NotebookDocument;

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([mockNotebookDoc]);

            const result = serializer.findCurrentNotebookId('project-123');

            assert.strictEqual(result, 'notebook-from-workspace');
        });

        test('should prefer current notebook ID when multiple notebooks are open for a project', () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-b');

            const notebookA = {
                then: undefined,
                notebookType: 'deepnote',
                metadata: {
                    deepnoteProjectId: 'project-123',
                    deepnoteNotebookId: 'notebook-a'
                },
                uri: {} as any,
                version: 1,
                isDirty: false,
                isUntitled: false,
                isClosed: false,
                cellCount: 0,
                cellAt: () => ({}) as any,
                getCells: () => [],
                save: async () => true
            } as NotebookDocument;
            const notebookB = {
                then: undefined,
                notebookType: 'deepnote',
                metadata: {
                    deepnoteProjectId: 'project-123',
                    deepnoteNotebookId: 'notebook-b'
                },
                uri: {} as any,
                version: 1,
                isDirty: false,
                isUntitled: false,
                isClosed: false,
                cellCount: 0,
                cellAt: () => ({}) as any,
                getCells: () => [],
                save: async () => true
            } as NotebookDocument;

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookA, notebookB]);

            const result = serializer.findCurrentNotebookId('project-123');

            assert.strictEqual(result, 'notebook-b');
        });

        test('should return undefined when multiple notebooks are open and no stronger signal exists', () => {
            const notebookA = {
                then: undefined,
                notebookType: 'deepnote',
                metadata: {
                    deepnoteProjectId: 'project-123',
                    deepnoteNotebookId: 'notebook-a'
                },
                uri: {} as any,
                version: 1,
                isDirty: false,
                isUntitled: false,
                isClosed: false,
                cellCount: 0,
                cellAt: () => ({}) as any,
                getCells: () => [],
                save: async () => true
            } as NotebookDocument;
            const notebookB = {
                then: undefined,
                notebookType: 'deepnote',
                metadata: {
                    deepnoteProjectId: 'project-123',
                    deepnoteNotebookId: 'notebook-b'
                },
                uri: {} as any,
                version: 1,
                isDirty: false,
                isUntitled: false,
                isClosed: false,
                cellCount: 0,
                cellAt: () => ({}) as any,
                getCells: () => [],
                save: async () => true
            } as NotebookDocument;

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookA, notebookB]);

            const result = serializer.findCurrentNotebookId('project-123');

            assert.strictEqual(result, undefined);
        });

        test('after serializing notebook-1 with both notebooks open should return sibling notebook-2', async () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-1');

            const notebookDoc1 = createNotebookDoc('notebook-1');
            const notebookDoc2 = createNotebookDoc('notebook-2');

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookDoc1, notebookDoc2]);

            const mockNotebookData = {
                cells: [
                    {
                        kind: 2,
                        languageId: 'python',
                        metadata: {},
                        value: 'print("findOpen")'
                    }
                ],
                metadata: {
                    deepnoteNotebookId: 'notebook-1',
                    deepnoteProjectId: 'project-123'
                }
            };

            await serializer.serializeNotebook(mockNotebookData as any, {} as any);

            const result = serializer.findCurrentNotebookId('project-123');

            assert.strictEqual(result, 'notebook-2');
        });

        test('recent serialization hint is one-shot', async () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-1');

            const notebookDoc1 = createNotebookDoc('notebook-1');
            const notebookDoc2 = createNotebookDoc('notebook-2');

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookDoc1, notebookDoc2]);

            const mockNotebookData = {
                cells: [
                    {
                        kind: 2,
                        languageId: 'python',
                        metadata: {},
                        value: 'print("one-shot")'
                    }
                ],
                metadata: {
                    deepnoteNotebookId: 'notebook-1',
                    deepnoteProjectId: 'project-123'
                }
            };

            await serializer.serializeNotebook(mockNotebookData as any, {} as any);

            assert.strictEqual(serializer.findCurrentNotebookId('project-123'), 'notebook-2');
            assert.strictEqual(serializer.findCurrentNotebookId('project-123'), 'notebook-1');
        });

        test('recent serialization hint expires after TTL', async () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-1');

            const notebookDoc1 = createNotebookDoc('notebook-1');
            const notebookDoc2 = createNotebookDoc('notebook-2');

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookDoc1, notebookDoc2]);

            const mockNotebookData = {
                cells: [
                    {
                        kind: 2,
                        languageId: 'python',
                        metadata: {},
                        value: 'print("ttl")'
                    }
                ],
                metadata: {
                    deepnoteNotebookId: 'notebook-1',
                    deepnoteProjectId: 'project-123'
                }
            };

            await serializer.serializeNotebook(mockNotebookData as any, {} as any);

            (serializer as any).recentSerializations.set('project-123', {
                notebookId: 'notebook-1',
                timestamp: Date.now() - 6000
            });

            const result = serializer.findCurrentNotebookId('project-123');

            assert.strictEqual(result, 'notebook-1');
        });

        test('should return undefined for unknown project', () => {
            const result = serializer.findCurrentNotebookId('unknown-project');

            assert.strictEqual(result, undefined);
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
            assert.isFunction(manager.consumePendingNotebookResolution, 'has consumePendingNotebookResolution method');
            assert.isFunction(manager.getCurrentNotebookId, 'has getCurrentNotebookId method');
            assert.isFunction(manager.getOriginalProject, 'has getOriginalProject method');
            assert.isFunction(manager.queueNotebookResolution, 'has queueNotebookResolution method');
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

            manager.storeOriginalProject('project-circular', projectWithCircularRef, 'notebook-1');

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
            manager.storeOriginalProject('project-id-test', projectData, 'notebook-1');

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

            manager.storeOriginalProject('project-recover-ids', projectData, 'notebook-1');

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

            manager.storeOriginalProject('project-new-content', projectData, 'notebook-1');

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

        test('should select alphabetically first notebook when no initNotebookId', async () => {
            const projectData: DeepnoteFile = {
                version: '1.0.0',
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
                        },
                        {
                            id: 'bravo-notebook',
                            name: 'Bravo Notebook',
                            blocks: [
                                {
                                    id: 'block-b',
                                    content: 'print("bravo")',
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

            // Should select the alphabetically first notebook
            assert.strictEqual(result.metadata?.deepnoteNotebookId, 'alpha-notebook');
            assert.strictEqual(result.metadata?.deepnoteNotebookName, 'Alpha Notebook');
        });

        test('should sort Init notebook last when multiple notebooks exist', async () => {
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

            // Should select Alpha, not Init even though "Init" comes before "Alpha" alphabetically when in upper case
            assert.strictEqual(result.metadata?.deepnoteNotebookId, 'alpha-notebook');
            assert.strictEqual(result.metadata?.deepnoteNotebookName, 'Alpha');
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
            const result = serializerAny.detectContentChanges(project, projectCopy);

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
            const result = serializerAny.detectContentChanges(newProject, originalProject);

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
            const result = serializerAny.detectContentChanges(newProject, originalProject);

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
            const result = serializerAny.detectContentChanges(newProject, originalProject);

            assert.isTrue(result);
        });

        test('should detect new notebook added', () => {
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
                                }
                            ]
                        },
                        {
                            id: 'nb-2',
                            name: 'New Notebook',
                            blocks: []
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
            const result = serializerAny.detectContentChanges(newProject, originalProject);

            assert.isTrue(result);
        });

        test('should detect notebook removed', () => {
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
                        },
                        {
                            id: 'nb-2',
                            name: 'Second Notebook',
                            blocks: []
                        }
                    ]
                }
            };

            const serializerAny = serializer as any;
            const result = serializerAny.detectContentChanges(newProject, originalProject);

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
            const result = serializerAny.detectContentChanges(newProject, originalProject);

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
            const result = serializerAny.detectContentChanges(newProject, originalProject);

            assert.isFalse(result);
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

            manager.storeOriginalProject('project-snapshot-hash', projectData, 'notebook-1');

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
            manager.storeOriginalProject('project-deterministic', structuredClone(projectData), 'notebook-1');
            const result1 = await serializer.serializeNotebook(notebookData as any, {} as any);
            const parsed1 = parseYaml(new TextDecoder().decode(result1)) as DeepnoteFile & {
                metadata: { snapshotHash?: string };
            };

            manager.storeOriginalProject('project-deterministic', structuredClone(projectData), 'notebook-1');
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
                manager.storeOriginalProject('project-multi-serialize', structuredClone(projectData), 'notebook-1');
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

            manager.storeOriginalProject('project-content-change', projectData1, 'notebook-1');

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

            manager.storeOriginalProject('project-version-change', projectData1, 'notebook-1');

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
            manager.storeOriginalProject('project-version-change', projectData2, 'notebook-1');

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

            manager.storeOriginalProject('project-integrations-change', projectData1, 'notebook-1');

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
            manager.storeOriginalProject('project-integrations-change', projectData2, 'notebook-1');

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

            manager.storeOriginalProject('project-env-hash', projectData1, 'notebook-1');

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
            manager.storeOriginalProject('project-env-hash', projectData2, 'notebook-1');

            const result2 = await serializer.serializeNotebook(notebookData as any, {} as any);
            const parsed2 = parseYaml(new TextDecoder().decode(result2)) as DeepnoteFile & {
                metadata: { snapshotHash?: string };
            };

            assert.notStrictEqual(parsed1.metadata.snapshotHash, parsed2.metadata.snapshotHash);
        });
    });
});
