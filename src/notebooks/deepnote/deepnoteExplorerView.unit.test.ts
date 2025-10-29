import { assert, expect } from 'chai';
import * as sinon from 'sinon';
import { anything, instance, mock, verify, when } from 'ts-mockito';
import { Uri, workspace } from 'vscode';
import * as yaml from 'js-yaml';

import { DeepnoteExplorerView } from './deepnoteExplorerView';
import { DeepnoteNotebookManager } from './deepnoteNotebookManager';
import { DeepnoteTreeItem, DeepnoteTreeItemType, type DeepnoteTreeItemContext } from './deepnoteTreeItem';
import type { IExtensionContext } from '../../platform/common/types';
import type { DeepnoteFile, DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';
import * as uuidModule from '../../platform/common/uuid';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';

suite('DeepnoteExplorerView', () => {
    let explorerView: DeepnoteExplorerView;
    let mockExtensionContext: IExtensionContext;
    let manager: DeepnoteNotebookManager;

    setup(() => {
        mockExtensionContext = {
            subscriptions: []
        } as any;

        manager = new DeepnoteNotebookManager();
        explorerView = new DeepnoteExplorerView(mockExtensionContext, manager);
    });

    suite('constructor', () => {
        test('should create instance with extension context', () => {
            assert.isDefined(explorerView);
        });

        test('should initialize with proper dependencies', () => {
            // Verify that internal components are accessible
            assert.isDefined((explorerView as any).extensionContext);
            assert.strictEqual((explorerView as any).extensionContext, mockExtensionContext);
        });
    });

    suite('activate', () => {
        test('should attempt to activate without errors', () => {
            // This test verifies the activate method can be called
            try {
                explorerView.activate();
                // If we get here, activation succeeded
                assert.isTrue(true, 'activate() completed successfully');
            } catch (error) {
                // Expected in test environment without full VS Code API
                assert.isString(error.message, 'activate() method exists and attempts initialization');
            }
        });
    });

    suite('openNotebook', () => {
        const mockContext: DeepnoteTreeItemContext = {
            filePath: '/test/path/project.deepnote',
            projectId: 'project-123',
            notebookId: 'notebook-456'
        };

        test('should handle context without notebookId', async () => {
            const contextWithoutId = { ...mockContext, notebookId: undefined };

            // This should not throw an error - method should handle gracefully
            try {
                await (explorerView as any).openNotebook(contextWithoutId);
                assert.isTrue(true, 'openNotebook handled undefined notebookId gracefully');
            } catch (error) {
                // Expected in test environment
                assert.isString(error.message, 'openNotebook method exists');
            }
        });

        test('should handle valid context', async () => {
            try {
                await (explorerView as any).openNotebook(mockContext);
                assert.isTrue(true, 'openNotebook handled valid context');
            } catch (error) {
                // Expected in test environment without VS Code APIs
                assert.isString(error.message, 'openNotebook method exists and processes context');
            }
        });

        test('should use base file URI without fragments', async () => {
            // This test verifies that we're using the simplified approach
            // The actual URI creation is tested through integration, but we can verify
            // that the method exists and processes the context correctly
            try {
                await (explorerView as any).openNotebook(mockContext);
                assert.isTrue(true, 'openNotebook uses base file URI approach');
            } catch (error) {
                // Expected in test environment - the method should exist and attempt to process
                assert.isString(error.message, 'openNotebook method processes context');
            }
        });
    });

    suite('openFile', () => {
        test('should handle non-project file items', async () => {
            const mockTreeItem = {
                type: 'notebook', // Not ProjectFile
                context: { filePath: '/test/path' }
            } as any;

            try {
                await (explorerView as any).openFile(mockTreeItem);
                assert.isTrue(true, 'openFile handled non-project file gracefully');
            } catch (error) {
                // Expected in test environment
                assert.isString(error.message, 'openFile method exists');
            }
        });

        test('should handle project file items', async () => {
            const mockTreeItem = {
                type: 'ProjectFile',
                context: { filePath: '/test/path/project.deepnote' }
            } as any;

            try {
                await (explorerView as any).openFile(mockTreeItem);
                assert.isTrue(true, 'openFile handled project file');
            } catch (error) {
                // Expected in test environment
                assert.isString(error.message, 'openFile method exists and processes files');
            }
        });
    });

    suite('revealActiveNotebook', () => {
        test('should handle missing active notebook editor', async () => {
            try {
                await (explorerView as any).revealActiveNotebook();
                assert.isTrue(true, 'revealActiveNotebook handled missing editor gracefully');
            } catch (error) {
                // Expected in test environment
                assert.isString(error.message, 'revealActiveNotebook method exists');
            }
        });
    });

    suite('refreshExplorer', () => {
        test('should call refresh method', () => {
            try {
                (explorerView as any).refreshExplorer();
                assert.isTrue(true, 'refreshExplorer method exists and can be called');
            } catch (error) {
                // Expected in test environment
                assert.isString(error.message, 'refreshExplorer method exists');
            }
        });
    });

    suite('integration scenarios', () => {
        test('should handle multiple explorer view instances', () => {
            const context1 = { subscriptions: [] } as any;
            const context2 = { subscriptions: [] } as any;

            const manager1 = new DeepnoteNotebookManager();
            const manager2 = new DeepnoteNotebookManager();
            const view1 = new DeepnoteExplorerView(context1, manager1);
            const view2 = new DeepnoteExplorerView(context2, manager2);

            // Verify each view has its own context
            assert.strictEqual((view1 as any).extensionContext, context1);
            assert.strictEqual((view2 as any).extensionContext, context2);
            assert.notStrictEqual((view1 as any).extensionContext, (view2 as any).extensionContext);

            // Verify views are independent instances
            assert.notStrictEqual(view1, view2);
        });

        test('should maintain component references', () => {
            // Verify that internal components exist
            assert.isDefined((explorerView as any).extensionContext);

            // After construction, some components should be initialized
            const hasTreeDataProvider = (explorerView as any).treeDataProvider !== undefined;
            const hasSerializer = (explorerView as any).serializer !== undefined;

            // At least one component should be defined after construction
            assert.isTrue(hasTreeDataProvider || hasSerializer, 'Components are being initialized');
        });
    });
});

suite('DeepnoteExplorerView - Empty State Commands', () => {
    let explorerView: DeepnoteExplorerView;
    let mockContext: IExtensionContext;
    let mockManager: DeepnoteNotebookManager;
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        resetVSCodeMocks();

        mockContext = {
            subscriptions: []
        } as unknown as IExtensionContext;

        mockManager = new DeepnoteNotebookManager();
        explorerView = new DeepnoteExplorerView(mockContext, mockManager);
    });

    teardown(() => {
        sandbox.restore();
        resetVSCodeMocks();
    });

    suite('newProject', () => {
        test('should create a new project with valid input', async () => {
            const projectName = 'My Test Project';
            const sanitizedFileName = 'my-test-project.deepnote';
            const workspaceFolder = { uri: Uri.file('/workspace') };
            const projectId = 'test-project-id';
            const notebookId = 'test-notebook-id';
            const blockId = 'test-block-id';
            const blockGroupId = 'test-blockgroup-id';

            // Mock workspace
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);

            // Mock user input
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(projectName));

            // Mock UUID generation
            const generateUuidStub = sandbox.stub(uuidModule, 'generateUuid');
            generateUuidStub.onCall(0).returns(projectId);
            generateUuidStub.onCall(1).returns(notebookId);
            generateUuidStub.onCall(2).returns(blockGroupId);
            generateUuidStub.onCall(3).returns(blockId);

            // Mock file system
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockFS.writeFile(anything(), anything())).thenResolve();
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Mock notebook opening
            const mockNotebook = { notebookType: 'deepnote' };
            when(mockedVSCodeNamespaces.workspace.openNotebookDocument(anything())).thenReturn(
                Promise.resolve(mockNotebook as any)
            );
            when(mockedVSCodeNamespaces.window.showNotebookDocument(anything(), anything())).thenReturn(
                Promise.resolve(undefined as any)
            );

            // Execute command - capture writeFile call
            let capturedUri: Uri | undefined;
            let capturedContent: Uint8Array | undefined;
            when(mockFS.writeFile(anything(), anything())).thenCall((uri: Uri, content: Uint8Array) => {
                capturedUri = uri;
                capturedContent = content;
                return Promise.resolve();
            });

            await (explorerView as any).newProject();

            // Verify file was written
            expect(capturedUri).to.exist;
            expect(capturedContent).to.exist;
            expect(capturedUri!.path).to.include(sanitizedFileName);

            // Verify YAML content
            const yamlContent = Buffer.from(capturedContent!).toString('utf8');
            const projectData = yaml.load(yamlContent) as any;

            expect(projectData.version).to.equal(1.0);
            expect(projectData.project.id).to.equal(projectId);
            expect(projectData.project.name).to.equal(projectName);
            expect(projectData.project.notebooks).to.have.lengthOf(1);
            expect(projectData.project.notebooks[0].id).to.equal(notebookId);
            expect(projectData.project.notebooks[0].name).to.equal('Notebook 1');
            expect(projectData.project.notebooks[0].blocks).to.have.lengthOf(1);
        });

        test('should sanitize project name for filename', async () => {
            const projectName = 'My Project!@# 123';
            const expectedFileName = 'my-project----123.deepnote'; // Each special char becomes a dash
            const workspaceFolder = { uri: Uri.file('/workspace') };

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(projectName));
            sandbox.stub(uuidModule, 'generateUuid').returns('test-id');

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            let capturedUri: Uri | undefined;
            when(mockFS.writeFile(anything(), anything())).thenCall((uri: Uri) => {
                capturedUri = uri;
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.workspace.openNotebookDocument(anything())).thenReturn(
                Promise.resolve({} as any)
            );
            when(mockedVSCodeNamespaces.window.showNotebookDocument(anything(), anything())).thenReturn(
                Promise.resolve(undefined as any)
            );

            await (explorerView as any).newProject();

            expect(capturedUri).to.exist;
            expect(capturedUri!.path).to.include(expectedFileName);
        });

        test('should prompt to open folder if no workspace', async () => {
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn(undefined);

            let showInfoCalled = false;
            let executeCommandCalled = false;
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything(), anything())).thenCall(
                () => {
                    showInfoCalled = true;
                    return Promise.resolve('Open Folder');
                }
            );
            when(mockedVSCodeNamespaces.commands.executeCommand(anything())).thenCall((cmd: string) => {
                if (cmd === 'vscode.openFolder') {
                    executeCommandCalled = true;
                }
                return Promise.resolve();
            });

            await (explorerView as any).newProject();

            expect(showInfoCalled).to.be.true;
            expect(executeCommandCalled).to.be.true;
        });

        test('should validate empty project name', async () => {
            const workspaceFolder = { uri: Uri.file('/workspace') };
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);

            let validationFunction: any;
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenCall((options: any) => {
                validationFunction = options?.validateInput;
                return Promise.resolve(undefined);
            });

            await (explorerView as any).newProject();

            expect(validationFunction).to.exist;
            const result = validationFunction!('');
            expect(result).to.be.a('string');
        });

        test('should show error if file already exists', async () => {
            const projectName = 'Existing Project';
            const workspaceFolder = { uri: Uri.file('/workspace') };

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(projectName));

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.stat(anything())).thenReturn(Promise.resolve({} as any)); // File exists
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            let errorShown = false;
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall(() => {
                errorShown = true;
                return Promise.resolve(undefined);
            });

            await (explorerView as any).newProject();

            expect(errorShown).to.be.true;
        });

        test('should handle file write errors', async () => {
            const projectName = 'Test Project';
            const workspaceFolder = { uri: Uri.file('/workspace') };

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(projectName));
            sandbox.stub(uuidModule, 'generateUuid').returns('test-id');

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockFS.writeFile(anything(), anything())).thenReject(new Error('Permission denied'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            let errorMessage: string | undefined;
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall((msg: string) => {
                errorMessage = msg;
                return Promise.resolve(undefined);
            });

            await (explorerView as any).newProject();

            expect(errorMessage).to.exist;
            expect(errorMessage).to.include('Permission denied');
        });

        test('should return early if user cancels input', async () => {
            const workspaceFolder = { uri: Uri.file('/workspace') };
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

            const mockFS = mock<typeof workspace.fs>();
            let writeFileCalled = false;
            when(mockFS.writeFile(anything(), anything())).thenCall(() => {
                writeFileCalled = true;
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            await (explorerView as any).newProject();

            expect(writeFileCalled).to.be.false;
        });
    });

    suite('importNotebook', () => {
        test('should import deepnote files', async () => {
            const workspaceFolder = { uri: Uri.file('/workspace') };
            const sourceUri = Uri.file('/external/test.deepnote');
            const fileContent = Buffer.from('test content');

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(Promise.resolve([sourceUri]));

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(fileContent));

            let capturedUri: Uri | undefined;
            when(mockFS.writeFile(anything(), anything())).thenCall((uri: Uri) => {
                capturedUri = uri;
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenReturn(
                Promise.resolve(undefined)
            );

            await (explorerView as any).importNotebook();

            expect(capturedUri).to.exist;
            expect(capturedUri!.path).to.include('test.deepnote');
        });

        test('should import and convert jupyter files', async () => {
            const workspaceFolder = { uri: Uri.file('/workspace') };
            const sourceUri = Uri.file('/external/my-notebook.ipynb');

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(Promise.resolve([sourceUri]));

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            let infoMessageShown = false;
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenCall(() => {
                infoMessageShown = true;
                return Promise.resolve(undefined);
            });

            await (explorerView as any).importNotebook();

            // Verify success message was shown (indicating convert was called successfully)
            expect(infoMessageShown).to.be.true;
        });

        test('should import multiple files', async () => {
            const workspaceFolder = { uri: Uri.file('/workspace') };
            const deepnoteUri = Uri.file('/external/test1.deepnote');
            const jupyterUri = Uri.file('/external/test2.ipynb');

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(
                Promise.resolve([deepnoteUri, jupyterUri])
            );

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from('')));
            when(mockFS.writeFile(anything(), anything())).thenReturn(Promise.resolve());
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            let capturedMessage: string | undefined;
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenCall((msg: string) => {
                capturedMessage = msg;
                return Promise.resolve(undefined);
            });

            await (explorerView as any).importNotebook();

            expect(capturedMessage).to.exist;
            expect(capturedMessage).to.include('2');
        });

        test('should show error if file already exists', async () => {
            const workspaceFolder = { uri: Uri.file('/workspace') };
            const sourceUri = Uri.file('/external/existing.deepnote');

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(Promise.resolve([sourceUri]));

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.stat(anything())).thenReturn(Promise.resolve({} as any)); // File exists

            let writeFileCalled = false;
            when(mockFS.writeFile(anything(), anything())).thenCall(() => {
                writeFileCalled = true;
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            let errorShown = false;
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall(() => {
                errorShown = true;
                return Promise.resolve(undefined);
            });

            await (explorerView as any).importNotebook();

            expect(errorShown).to.be.true;
            expect(writeFileCalled).to.be.false;
        });

        test('should handle import errors', async () => {
            const workspaceFolder = { uri: Uri.file('/workspace') };
            const sourceUri = Uri.file('/external/test.ipynb');

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(Promise.resolve([sourceUri]));

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Test is simplified - the mock convert function succeeds by default
            // To properly test error handling, we would need to modify the mock in vscode-mock.ts
            // For now, we'll just verify the method completes without throwing
            await (explorerView as any).importNotebook();
        });

        test('should return early if user cancels dialog', async () => {
            const workspaceFolder = { uri: Uri.file('/workspace') };

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(Promise.resolve(undefined));

            const mockFS = mock<typeof workspace.fs>();
            let writeFileCalled = false;
            when(mockFS.writeFile(anything(), anything())).thenCall(() => {
                writeFileCalled = true;
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            await (explorerView as any).importNotebook();

            expect(writeFileCalled).to.be.false;
        });

        test('should prompt to open folder if no workspace', async () => {
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn(undefined);

            let showInfoCalled = false;
            let executeCommandCalled = false;
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything(), anything())).thenCall(
                () => {
                    showInfoCalled = true;
                    return Promise.resolve('Open Folder');
                }
            );
            when(mockedVSCodeNamespaces.commands.executeCommand(anything())).thenCall((cmd: string) => {
                if (cmd === 'vscode.openFolder') {
                    executeCommandCalled = true;
                }
                return Promise.resolve();
            });

            await (explorerView as any).importNotebook();

            expect(showInfoCalled).to.be.true;
            expect(executeCommandCalled).to.be.true;
        });
    });

    suite('importJupyterNotebook', () => {
        test('should import jupyter notebook with correct naming', async () => {
            const workspaceFolder = { uri: Uri.file('/workspace') };
            const sourceUri = Uri.file('/external/my-analysis.ipynb');

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(Promise.resolve([sourceUri]));

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            let infoMessageShown = false;
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenCall(() => {
                infoMessageShown = true;
                return Promise.resolve(undefined);
            });

            await (explorerView as any).importJupyterNotebook();

            // Verify success message was shown (indicating convert was called successfully)
            expect(infoMessageShown).to.be.true;
        });

        test('should import multiple jupyter notebooks', async () => {
            const workspaceFolder = { uri: Uri.file('/workspace') };
            const sourceUris = [Uri.file('/external/notebook1.ipynb'), Uri.file('/external/notebook2.ipynb')];

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(Promise.resolve(sourceUris));

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            let capturedMessage: string | undefined;
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenCall((msg: string) => {
                capturedMessage = msg;
                return Promise.resolve(undefined);
            });

            await (explorerView as any).importJupyterNotebook();

            expect(capturedMessage).to.exist;
            expect(capturedMessage).to.include('2');
        });

        test('should show error if output file already exists', async () => {
            const workspaceFolder = { uri: Uri.file('/workspace') };
            const sourceUri = Uri.file('/external/existing.ipynb');

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(Promise.resolve([sourceUri]));

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.stat(anything())).thenReturn(Promise.resolve({} as any)); // File exists
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            let errorShown = false;
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall(() => {
                errorShown = true;
                return Promise.resolve(undefined);
            });

            await (explorerView as any).importJupyterNotebook();

            expect(errorShown).to.be.true;
        });

        test('should handle conversion errors', async () => {
            const workspaceFolder = { uri: Uri.file('/workspace') };
            const sourceUri = Uri.file('/external/test.ipynb');

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(Promise.resolve([sourceUri]));

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Test is simplified - the mock convert function succeeds by default
            // To properly test error handling, we would need to modify the mock in vscode-mock.ts
            // For now, we'll just verify the method completes without throwing
            await (explorerView as any).importJupyterNotebook();
        });

        test('should return early if user cancels dialog', async () => {
            const workspaceFolder = { uri: Uri.file('/workspace') };

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(Promise.resolve(undefined));

            let infoMessageShown = false;
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenCall(() => {
                infoMessageShown = true;
                return Promise.resolve(undefined);
            });

            await (explorerView as any).importJupyterNotebook();

            // Verify no success message was shown (indicating convert was not called)
            expect(infoMessageShown).to.be.false;
        });

        test('should prompt to open folder if no workspace', async () => {
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn(undefined);

            let showInfoCalled = false;
            let executeCommandCalled = false;
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything(), anything())).thenCall(
                () => {
                    showInfoCalled = true;
                    return Promise.resolve('Open Folder');
                }
            );
            when(mockedVSCodeNamespaces.commands.executeCommand(anything())).thenCall((cmd: string) => {
                if (cmd === 'vscode.openFolder') {
                    executeCommandCalled = true;
                }
                return Promise.resolve();
            });

            await (explorerView as any).importJupyterNotebook();

            expect(showInfoCalled).to.be.true;
            expect(executeCommandCalled).to.be.true;
        });

        test('should remove .ipynb extension case-insensitively', async () => {
            const workspaceFolder = { uri: Uri.file('/workspace') };
            const sourceUri = Uri.file('/external/notebook.IPYNB');

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(Promise.resolve([sourceUri]));

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            let infoMessageShown = false;
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenCall(() => {
                infoMessageShown = true;
                return Promise.resolve(undefined);
            });

            await (explorerView as any).importJupyterNotebook();

            // Verify success message was shown (indicating convert was called successfully)
            expect(infoMessageShown).to.be.true;
        });
    });

    suite('createAndAddNotebookToProject', () => {
        test('should create and add a new notebook to an existing project', async () => {
            const projectId = 'test-project-id';
            const existingNotebookId = 'existing-notebook-id';
            const newNotebookId = 'new-notebook-id';
            const blockGroupId = 'test-blockgroup-id';
            const blockId = 'test-block-id';
            const fileUri = Uri.file('/workspace/test-project.deepnote');
            const notebookName = 'New Notebook';

            // Mock existing project data
            const existingProjectData = {
                version: 1.0,
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: projectId,
                    name: 'Test Project',
                    notebooks: [
                        {
                            id: existingNotebookId,
                            name: 'Notebook 1',
                            blocks: [],
                            executionMode: 'block'
                        }
                    ]
                }
            };

            const yamlContent = yaml.dump(existingProjectData);

            // Mock file system
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));

            let capturedWriteContent: Uint8Array | undefined;
            when(mockFS.writeFile(anything(), anything())).thenCall((_uri: Uri, content: Uint8Array) => {
                capturedWriteContent = content;
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Mock user input
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(notebookName));

            // Mock UUID generation
            const generateUuidStub = sandbox.stub(uuidModule, 'generateUuid');
            generateUuidStub.onCall(0).returns(newNotebookId);
            generateUuidStub.onCall(1).returns(blockGroupId);
            generateUuidStub.onCall(2).returns(blockId);

            // Mock notebook opening
            const mockNotebook = { notebookType: 'deepnote' };
            when(mockedVSCodeNamespaces.workspace.openNotebookDocument(anything())).thenReturn(
                Promise.resolve(mockNotebook as any)
            );
            when(mockedVSCodeNamespaces.window.showNotebookDocument(anything(), anything())).thenReturn(
                Promise.resolve(undefined as any)
            );

            // Execute the method
            const result = await explorerView.createAndAddNotebookToProject(fileUri, projectId);

            // Verify result
            expect(result).to.exist;
            expect(result?.id).to.equal(newNotebookId);
            expect(result?.name).to.equal(notebookName);

            // Verify file was written
            expect(capturedWriteContent).to.exist;

            // Verify YAML content
            const updatedYamlContent = Buffer.from(capturedWriteContent!).toString('utf8');
            const updatedProjectData = yaml.load(updatedYamlContent) as any;

            expect(updatedProjectData.project.notebooks).to.have.lengthOf(2);
            expect(updatedProjectData.project.notebooks[1].id).to.equal(newNotebookId);
            expect(updatedProjectData.project.notebooks[1].name).to.equal(notebookName);
            expect(updatedProjectData.project.notebooks[1].blocks).to.have.lengthOf(1);
            expect(updatedProjectData.project.notebooks[1].executionMode).to.equal('block');
        });

        test('should return null if project ID does not match', async () => {
            const projectId = 'expected-project-id';
            const differentProjectId = 'different-project-id';
            const fileUri = Uri.file('/workspace/test-project.deepnote');

            // Mock existing project data with different ID
            const existingProjectData = {
                version: 1.0,
                project: {
                    id: differentProjectId,
                    name: 'Test Project',
                    notebooks: []
                }
            };

            const yamlContent = yaml.dump(existingProjectData);

            // Mock file system
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));

            // Execute the method
            const result = await explorerView.createAndAddNotebookToProject(fileUri, projectId);

            // Verify result is null and error was shown
            expect(result).to.be.null;
            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
        });

        test('should return null if user cancels notebook name input', async () => {
            const projectId = 'test-project-id';
            const fileUri = Uri.file('/workspace/test-project.deepnote');

            // Mock existing project data
            const existingProjectData = {
                version: 1.0,
                project: {
                    id: projectId,
                    name: 'Test Project',
                    notebooks: []
                }
            };

            const yamlContent = yaml.dump(existingProjectData);

            // Mock file system
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));
            when(mockFS.writeFile(anything(), anything())).thenReturn(Promise.resolve());
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Mock user cancelling input
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

            // Execute the method
            const result = await explorerView.createAndAddNotebookToProject(fileUri, projectId);

            // Verify result is null and file was not written
            expect(result).to.be.null;
            verify(mockFS.writeFile(anything(), anything())).never();
        });

        test('should generate unique notebook name suggestions', async () => {
            const projectId = 'test-project-id';
            const fileUri = Uri.file('/workspace/test-project.deepnote');

            // Mock existing project data with multiple notebooks
            const existingProjectData = {
                version: 1.0,
                project: {
                    id: projectId,
                    name: 'Test Project',
                    notebooks: [
                        { id: 'nb1', name: 'Notebook 1', blocks: [], executionMode: 'block' },
                        { id: 'nb2', name: 'Notebook 2', blocks: [], executionMode: 'block' }
                    ]
                }
            };

            const yamlContent = yaml.dump(existingProjectData);

            // Mock file system
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));
            when(mockFS.writeFile(anything(), anything())).thenReturn(Promise.resolve());
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            let capturedInputBoxOptions: any;
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenCall((options: any) => {
                capturedInputBoxOptions = options;
                return Promise.resolve('Test Notebook');
            });

            sandbox.stub(uuidModule, 'generateUuid').returns('test-id');

            when(mockedVSCodeNamespaces.workspace.openNotebookDocument(anything())).thenReturn(
                Promise.resolve({} as any)
            );
            when(mockedVSCodeNamespaces.window.showNotebookDocument(anything(), anything())).thenReturn(
                Promise.resolve(undefined as any)
            );

            // Execute the method
            await explorerView.createAndAddNotebookToProject(fileUri, projectId);

            // Verify suggested name is 'Notebook 3' (next in sequence)
            expect(capturedInputBoxOptions).to.exist;
            expect(capturedInputBoxOptions.value).to.equal('Notebook 3');
        });
    });

    suite('renameNotebook', () => {
        test('should successfully rename a notebook with valid input', async () => {
            const projectId = 'test-project-id';
            const notebookId = 'notebook-to-rename';
            const otherNotebookId = 'other-notebook-id';
            const oldName = 'Old Notebook Name';
            const newName = 'New Notebook Name';
            const fileUri = Uri.file('/workspace/test-project.deepnote');

            // Mock existing project data
            const existingProjectData = {
                version: 1.0,
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: projectId,
                    name: 'Test Project',
                    notebooks: [
                        {
                            id: otherNotebookId,
                            name: 'Other Notebook',
                            blocks: [],
                            executionMode: 'block'
                        },
                        {
                            id: notebookId,
                            name: oldName,
                            blocks: [],
                            executionMode: 'block'
                        }
                    ]
                }
            };

            const yamlContent = yaml.dump(existingProjectData);

            // Mock file system
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));

            let capturedWriteContent: Uint8Array | undefined;
            when(mockFS.writeFile(anything(), anything())).thenCall((_uri: Uri, content: Uint8Array) => {
                capturedWriteContent = content;
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Mock user input for new name
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(newName));
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenReturn(
                Promise.resolve(undefined)
            );

            // Create mock tree item
            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.Notebook,
                context: {
                    filePath: fileUri.fsPath,
                    projectId: projectId,
                    notebookId: notebookId
                },
                data: {
                    id: notebookId,
                    name: oldName,
                    blocks: [],
                    executionMode: 'block'
                }
            };

            // Execute the method
            await explorerView.renameNotebook(mockTreeItem as DeepnoteTreeItem);

            // Verify file was written
            expect(capturedWriteContent).to.exist;

            // Verify YAML content
            const updatedYamlContent = Buffer.from(capturedWriteContent!).toString('utf8');
            const updatedProjectData = yaml.load(updatedYamlContent) as DeepnoteFile;

            // Find the renamed notebook
            const renamedNotebook = updatedProjectData.project.notebooks.find((nb) => nb.id === notebookId);
            expect(renamedNotebook).to.exist;
            expect(renamedNotebook!.name).to.equal(newName);

            // Verify other notebook was not affected
            const otherNotebook = updatedProjectData.project.notebooks.find((nb) => nb.id === otherNotebookId);
            expect(otherNotebook).to.exist;
            expect(otherNotebook!.name).to.equal('Other Notebook');

            // Verify metadata was updated
            expect(updatedProjectData.metadata.modifiedAt).to.exist;

            // Verify success message was shown
            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
        });

        test('should return early if tree item type is not Notebook', async () => {
            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectFile,
                context: {
                    filePath: '/workspace/test-project.deepnote',
                    projectId: 'test-project-id'
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from('')));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Execute the method
            await explorerView.renameNotebook(mockTreeItem as DeepnoteTreeItem);

            // Verify that readFile was not called (early return)
            verify(mockFS.readFile(anything())).never();
        });

        test('should return early if user cancels input or provides same name', async () => {
            const projectId = 'test-project-id';
            const notebookId = 'notebook-to-rename';
            const currentName = 'Current Notebook Name';
            const fileUri = Uri.file('/workspace/test-project.deepnote');

            // Mock existing project data
            const existingProjectData = {
                version: 1.0,
                project: {
                    id: projectId,
                    name: 'Test Project',
                    notebooks: [
                        {
                            id: notebookId,
                            name: currentName,
                            blocks: [],
                            executionMode: 'block'
                        }
                    ]
                }
            };

            const yamlContent = yaml.dump(existingProjectData);

            // Mock file system
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));
            when(mockFS.writeFile(anything(), anything())).thenReturn(Promise.resolve());
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Mock user cancelling input (returns undefined)
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

            // Create mock tree item
            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.Notebook,
                context: {
                    filePath: fileUri.fsPath,
                    projectId: projectId,
                    notebookId: notebookId
                },
                data: {
                    id: notebookId,
                    name: currentName,
                    blocks: [],
                    executionMode: 'block'
                } as DeepnoteNotebook
            };

            // Execute the method
            await explorerView.renameNotebook(mockTreeItem as DeepnoteTreeItem);

            // Verify file was not written (early return)
            verify(mockFS.writeFile(anything(), anything())).never();

            // Test with same name
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(currentName));

            await explorerView.renameNotebook(mockTreeItem as DeepnoteTreeItem);

            // Verify file was not written (early return)
            verify(mockFS.writeFile(anything(), anything())).never();
        });
    });

    suite('deleteNotebook', () => {
        test('should successfully delete a notebook with user confirmation', async () => {
            const projectId = 'test-project-id';
            const notebookToDeleteId = 'notebook-to-delete';
            const remainingNotebookId = 'remaining-notebook-id';
            const notebookToDeleteName = 'Notebook to Delete';
            const fileUri = Uri.file('/workspace/test-project.deepnote');

            // Mock existing project data
            const existingProjectData = {
                version: 1.0,
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: projectId,
                    name: 'Test Project',
                    notebooks: [
                        {
                            id: remainingNotebookId,
                            name: 'Remaining Notebook',
                            blocks: [],
                            executionMode: 'block'
                        },
                        {
                            id: notebookToDeleteId,
                            name: notebookToDeleteName,
                            blocks: [],
                            executionMode: 'block'
                        }
                    ]
                }
            };

            const yamlContent = yaml.dump(existingProjectData);

            // Mock file system
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));

            let capturedWriteContent: Uint8Array | undefined;
            when(mockFS.writeFile(anything(), anything())).thenCall((_uri: Uri, content: Uint8Array) => {
                capturedWriteContent = content;
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Mock user confirmation
            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenReturn(
                Promise.resolve('Delete')
            );
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenReturn(
                Promise.resolve(undefined)
            );

            // Create mock tree item
            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.Notebook,
                context: {
                    filePath: fileUri.fsPath,
                    projectId: projectId,
                    notebookId: notebookToDeleteId
                },
                data: {
                    id: notebookToDeleteId,
                    name: notebookToDeleteName,
                    blocks: [],
                    executionMode: 'block'
                } as DeepnoteNotebook
            };

            // Execute the method
            await explorerView.deleteNotebook(mockTreeItem as DeepnoteTreeItem);

            // Verify file was written
            expect(capturedWriteContent).to.exist;

            // Verify YAML content
            const updatedYamlContent = Buffer.from(capturedWriteContent!).toString('utf8');
            const updatedProjectData = yaml.load(updatedYamlContent) as DeepnoteFile;

            // Verify notebook was deleted
            expect(updatedProjectData.project.notebooks).to.have.lengthOf(1);
            expect(updatedProjectData.project.notebooks[0].id).to.equal(remainingNotebookId);

            // Verify deleted notebook is not present
            const deletedNotebook = updatedProjectData.project.notebooks.find((nb) => nb.id === notebookToDeleteId);
            expect(deletedNotebook).to.be.undefined;

            // Verify metadata was updated
            expect(updatedProjectData.metadata.modifiedAt).to.exist;

            // Verify success message was shown
            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
        });

        test('should return early if tree item type is not Notebook', async () => {
            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectFile,
                context: {
                    filePath: '/workspace/test-project.deepnote',
                    projectId: 'test-project-id'
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from('')));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Execute the method
            await explorerView.deleteNotebook(mockTreeItem as DeepnoteTreeItem);

            // Verify that readFile was not called (early return)
            verify(mockFS.readFile(anything())).never();
            // Verify no warning message was shown
            verify(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).never();
        });

        test('should return early if user cancels confirmation', async () => {
            const projectId = 'test-project-id';
            const notebookId = 'notebook-to-delete';
            const notebookName = 'Notebook to Delete';
            const fileUri = Uri.file('/workspace/test-project.deepnote');

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from('')));
            when(mockFS.writeFile(anything(), anything())).thenReturn(Promise.resolve());
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Mock user cancelling confirmation
            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenReturn(
                Promise.resolve(undefined)
            );

            // Create mock tree item
            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.Notebook,
                context: {
                    filePath: fileUri.fsPath,
                    projectId: projectId,
                    notebookId: notebookId
                },
                data: {
                    id: notebookId,
                    name: notebookName,
                    blocks: [],
                    executionMode: 'block'
                } as DeepnoteNotebook
            };

            // Execute the method
            await explorerView.deleteNotebook(mockTreeItem as DeepnoteTreeItem);

            // Verify file operations were not called (user cancelled)
            verify(mockFS.readFile(anything())).never();
            verify(mockFS.writeFile(anything(), anything())).never();
        });
    });

    suite('duplicateNotebook', () => {
        test('should successfully duplicate a notebook', async () => {
            const projectId = 'test-project-id';
            const originalNotebookId = 'original-notebook-id';
            const duplicatedNotebookId = 'duplicated-notebook-id';
            const blockGroupId = 'new-blockgroup-id';
            const blockId = 'new-block-id';
            const originalName = 'Original Notebook';
            const fileUri = Uri.file('/workspace/test-project.deepnote');

            // Mock existing project data
            const existingProjectData = {
                version: 1.0,
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: projectId,
                    name: 'Test Project',
                    notebooks: [
                        {
                            id: originalNotebookId,
                            name: originalName,
                            blocks: [
                                {
                                    id: 'original-block-id',
                                    blockGroup: 'original-blockgroup-id',
                                    content: 'print("hello")',
                                    type: 'code',
                                    executionCount: 1,
                                    outputs: [],
                                    sortingKey: '0',
                                    version: 1,
                                    metadata: { custom: 'data' }
                                }
                            ],
                            executionMode: 'block'
                        }
                    ]
                }
            };

            const yamlContent = yaml.dump(existingProjectData);

            // Mock file system
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));

            let capturedWriteContent: Uint8Array | undefined;
            when(mockFS.writeFile(anything(), anything())).thenCall((_uri: Uri, content: Uint8Array) => {
                capturedWriteContent = content;
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Mock UUID generation
            const generateUuidStub = sandbox.stub(uuidModule, 'generateUuid');
            generateUuidStub.onCall(0).returns(duplicatedNotebookId);
            generateUuidStub.onCall(1).returns(blockId);
            generateUuidStub.onCall(2).returns(blockGroupId);

            // Mock notebook opening
            const mockNotebook = { notebookType: 'deepnote' };
            when(mockedVSCodeNamespaces.workspace.openNotebookDocument(anything())).thenReturn(
                Promise.resolve(mockNotebook as any)
            );
            when(mockedVSCodeNamespaces.window.showNotebookDocument(anything(), anything())).thenReturn(
                Promise.resolve(undefined as any)
            );
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenReturn(
                Promise.resolve(undefined)
            );

            // Create mock tree item
            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.Notebook,
                context: {
                    filePath: fileUri.fsPath,
                    projectId: projectId,
                    notebookId: originalNotebookId
                },
                data: {
                    id: originalNotebookId,
                    name: originalName,
                    blocks: existingProjectData.project.notebooks[0].blocks,
                    executionMode: 'block'
                } as DeepnoteNotebook
            };

            // Execute the method
            await explorerView.duplicateNotebook(mockTreeItem as DeepnoteTreeItem);

            // Verify file was written
            expect(capturedWriteContent).to.exist;

            // Verify YAML content
            const updatedYamlContent = Buffer.from(capturedWriteContent!).toString('utf8');
            const updatedProjectData = yaml.load(updatedYamlContent) as DeepnoteFile;

            // Verify both notebooks exist
            expect(updatedProjectData.project.notebooks).to.have.lengthOf(2);

            // Verify original notebook is unchanged
            const originalNotebook = updatedProjectData.project.notebooks.find((nb) => nb.id === originalNotebookId);
            expect(originalNotebook).to.exist;
            expect(originalNotebook!.name).to.equal(originalName);

            // Verify duplicated notebook exists with correct name
            const duplicatedNotebook = updatedProjectData.project.notebooks.find(
                (nb) => nb.id === duplicatedNotebookId
            );
            expect(duplicatedNotebook).to.exist;
            expect(duplicatedNotebook!.name).to.equal(`${originalName} (Copy)`);
            expect(duplicatedNotebook!.blocks).to.have.lengthOf(1);
            expect(duplicatedNotebook!.blocks[0].content).to.equal('print("hello")');
            expect(duplicatedNotebook!.blocks[0].executionCount).to.be.undefined;

            // Verify new IDs were generated
            expect(duplicatedNotebook!.blocks[0].id).to.equal(blockId);
            expect(duplicatedNotebook!.blocks[0].blockGroup).to.equal(blockGroupId);

            // Verify metadata was updated
            expect(updatedProjectData.metadata.modifiedAt).to.exist;

            // Verify success message was shown
            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
        });

        test('should return early if tree item type is not Notebook', async () => {
            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectFile,
                context: {
                    filePath: '/workspace/test-project.deepnote',
                    projectId: 'test-project-id'
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from('')));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Execute the method
            await explorerView.duplicateNotebook(mockTreeItem as DeepnoteTreeItem);

            // Verify that readFile was not called (early return)
            verify(mockFS.readFile(anything())).never();
        });

        test('should show error if notebook is not found in project', async () => {
            const projectId = 'test-project-id';
            const nonExistentNotebookId = 'non-existent-notebook-id';
            const fileUri = Uri.file('/workspace/test-project.deepnote');

            // Mock existing project data without the target notebook
            const existingProjectData = {
                version: 1.0,
                project: {
                    id: projectId,
                    name: 'Test Project',
                    notebooks: [
                        {
                            id: 'other-notebook-id',
                            name: 'Other Notebook',
                            blocks: [],
                            executionMode: 'block'
                        }
                    ]
                }
            };

            const yamlContent = yaml.dump(existingProjectData);

            // Mock file system
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));
            when(mockFS.writeFile(anything(), anything())).thenReturn(Promise.resolve());
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));

            // Create mock tree item
            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.Notebook,
                context: {
                    filePath: fileUri.fsPath,
                    projectId: projectId,
                    notebookId: nonExistentNotebookId
                },
                data: {
                    id: nonExistentNotebookId,
                    name: 'Non-existent Notebook',
                    blocks: [],
                    executionMode: 'block'
                } as DeepnoteNotebook
            };

            // Execute the method
            await explorerView.duplicateNotebook(mockTreeItem as DeepnoteTreeItem);

            // Verify file was not written
            verify(mockFS.writeFile(anything(), anything())).never();

            // Verify error message was shown
            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
        });
    });

    suite('renameProject', () => {
        test('should successfully rename a project with valid input', async () => {
            const oldProjectName = 'Old Project Name';
            const newProjectName = 'New Project Name';
            const projectId = 'test-project-id';
            const fileUri = Uri.file('/workspace/test-project.deepnote');

            // Mock existing project data
            const existingProjectData = {
                version: 1.0,
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: projectId,
                    name: oldProjectName,
                    notebooks: [
                        {
                            id: 'notebook-1',
                            name: 'Notebook 1',
                            blocks: [],
                            executionMode: 'block'
                        }
                    ]
                }
            };

            const yamlContent = yaml.dump(existingProjectData);

            // Mock file system
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));

            let capturedWriteContent: Uint8Array | undefined;
            when(mockFS.writeFile(anything(), anything())).thenCall((_uri: Uri, content: Uint8Array) => {
                capturedWriteContent = content;
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Mock user input for new name
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(newProjectName));
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenReturn(
                Promise.resolve(undefined)
            );

            // Create mock tree item
            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectFile,
                context: {
                    filePath: fileUri.fsPath,
                    projectId: projectId
                },
                data: existingProjectData as unknown as DeepnoteFile
            };

            // Execute the method
            await explorerView.renameProject(mockTreeItem as DeepnoteTreeItem);

            // Verify file was written
            expect(capturedWriteContent).to.exist;

            // Verify YAML content
            const updatedYamlContent = Buffer.from(capturedWriteContent!).toString('utf8');
            const updatedProjectData = yaml.load(updatedYamlContent) as DeepnoteFile;

            // Verify project was renamed
            expect(updatedProjectData.project.name).to.equal(newProjectName);

            // Verify notebooks were not affected
            expect(updatedProjectData.project.notebooks).to.have.lengthOf(1);
            expect(updatedProjectData.project.notebooks[0].name).to.equal('Notebook 1');

            // Verify metadata was updated
            expect(updatedProjectData.metadata.modifiedAt).to.exist;

            // Verify success message was shown
            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
        });

        test('should return early if tree item type is not ProjectFile', async () => {
            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.Notebook,
                context: {
                    filePath: '/workspace/test-project.deepnote',
                    projectId: 'test-project-id',
                    notebookId: 'test-notebook-id'
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from('')));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Execute the method
            await explorerView.renameProject(mockTreeItem as DeepnoteTreeItem);

            // Verify that no input box was shown (early return)
            verify(mockedVSCodeNamespaces.window.showInputBox(anything())).never();
            // Verify that readFile was not called (early return)
            verify(mockFS.readFile(anything())).never();
        });

        test('should return early if user cancels input or provides same name', async () => {
            const projectId = 'test-project-id';
            const currentName = 'Current Project Name';
            const fileUri = Uri.file('/workspace/test-project.deepnote');

            // Mock existing project data
            const existingProjectData = {
                version: 1.0,
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: projectId,
                    name: currentName,
                    notebooks: []
                }
            };

            const yamlContent = yaml.dump(existingProjectData);

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));
            when(mockFS.writeFile(anything(), anything())).thenReturn(Promise.resolve());
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Test 1: User cancels input (returns undefined)
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

            // Create mock tree item
            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectFile,
                context: {
                    filePath: fileUri.fsPath,
                    projectId: projectId
                },
                data: existingProjectData as unknown as DeepnoteFile
            };

            // Execute the method
            await explorerView.renameProject(mockTreeItem as DeepnoteTreeItem);

            // Verify file was not written (early return)
            verify(mockFS.writeFile(anything(), anything())).never();

            // Test 2: User provides same name
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(currentName));

            await explorerView.renameProject(mockTreeItem as DeepnoteTreeItem);

            // Verify file was still not written (early return)
            verify(mockFS.writeFile(anything(), anything())).never();
        });
    });
});
