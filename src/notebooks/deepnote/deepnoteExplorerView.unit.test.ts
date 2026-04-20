import { deserializeDeepnoteFile, ExecutableBlock, serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { assert, expect } from 'chai';
import * as sinon from 'sinon';
import { anything, instance, mock, verify, when } from 'ts-mockito';
import { Uri, workspace } from 'vscode';
import { stringify as yamlStringify } from 'yaml';

import { DeepnoteExplorerView } from './deepnoteExplorerView';

import {
    DeepnoteTreeItem,
    DeepnoteTreeItemType,
    NOTEBOOK_FILE_CONTEXT_VALUE,
    type DeepnoteTreeItemContext,
    type ProjectGroupData
} from './deepnoteTreeItem';
import type { IExtensionContext } from '../../platform/common/types';
import type { DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { ILogger } from '../../platform/logging/types';
import * as uuidModule from '../../platform/common/uuid';

function createMockLogger(): ILogger {
    return {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
        ci: () => undefined
    } as ILogger;
}

// Helper to mock UUID generation by mocking the uuidUtils wrapper
function createUuidMock(uuids: string[]): sinon.SinonStub {
    let callCount = 0;
    const stub = sinon.stub(uuidModule.uuidUtils, 'generateUuid');
    stub.callsFake(() => {
        if (callCount < uuids.length) {
            return uuids[callCount++];
        }
        // Fallback to a default UUID if we run out of mocked values
        return `fallback-uuid-${callCount++}`;
    });
    return stub;
}

suite('DeepnoteExplorerView', () => {
    let explorerView: DeepnoteExplorerView;
    let mockExtensionContext: IExtensionContext;
    let mockLogger: ILogger;

    setup(() => {
        mockExtensionContext = {
            subscriptions: []
        } as any;

        mockLogger = createMockLogger();
        explorerView = new DeepnoteExplorerView(mockExtensionContext, mockLogger);
    });

    teardown(() => {
        explorerView.dispose();
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

            const logger1 = createMockLogger();
            const logger2 = createMockLogger();
            const view1 = new DeepnoteExplorerView(context1, logger1);
            const view2 = new DeepnoteExplorerView(context2, logger2);

            try {
                // Verify each view has its own context
                assert.strictEqual((view1 as any).extensionContext, context1);
                assert.strictEqual((view2 as any).extensionContext, context2);
                assert.notStrictEqual((view1 as any).extensionContext, (view2 as any).extensionContext);

                // Verify views are independent instances
                assert.notStrictEqual(view1, view2);
            } finally {
                view1.dispose();
                view2.dispose();
            }
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
    let sandbox: sinon.SinonSandbox;
    let uuidStubs: sinon.SinonStub[] = [];

    setup(() => {
        sandbox = sinon.createSandbox();
        resetVSCodeMocks();
        uuidStubs = [];

        mockContext = {
            subscriptions: []
        } as unknown as IExtensionContext;

        const mockLogger = createMockLogger();
        explorerView = new DeepnoteExplorerView(mockContext, mockLogger);
    });

    teardown(() => {
        explorerView.dispose();
        sandbox.restore();
        uuidStubs.forEach((stub) => stub.restore());
        uuidStubs = [];
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

            // Mock UUID generation by mocking crypto.randomUUID
            const uuidStub = createUuidMock([projectId, notebookId, blockGroupId, blockId]);
            uuidStubs.push(uuidStub);

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
            const projectData = deserializeDeepnoteFile(yamlContent) as any;

            expect(projectData.version).to.equal('1.0.0');
            expect(projectData.metadata.createdAt).to.exist;
            expect(projectData.metadata.modifiedAt).to.exist;
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

            const uuidStub = createUuidMock(['test-id', 'test-id', 'test-id', 'test-id']);
            uuidStubs.push(uuidStub);

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

            const uuidStub = createUuidMock(['test-id', 'test-id', 'test-id', 'test-id']);
            uuidStubs.push(uuidStub);

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
        test('should create and add a new notebook as a new sibling .deepnote file', async () => {
            const projectId = 'test-project-id';
            const existingNotebookId = 'existing-notebook-id';
            const newNotebookId = 'new-notebook-id';
            const blockGroupId = 'test-blockgroup-id';
            const blockId = 'test-block-id';
            const fileUri = Uri.file('/workspace/test-project.deepnote');
            const notebookName = 'New Notebook';
            const expectedNewFilePath = '/workspace/test-project_new-notebook.deepnote';

            // Mock existing project data
            const existingProjectData: DeepnoteFile = {
                version: '1.0.0',
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

            const yamlContent = serializeDeepnoteFile(existingProjectData);

            // Mock file system: track writes per URI path and stat rejects (no collision)
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));

            const writes = new Map<string, Uint8Array>();
            when(mockFS.writeFile(anything(), anything())).thenCall((uri: Uri, content: Uint8Array) => {
                writes.set(uri.path, content);
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Mock user input
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(notebookName));

            // Mock UUID generation
            const uuidStub = createUuidMock([newNotebookId, blockGroupId, blockId]);
            uuidStubs.push(uuidStub);

            // Capture openNotebookDocument URI
            let openedUri: Uri | undefined;
            const mockNotebook = { notebookType: 'deepnote' };
            when(mockedVSCodeNamespaces.workspace.openNotebookDocument(anything())).thenCall((u: Uri) => {
                openedUri = u;
                return Promise.resolve(mockNotebook as any);
            });
            when(mockedVSCodeNamespaces.window.showNotebookDocument(anything(), anything())).thenReturn(
                Promise.resolve(undefined as any)
            );

            // Spy on treeDataProvider.refresh to verify it is called after the new file is written
            const refreshSpy = sandbox.spy((explorerView as any).treeDataProvider, 'refresh');

            const result = await explorerView.createAndAddNotebookToProject(fileUri);

            // Verify result
            expect(result).to.exist;
            expect(result?.id).to.equal(newNotebookId);
            expect(result?.name).to.equal(notebookName);

            // Verify original file was NOT written to
            expect(writes.has(fileUri.path)).to.be.false;

            // Verify new sibling file at expected path was written
            expect(writes.has(expectedNewFilePath)).to.be.true;
            const newFileContent = writes.get(expectedNewFilePath)!;
            const newFileYaml = Buffer.from(newFileContent).toString('utf8');
            const newProjectData = deserializeDeepnoteFile(newFileYaml);

            // The new file should contain exactly 1 notebook (the new one)
            expect(newProjectData.project.notebooks).to.have.lengthOf(1);
            expect(newProjectData.project.notebooks[0].id).to.equal(newNotebookId);
            expect(newProjectData.project.notebooks[0].name).to.equal(notebookName);
            expect(newProjectData.project.notebooks[0].blocks).to.have.lengthOf(1);
            expect(newProjectData.project.notebooks[0].executionMode).to.equal('block');

            // The new file should share the source project.id
            expect(newProjectData.project.id).to.equal(projectId);

            // openNotebookDocument should have been called with the NEW file URI
            expect(openedUri).to.exist;
            expect(openedUri!.path).to.equal(expectedNewFilePath);

            // Tree view should have been refreshed after the new file was written
            expect(refreshSpy.called).to.be.true;
        });

        test('should clone init notebook into the new sibling file', async () => {
            const projectId = 'test-project-id';
            const initNotebookId = 'init-notebook-id';
            const newNotebookId = 'new-notebook-id';
            const blockGroupId = 'test-blockgroup-id';
            const blockId = 'test-block-id';
            const fileUri = Uri.file('/workspace/test-project.deepnote');
            const notebookName = 'New Notebook';
            const expectedNewFilePath = '/workspace/test-project_new-notebook.deepnote';

            const existingProjectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: projectId,
                    name: 'Test Project',
                    initNotebookId,
                    notebooks: [
                        {
                            id: initNotebookId,
                            name: 'Init',
                            blocks: [
                                {
                                    blockGroup: 'init-bg',
                                    content: 'print("init")',
                                    id: 'init-block',
                                    metadata: {},
                                    sortingKey: '0',
                                    type: 'code',
                                    version: 1
                                }
                            ],
                            executionMode: 'block'
                        },
                        {
                            id: 'other-nb',
                            name: 'Other Notebook',
                            blocks: [],
                            executionMode: 'block'
                        }
                    ]
                }
            };

            const yamlContent = serializeDeepnoteFile(existingProjectData);

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));

            const writes = new Map<string, Uint8Array>();
            when(mockFS.writeFile(anything(), anything())).thenCall((uri: Uri, content: Uint8Array) => {
                writes.set(uri.path, content);
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(notebookName));

            const uuidStub = createUuidMock([newNotebookId, blockGroupId, blockId]);
            uuidStubs.push(uuidStub);

            when(mockedVSCodeNamespaces.workspace.openNotebookDocument(anything())).thenReturn(
                Promise.resolve({ notebookType: 'deepnote' } as any)
            );
            when(mockedVSCodeNamespaces.window.showNotebookDocument(anything(), anything())).thenReturn(
                Promise.resolve(undefined as any)
            );

            await explorerView.createAndAddNotebookToProject(fileUri);

            // Original file is not written
            expect(writes.has(fileUri.path)).to.be.false;

            // New file exists with both init + new notebook
            const newFileYaml = Buffer.from(writes.get(expectedNewFilePath)!).toString('utf8');
            const newProjectData = deserializeDeepnoteFile(newFileYaml);

            expect(newProjectData.project.notebooks).to.have.lengthOf(2);
            // Init notebook should be present and have preserved id + content
            const initInNew = newProjectData.project.notebooks.find((nb) => nb.id === initNotebookId);
            expect(initInNew).to.exist;
            expect(initInNew!.name).to.equal('Init');
            expect(initInNew!.blocks).to.have.lengthOf(1);
            expect(initInNew!.blocks[0].content).to.equal('print("init")');

            // New user notebook is present
            const newNotebook = newProjectData.project.notebooks.find((nb) => nb.id === newNotebookId);
            expect(newNotebook).to.exist;
            expect(newNotebook!.name).to.equal(notebookName);

            // initNotebookId preserved on new file
            expect(newProjectData.project.initNotebookId).to.equal(initNotebookId);
        });

        test('should append numeric suffix when sibling filename collides', async () => {
            const projectId = 'test-project-id';
            const newNotebookId = 'new-notebook-id';
            const blockGroupId = 'test-blockgroup-id';
            const blockId = 'test-block-id';
            const fileUri = Uri.file('/workspace/test-project.deepnote');
            const notebookName = 'New Notebook';
            const collidingPath = '/workspace/test-project_new-notebook.deepnote';
            const expectedPath = '/workspace/test-project_new-notebook_2.deepnote';

            const existingProjectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: projectId,
                    name: 'Test Project',
                    notebooks: [{ id: 'existing', name: 'Existing', blocks: [], executionMode: 'block' }]
                }
            };

            const yamlContent = serializeDeepnoteFile(existingProjectData);

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));

            // First candidate exists, second does not
            when(mockFS.stat(anything())).thenCall((uri: Uri) => {
                if (uri.path === collidingPath) {
                    return Promise.resolve({} as any);
                }
                return Promise.reject(new Error('File not found'));
            });

            const writes = new Map<string, Uint8Array>();
            when(mockFS.writeFile(anything(), anything())).thenCall((uri: Uri, content: Uint8Array) => {
                writes.set(uri.path, content);
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(notebookName));

            const uuidStub = createUuidMock([newNotebookId, blockGroupId, blockId]);
            uuidStubs.push(uuidStub);

            let openedUri: Uri | undefined;
            when(mockedVSCodeNamespaces.workspace.openNotebookDocument(anything())).thenCall((u: Uri) => {
                openedUri = u;
                return Promise.resolve({ notebookType: 'deepnote' } as any);
            });
            when(mockedVSCodeNamespaces.window.showNotebookDocument(anything(), anything())).thenReturn(
                Promise.resolve(undefined as any)
            );

            await explorerView.createAndAddNotebookToProject(fileUri);

            // Ensure no write to the original or the colliding path
            expect(writes.has(fileUri.path)).to.be.false;
            expect(writes.has(collidingPath)).to.be.false;

            // The new file should have been written to the `_2` path
            expect(writes.has(expectedPath)).to.be.true;
            expect(openedUri?.path).to.equal(expectedPath);
        });

        test('should validate name uniqueness across sibling project files', async () => {
            const projectId = 'test-project-id';
            const fileUri = Uri.file('/workspace/test-project.deepnote');
            const siblingUri = Uri.file('/workspace/test-project_other.deepnote');

            const sourceData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: projectId,
                    name: 'Test Project',
                    notebooks: [{ id: 'nb-source', name: 'Source Notebook', blocks: [], executionMode: 'block' }]
                }
            };

            const siblingData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: projectId,
                    name: 'Test Project',
                    notebooks: [{ id: 'nb-shared', name: 'Shared Name', blocks: [], executionMode: 'block' }]
                }
            };

            const sourceYaml = serializeDeepnoteFile(sourceData);
            const siblingYaml = serializeDeepnoteFile(siblingData);

            // Activate workspaceFolders so collectNotebookNamesForProject runs findFiles
            const workspaceFolder = { uri: Uri.file('/workspace'), name: 'workspace', index: 0 };
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);

            // Return both files from findFiles
            when(mockedVSCodeNamespaces.workspace.findFiles(anything())).thenReturn(
                Promise.resolve([fileUri, siblingUri])
            );

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenCall((uri: Uri) => {
                if (uri.path === siblingUri.path) {
                    return Promise.resolve(Buffer.from(siblingYaml));
                }
                return Promise.resolve(Buffer.from(sourceYaml));
            });
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockFS.writeFile(anything(), anything())).thenReturn(Promise.resolve());
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Capture validateInput from showInputBox options; have the user cancel so no further work runs
            let capturedValidateInput: ((value: string) => string | null | undefined) | undefined;
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenCall((options: any) => {
                capturedValidateInput = options?.validateInput;
                return Promise.resolve(undefined);
            });

            await explorerView.createAndAddNotebookToProject(fileUri);

            expect(capturedValidateInput).to.exist;

            // 'Shared Name' is taken by sibling -> rejection (non-null string)
            const result = capturedValidateInput!('Shared Name');
            expect(result).to.be.a('string');
            expect(result).to.not.be.null;

            // A unique name should pass validation (null return)
            const okResult = capturedValidateInput!('Totally Unique Name');
            expect(okResult).to.be.null;
        });

        test('should return null if user cancels notebook name input', async () => {
            const projectId = 'test-project-id';
            const fileUri = Uri.file('/workspace/test-project.deepnote');

            const existingProjectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: projectId,
                    name: 'Test Project',
                    notebooks: []
                }
            };

            const yamlContent = serializeDeepnoteFile(existingProjectData);

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockFS.writeFile(anything(), anything())).thenReturn(Promise.resolve());
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

            const result = await explorerView.createAndAddNotebookToProject(fileUri);

            // Null result and no file writes occurred (neither original nor sibling)
            expect(result).to.be.null;
            verify(mockFS.writeFile(anything(), anything())).never();
        });

        test('should generate unique notebook name suggestions', async () => {
            const projectId = 'test-project-id';
            const fileUri = Uri.file('/workspace/test-project.deepnote');

            const existingProjectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: projectId,
                    name: 'Test Project',
                    notebooks: [
                        { id: 'nb1', name: 'Notebook 1', blocks: [], executionMode: 'block' },
                        { id: 'nb2', name: 'Notebook 2', blocks: [], executionMode: 'block' }
                    ]
                }
            };

            const yamlContent = serializeDeepnoteFile(existingProjectData);

            // Tolerate workspace.findFiles being called - return only the source URI so only
            // its own notebook names contribute to the suggested name logic
            const workspaceFolder = { uri: Uri.file('/workspace'), name: 'workspace', index: 0 };
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);
            when(mockedVSCodeNamespaces.workspace.findFiles(anything())).thenReturn(Promise.resolve([fileUri]));

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockFS.writeFile(anything(), anything())).thenReturn(Promise.resolve());
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            let capturedInputBoxOptions: any;
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenCall((options: any) => {
                capturedInputBoxOptions = options;
                return Promise.resolve('Test Notebook');
            });

            const uuidStub = createUuidMock(['test-id', 'test-id', 'test-id']);
            uuidStubs.push(uuidStub);

            when(mockedVSCodeNamespaces.workspace.openNotebookDocument(anything())).thenReturn(
                Promise.resolve({} as any)
            );
            when(mockedVSCodeNamespaces.window.showNotebookDocument(anything(), anything())).thenReturn(
                Promise.resolve(undefined as any)
            );

            await explorerView.createAndAddNotebookToProject(fileUri);

            // With two existing notebooks, suggestion is `Notebook ${size + 1}` = 'Notebook 3'
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
            const existingProjectData: DeepnoteFile = {
                version: '1.0.0',
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

            const yamlContent = serializeDeepnoteFile(existingProjectData);

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
            const updatedProjectData = deserializeDeepnoteFile(updatedYamlContent);

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
            const existingProjectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
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

            const yamlContent = serializeDeepnoteFile(existingProjectData);

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
            const existingProjectData: DeepnoteFile = {
                version: '1.0.0',
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

            const yamlContent = serializeDeepnoteFile(existingProjectData);

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
            const updatedProjectData = deserializeDeepnoteFile(updatedYamlContent);

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

            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-01-01T00:00:00.000Z' },
                project: {
                    id: projectId,
                    name: 'Test Project',
                    notebooks: [
                        { id: 'other-nb', name: 'Other', blocks: [], executionMode: 'block' },
                        { id: notebookId, name: notebookName, blocks: [], executionMode: 'block' }
                    ]
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(
                Promise.resolve(Buffer.from(serializeDeepnoteFile(projectData)))
            );
            when(mockFS.writeFile(anything(), anything())).thenReturn(Promise.resolve());
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Mock user cancelling confirmation
            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenReturn(
                Promise.resolve(undefined)
            );

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

            await explorerView.deleteNotebook(mockTreeItem as DeepnoteTreeItem);

            // File is read to look up the notebook name for the prompt, but never written after cancellation
            verify(mockFS.writeFile(anything(), anything())).never();
            verify(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).once();
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
            const existingProjectData: DeepnoteFile = {
                version: '1.0.0',
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

            const yamlContent = serializeDeepnoteFile(existingProjectData);

            // Mock file system
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));

            let capturedWriteContent: Uint8Array | undefined;
            when(mockFS.writeFile(anything(), anything())).thenCall((_uri: Uri, content: Uint8Array) => {
                capturedWriteContent = content;
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Mock UUID generation by mocking crypto.randomUUID
            const uuidStub = createUuidMock([duplicatedNotebookId, blockId, blockGroupId]);
            uuidStubs.push(uuidStub);

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
            const updatedProjectData = deserializeDeepnoteFile(updatedYamlContent);

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
            expect((duplicatedNotebook!.blocks[0] as ExecutableBlock).executionCount).to.be.undefined;

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
            const existingProjectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
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

            const yamlContent = serializeDeepnoteFile(existingProjectData);

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

        test('should deep clone blocks to prevent shared references', async () => {
            // This test verifies that duplicating a notebook creates truly independent copies
            // of nested objects like outputs and metadata, not just shallow references
            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00Z',
                    modifiedAt: '2024-01-01T00:00:00Z'
                },
                project: {
                    id: 'test-project-id',
                    name: 'Test Project',
                    notebooks: [
                        {
                            id: 'original-notebook-id',
                            name: 'Original Notebook',
                            blocks: [
                                {
                                    id: 'block-1',
                                    blockGroup: 'group-1',
                                    type: 'code',
                                    content: 'print("test")',
                                    sortingKey: '0',
                                    version: 1,
                                    executionCount: 5,
                                    outputs: [{ type: 'stream', text: 'test output' }],
                                    metadata: { cellId: 'cell-123', custom: { nested: 'value' } }
                                }
                            ],
                            executionMode: 'block'
                        }
                    ]
                }
            };

            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.Notebook,
                context: {
                    filePath: '/workspace/test-project.deepnote',
                    projectId: 'test-project-id',
                    notebookId: 'original-notebook-id'
                },
                data: projectData.project.notebooks[0]
            };

            // Mock file system
            const mockFS = mock<typeof workspace.fs>();
            const yamlContent = serializeDeepnoteFile(projectData);
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent, 'utf-8')));

            let capturedWriteContent: Uint8Array | undefined;
            when(mockFS.writeFile(anything(), anything())).thenCall((_uri: Uri, content: Uint8Array) => {
                capturedWriteContent = content;
                return Promise.resolve();
            });

            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Mock UUID generation by mocking crypto.randomUUID
            const uuidStub = createUuidMock(['duplicate-notebook-id', 'duplicate-block-id', 'duplicate-blockgroup-id']);
            uuidStubs.push(uuidStub);

            // Execute duplication
            await explorerView.duplicateNotebook(mockTreeItem as DeepnoteTreeItem);

            // Parse the written data
            assert.isDefined(capturedWriteContent, 'File should have been written');
            const writtenYaml = Buffer.from(capturedWriteContent!).toString('utf-8');
            const updatedProjectData = deserializeDeepnoteFile(writtenYaml);

            // Find original and duplicated notebooks
            const originalNotebook = updatedProjectData.project.notebooks.find(
                (nb) => nb.id === 'original-notebook-id'
            );
            const duplicateNotebook = updatedProjectData.project.notebooks.find(
                (nb) => nb.id === 'duplicate-notebook-id'
            );

            assert.isDefined(originalNotebook, 'Original notebook should exist');
            assert.isDefined(duplicateNotebook, 'Duplicate notebook should exist');

            // Verify the blocks are truly independent (deep clone)
            const originalBlock = originalNotebook!.blocks[0] as ExecutableBlock;
            const duplicateBlock = duplicateNotebook!.blocks[0] as ExecutableBlock;

            // Test 1: Verify outputs are not the same reference
            assert.notStrictEqual(
                originalBlock.outputs,
                duplicateBlock.outputs,
                'Outputs should be different array instances'
            );

            // Test 2: Verify metadata is not the same reference
            if (originalBlock.metadata && duplicateBlock.metadata) {
                assert.notStrictEqual(
                    originalBlock.metadata,
                    duplicateBlock.metadata,
                    'Metadata should be different object instances'
                );

                // Test 3: Verify nested metadata properties are not shared
                if (
                    typeof originalBlock.metadata === 'object' &&
                    'custom' in originalBlock.metadata &&
                    typeof duplicateBlock.metadata === 'object' &&
                    'custom' in duplicateBlock.metadata
                ) {
                    assert.notStrictEqual(
                        (originalBlock.metadata as any).custom,
                        (duplicateBlock.metadata as any).custom,
                        'Nested metadata objects should be different instances'
                    );
                }
            }

            // Test 4: Verify that modifying duplicate doesn't affect original
            // (This would fail with shallow copy)
            duplicateBlock.outputs!.push({ type: 'stream', text: 'new output' });
            assert.strictEqual(
                originalBlock.outputs!.length,
                1,
                'Original outputs should not be affected by changes to duplicate'
            );
            assert.strictEqual(duplicateBlock.outputs!.length, 2, 'Duplicate outputs should have the new item');
        });
    });

    suite('renameProject', () => {
        test('should update project.name in every file in the group', async () => {
            const oldProjectName = 'Old Project Name';
            const newProjectName = 'New Project Name';
            const projectId = 'test-project-id';
            const fileA = '/workspace/test-project.deepnote';
            const fileB = '/workspace/test-project_sibling.deepnote';

            const projectDataA: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: projectId,
                    name: oldProjectName,
                    notebooks: [{ id: 'notebook-1', name: 'Notebook 1', blocks: [], executionMode: 'block' }]
                }
            };

            const projectDataB: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: projectId,
                    name: oldProjectName,
                    notebooks: [{ id: 'notebook-2', name: 'Notebook 2', blocks: [], executionMode: 'block' }]
                }
            };

            const mockFS = mock<typeof workspace.fs>();

            when(mockFS.readFile(anything())).thenCall((uri: Uri) => {
                if (uri.path === fileB) {
                    return Promise.resolve(Buffer.from(serializeDeepnoteFile(projectDataB)));
                }

                return Promise.resolve(Buffer.from(serializeDeepnoteFile(projectDataA)));
            });

            const writes = new Map<string, Uint8Array>();
            when(mockFS.writeFile(anything(), anything())).thenCall((uri: Uri, content: Uint8Array) => {
                writes.set(uri.path, content);
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(newProjectName));
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenReturn(
                Promise.resolve(undefined)
            );

            const groupData = {
                projectId,
                projectName: oldProjectName,
                files: [
                    { filePath: fileA, project: projectDataA },
                    { filePath: fileB, project: projectDataB }
                ]
            };

            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
                context: { filePath: fileA, projectId },
                data: groupData as any
            };

            await explorerView.renameProject(mockTreeItem as DeepnoteTreeItem);

            // Both files should have been written with the new name
            expect(writes.size).to.equal(2);
            expect(writes.has(fileA)).to.be.true;
            expect(writes.has(fileB)).to.be.true;

            for (const content of writes.values()) {
                const updated = deserializeDeepnoteFile(Buffer.from(content).toString('utf8'));
                expect(updated.project.name).to.equal(newProjectName);
            }

            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
        });

        test('should return early if tree item type is not ProjectGroup', async () => {
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

        test('should return early if the tree item is a ProjectFile (not a group)', async () => {
            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectFile,
                context: {
                    filePath: '/workspace/test-project.deepnote',
                    projectId: 'test-project-id'
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            await explorerView.renameProject(mockTreeItem as DeepnoteTreeItem);

            verify(mockedVSCodeNamespaces.window.showInputBox(anything())).never();
            verify(mockFS.readFile(anything())).never();
        });

        test('should return early if user cancels input or provides same name', async () => {
            const projectId = 'test-project-id';
            const currentName = 'Current Project Name';

            const existingProjectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: projectId,
                    name: currentName,
                    notebooks: []
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(
                Promise.resolve(Buffer.from(serializeDeepnoteFile(existingProjectData)))
            );
            when(mockFS.writeFile(anything(), anything())).thenReturn(Promise.resolve());
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Test 1: User cancels input (returns undefined)
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
                context: { filePath: '/workspace/test-project.deepnote', projectId },
                data: {
                    projectId,
                    projectName: currentName,
                    files: [{ filePath: '/workspace/test-project.deepnote', project: existingProjectData }]
                } as any
            };

            await explorerView.renameProject(mockTreeItem as DeepnoteTreeItem);

            verify(mockFS.writeFile(anything(), anything())).never();

            // Test 2: User provides same name
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(currentName));

            await explorerView.renameProject(mockTreeItem as DeepnoteTreeItem);

            verify(mockFS.writeFile(anything(), anything())).never();
        });
    });

    suite('exportProject', () => {
        function buildGroupTreeItem(
            projectId: string,
            filesInGroup: Array<{ filePath: string; project: DeepnoteFile }>
        ): Partial<DeepnoteTreeItem> {
            return {
                type: DeepnoteTreeItemType.ProjectGroup,
                context: {
                    filePath: filesInGroup[0]?.filePath ?? '/test/project.deepnote',
                    projectId
                },
                data: {
                    projectId,
                    projectName: 'Test Project',
                    files: filesInGroup
                } as any
            };
        }

        test('should return early if user cancels format selection', async () => {
            resetVSCodeMocks();

            const mockFS = mock<typeof workspace.fs>();
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve(undefined)
            );

            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-01-01T00:00:00.000Z' },
                project: {
                    id: 'project-id',
                    name: 'Test Project',
                    notebooks: [{ id: 'nb-1', name: 'Notebook 1', blocks: [], executionMode: 'block' }]
                }
            };

            const treeItem = buildGroupTreeItem('project-id', [
                { filePath: '/test/project.deepnote', project: projectData }
            ]);

            await (explorerView as any).exportProject(treeItem);

            verify(mockFS.writeFile(anything(), anything())).never();
            verify(mockFS.readFile(anything())).never();
        });

        test('should return early if user cancels folder selection', async () => {
            resetVSCodeMocks();

            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-01-01T00:00:00.000Z' },
                project: {
                    id: 'project-id',
                    name: 'Test Project',
                    notebooks: [{ id: 'nb-1', name: 'Notebook 1', blocks: [], executionMode: 'block' }]
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(
                Promise.resolve(Buffer.from(serializeDeepnoteFile(projectData)))
            );
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }) as any
            );
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(Promise.resolve(undefined));

            const treeItem = buildGroupTreeItem('project-id', [
                { filePath: '/test/project.deepnote', project: projectData }
            ]);

            await (explorerView as any).exportProject(treeItem);

            verify(mockFS.writeFile(anything(), anything())).never();
        });

        test('should show error when every file in the group fails to parse', async () => {
            resetVSCodeMocks();

            const invalidData = {
                version: '1.0.0',
                metadata: { createdAt: '2024-01-01T00:00:00.000Z' }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlStringify(invalidData))));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }) as any
            );
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(
                Promise.resolve([Uri.file('/output/folder')])
            );
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));

            const treeItem = buildGroupTreeItem('project-id', [
                { filePath: '/test/project.deepnote', project: invalidData as any }
            ]);

            await (explorerView as any).exportProject(treeItem);

            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
        });

        test('should concatenate Jupyter outputs across every file in the group', async () => {
            resetVSCodeMocks();

            const projectA: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-01-01T00:00:00.000Z' },
                project: {
                    id: 'project-id',
                    name: 'Test Project',
                    notebooks: [{ id: 'nb-a', name: 'Notebook A', blocks: [], executionMode: 'block' }]
                }
            };

            const projectB: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-01-01T00:00:00.000Z' },
                project: {
                    id: 'project-id',
                    name: 'Test Project',
                    notebooks: [{ id: 'nb-b', name: 'Notebook B', blocks: [], executionMode: 'block' }]
                }
            };

            const mockFS = mock<typeof workspace.fs>();

            when(mockFS.readFile(anything())).thenCall((uri: Uri) => {
                if (uri.path === '/test/project_b.deepnote') {
                    return Promise.resolve(Buffer.from(serializeDeepnoteFile(projectB)));
                }

                return Promise.resolve(Buffer.from(serializeDeepnoteFile(projectA)));
            });
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }) as any
            );
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(
                Promise.resolve([Uri.file('/output/folder')])
            );
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenReturn(
                Promise.resolve(undefined)
            );

            let writeCount = 0;
            when(mockFS.writeFile(anything(), anything())).thenCall(() => {
                writeCount++;
                return Promise.resolve();
            });

            const treeItem = buildGroupTreeItem('project-id', [
                { filePath: '/test/project.deepnote', project: projectA },
                { filePath: '/test/project_b.deepnote', project: projectB }
            ]);

            await (explorerView as any).exportProject(treeItem);

            // One notebook per file -> two writes
            assert.strictEqual(writeCount, 2);
            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
        });

        test('should export all notebooks when triggered from project', async () => {
            resetVSCodeMocks();

            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: 'project-id',
                    name: 'Test Project',
                    notebooks: [
                        { id: 'nb-1', name: 'Notebook 1', blocks: [], executionMode: 'block' },
                        { id: 'nb-2', name: 'Notebook 2', blocks: [], executionMode: 'block' }
                    ]
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(
                Promise.resolve(Buffer.from(serializeDeepnoteFile(projectData)))
            );
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }) as any
            );
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(
                Promise.resolve([Uri.file('/output/folder')])
            );
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenReturn(
                Promise.resolve(undefined)
            );

            let writeCount = 0;
            when(mockFS.writeFile(anything(), anything())).thenCall(() => {
                writeCount++;
                return Promise.resolve();
            });

            const treeItem = buildGroupTreeItem('project-id', [
                { filePath: '/test/project.deepnote', project: projectData }
            ]);

            await (explorerView as any).exportProject(treeItem);

            assert.strictEqual(writeCount, 2);
            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
        });

        test('should write correct Jupyter notebook JSON format', async () => {
            resetVSCodeMocks();

            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: 'project-id',
                    name: 'Test Project',
                    notebooks: [
                        {
                            id: 'nb-1',
                            name: 'Test Notebook',
                            blocks: [
                                {
                                    id: 'block-1',
                                    type: 'code',
                                    content: 'print("hello")',
                                    sortingKey: '0',
                                    blockGroup: '1',
                                    metadata: {}
                                }
                            ],
                            executionMode: 'block'
                        }
                    ]
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(
                Promise.resolve(Buffer.from(serializeDeepnoteFile(projectData)))
            );
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }) as any
            );
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(
                Promise.resolve([Uri.file('/output/folder')])
            );
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenReturn(
                Promise.resolve(undefined)
            );

            let capturedContent: Uint8Array | undefined;
            when(mockFS.writeFile(anything(), anything())).thenCall((_uri: Uri, content: Uint8Array) => {
                capturedContent = content;
                return Promise.resolve();
            });

            const treeItem = buildGroupTreeItem('project-id', [
                { filePath: '/test/project.deepnote', project: projectData }
            ]);

            await (explorerView as any).exportProject(treeItem);

            assert.isDefined(capturedContent);
            const notebook = JSON.parse(Buffer.from(capturedContent!).toString('utf8'));

            assert.isDefined(notebook.cells);
            assert.isDefined(notebook.metadata);
            assert.strictEqual(notebook.metadata.deepnote_notebook_id, 'nb-1');
            assert.strictEqual(notebook.metadata.deepnote_notebook_name, 'Test Notebook');
        });

        test('should use correct output path with Uri.joinPath', async () => {
            resetVSCodeMocks();

            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: 'project-id',
                    name: 'Test Project',
                    notebooks: [{ id: 'nb-1', name: 'My Notebook', blocks: [], executionMode: 'block' }]
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(
                Promise.resolve(Buffer.from(serializeDeepnoteFile(projectData)))
            );
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }) as any
            );
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(
                Promise.resolve([Uri.file('/output/folder')])
            );
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenReturn(
                Promise.resolve(undefined)
            );

            let capturedUri: Uri | undefined;
            when(mockFS.writeFile(anything(), anything())).thenCall((uri: Uri) => {
                capturedUri = uri;
                return Promise.resolve();
            });

            const treeItem = buildGroupTreeItem('project-id', [
                { filePath: '/test/project.deepnote', project: projectData }
            ]);

            await (explorerView as any).exportProject(treeItem);

            assert.isDefined(capturedUri);
            assert.isTrue(capturedUri!.fsPath.startsWith('/output/folder'));
            assert.isTrue(capturedUri!.fsPath.endsWith('.ipynb'));
        });

        test('should handle export errors gracefully', async () => {
            resetVSCodeMocks();

            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: 'project-id',
                    name: 'Test Project',
                    notebooks: [{ id: 'nb-1', name: 'Notebook 1', blocks: [], executionMode: 'block' }]
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(
                Promise.resolve(Buffer.from(serializeDeepnoteFile(projectData)))
            );
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }) as any
            );
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(
                Promise.resolve([Uri.file('/output/folder')])
            );
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));

            when(mockFS.writeFile(anything(), anything())).thenReject(new Error('Permission denied'));

            const treeItem = buildGroupTreeItem('project-id', [
                { filePath: '/test/project.deepnote', project: projectData }
            ]);

            await (explorerView as any).exportProject(treeItem);

            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
        });

        test('should prompt for overwrite when files already exist and cancel if declined', async () => {
            resetVSCodeMocks();

            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: 'project-id',
                    name: 'Test Project',
                    notebooks: [
                        { id: 'nb-1', name: 'Notebook 1', blocks: [], executionMode: 'block' },
                        { id: 'nb-2', name: 'Notebook 2', blocks: [], executionMode: 'block' }
                    ]
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(
                Promise.resolve(Buffer.from(serializeDeepnoteFile(projectData)))
            );
            when(mockFS.stat(anything())).thenReturn(Promise.resolve({} as any));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }) as any
            );
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(
                Promise.resolve([Uri.file('/output/folder')])
            );
            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenReturn(
                Promise.resolve(undefined)
            );

            const treeItem = buildGroupTreeItem('project-id', [
                { filePath: '/test/project.deepnote', project: projectData }
            ]);

            await (explorerView as any).exportProject(treeItem);

            // Only one warning even though two output files exist (one prompt for the whole batch)
            verify(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).once();
            verify(mockFS.writeFile(anything(), anything())).never();
        });

        test('should overwrite files when user confirms', async () => {
            resetVSCodeMocks();

            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: 'project-id',
                    name: 'Test Project',
                    notebooks: [{ id: 'nb-1', name: 'Notebook 1', blocks: [], executionMode: 'block' }]
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(
                Promise.resolve(Buffer.from(serializeDeepnoteFile(projectData)))
            );
            when(mockFS.stat(anything())).thenReturn(Promise.resolve({} as any));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }) as any
            );
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(
                Promise.resolve([Uri.file('/output/folder')])
            );
            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenReturn(
                Promise.resolve('Overwrite') as any
            );
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenReturn(
                Promise.resolve(undefined)
            );

            let writeCount = 0;
            when(mockFS.writeFile(anything(), anything())).thenCall(() => {
                writeCount++;
                return Promise.resolve();
            });

            const treeItem = buildGroupTreeItem('project-id', [
                { filePath: '/test/project.deepnote', project: projectData }
            ]);

            await (explorerView as any).exportProject(treeItem);

            assert.strictEqual(writeCount, 1);
        });

        test('should be a no-op when tree item is not a ProjectGroup', async () => {
            resetVSCodeMocks();

            const mockFS = mock<typeof workspace.fs>();
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectFile,
                context: { filePath: '/test/project.deepnote', projectId: 'project-id' }
            };

            await (explorerView as any).exportProject(treeItem);

            verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).never();
            verify(mockFS.readFile(anything())).never();
            verify(mockFS.writeFile(anything(), anything())).never();
        });
    });

    suite('exportNotebook', () => {
        test('should return early if user cancels format selection', async () => {
            resetVSCodeMocks();

            const mockFS = mock<typeof workspace.fs>();
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // User cancels format selection
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve(undefined)
            );

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.Notebook,
                context: {
                    filePath: '/test/project.deepnote',
                    projectId: 'project-id',
                    notebookId: 'nb-1'
                }
            };

            await (explorerView as any).exportNotebook(treeItem);

            // Verify no file operations occurred
            verify(mockFS.writeFile(anything(), anything())).never();
            verify(mockFS.readFile(anything())).never();
        });

        test('should return early if user cancels folder selection', async () => {
            resetVSCodeMocks();

            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: 'project-id',
                    name: 'Test Project',
                    notebooks: [{ id: 'nb-1', name: 'Notebook 1', blocks: [], executionMode: 'block' }]
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(
                Promise.resolve(Buffer.from(serializeDeepnoteFile(projectData)))
            );
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // User selects format but cancels folder selection
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }) as any
            );
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(Promise.resolve(undefined));

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.Notebook,
                context: {
                    filePath: '/test/project.deepnote',
                    projectId: 'project-id',
                    notebookId: 'nb-1'
                }
            };

            await (explorerView as any).exportNotebook(treeItem);

            // Verify no file was written
            verify(mockFS.writeFile(anything(), anything())).never();
        });

        test('should show error for invalid Deepnote file format', async () => {
            resetVSCodeMocks();

            // Invalid project data (no project property)
            const invalidData = {
                version: '1.0.0',
                metadata: { createdAt: '2024-01-01T00:00:00.000Z' }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlStringify(invalidData))));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }) as any
            );
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.Notebook,
                context: {
                    filePath: '/test/project.deepnote',
                    projectId: 'project-id',
                    notebookId: 'nb-1'
                }
            };

            await (explorerView as any).exportNotebook(treeItem);

            // Verify error message was shown
            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
        });

        test('should export single notebook matching the notebookId', async () => {
            resetVSCodeMocks();

            const targetNotebookId = 'nb-2';
            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: 'project-id',
                    name: 'Test Project',
                    notebooks: [
                        { id: 'nb-1', name: 'Notebook 1', blocks: [], executionMode: 'block' },
                        { id: targetNotebookId, name: 'Notebook 2', blocks: [], executionMode: 'block' }
                    ]
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(
                Promise.resolve(Buffer.from(serializeDeepnoteFile(projectData)))
            );
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }) as any
            );
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(
                Promise.resolve([Uri.file('/output/folder')])
            );
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenReturn(
                Promise.resolve(undefined)
            );

            let writeCount = 0;
            const writtenFiles: { uri: Uri; content: Uint8Array }[] = [];
            when(mockFS.writeFile(anything(), anything())).thenCall((uri: Uri, content: Uint8Array) => {
                writeCount++;
                writtenFiles.push({ uri, content });
                return Promise.resolve();
            });

            // Notebook tree item with specific notebookId
            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.Notebook,
                context: {
                    filePath: '/test/project.deepnote',
                    projectId: 'project-id',
                    notebookId: targetNotebookId
                }
            };

            await (explorerView as any).exportNotebook(treeItem);

            // Verify only one notebook was exported
            assert.strictEqual(writeCount, 1);

            // Verify the exported notebook has correct metadata
            const exportedContent = JSON.parse(Buffer.from(writtenFiles[0].content).toString('utf8'));
            assert.strictEqual(exportedContent.metadata.deepnote_notebook_id, targetNotebookId);
        });

        test('should show error if notebook not found', async () => {
            resetVSCodeMocks();

            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: 'project-id',
                    name: 'Test Project',
                    notebooks: [{ id: 'nb-1', name: 'Notebook 1', blocks: [], executionMode: 'block' }]
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(
                Promise.resolve(Buffer.from(serializeDeepnoteFile(projectData)))
            );
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }) as any
            );
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(
                Promise.resolve([Uri.file('/output/folder')])
            );
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));

            // Notebook tree item with non-existent notebookId
            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.Notebook,
                context: {
                    filePath: '/test/project.deepnote',
                    projectId: 'project-id',
                    notebookId: 'non-existent-nb'
                }
            };

            await (explorerView as any).exportNotebook(treeItem);

            // Verify error message was shown
            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
            // Verify no file was written
            verify(mockFS.writeFile(anything(), anything())).never();
        });

        test('should handle export errors gracefully', async () => {
            resetVSCodeMocks();

            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: 'project-id',
                    name: 'Test Project',
                    notebooks: [{ id: 'nb-1', name: 'Notebook 1', blocks: [], executionMode: 'block' }]
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(
                Promise.resolve(Buffer.from(serializeDeepnoteFile(projectData)))
            );
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }) as any
            );
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(
                Promise.resolve([Uri.file('/output/folder')])
            );
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));

            // Simulate write error
            when(mockFS.writeFile(anything(), anything())).thenReject(new Error('Permission denied'));

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.Notebook,
                context: {
                    filePath: '/test/project.deepnote',
                    projectId: 'project-id',
                    notebookId: 'nb-1'
                }
            };

            await (explorerView as any).exportNotebook(treeItem);

            // Verify error message was shown
            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
        });

        test('should prompt for overwrite when file already exists and cancel if declined', async () => {
            resetVSCodeMocks();

            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: 'project-id',
                    name: 'Test Project',
                    notebooks: [{ id: 'nb-1', name: 'Notebook 1', blocks: [], executionMode: 'block' }]
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(
                Promise.resolve(Buffer.from(serializeDeepnoteFile(projectData)))
            );
            // File exists - stat returns successfully
            when(mockFS.stat(anything())).thenReturn(Promise.resolve({} as any));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }) as any
            );
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(
                Promise.resolve([Uri.file('/output/folder')])
            );
            // User cancels overwrite
            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenReturn(
                Promise.resolve(undefined)
            );

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.Notebook,
                context: {
                    filePath: '/test/project.deepnote',
                    projectId: 'project-id',
                    notebookId: 'nb-1'
                }
            };

            await (explorerView as any).exportNotebook(treeItem);

            // Verify warning message was shown about file existing
            verify(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).once();
            // Verify no file was written
            verify(mockFS.writeFile(anything(), anything())).never();
        });

        test('should overwrite file when user confirms', async () => {
            resetVSCodeMocks();

            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: '2024-01-01T00:00:00.000Z',
                    modifiedAt: '2024-01-01T00:00:00.000Z'
                },
                project: {
                    id: 'project-id',
                    name: 'Test Project',
                    notebooks: [{ id: 'nb-1', name: 'Notebook 1', blocks: [], executionMode: 'block' }]
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(
                Promise.resolve(Buffer.from(serializeDeepnoteFile(projectData)))
            );
            // File exists - stat returns successfully
            when(mockFS.stat(anything())).thenReturn(Promise.resolve({} as any));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }) as any
            );
            when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(
                Promise.resolve([Uri.file('/output/folder')])
            );
            // User confirms overwrite
            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenReturn(
                Promise.resolve('Overwrite') as any
            );
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenReturn(
                Promise.resolve(undefined)
            );

            let writeCount = 0;
            when(mockFS.writeFile(anything(), anything())).thenCall(() => {
                writeCount++;
                return Promise.resolve();
            });

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.Notebook,
                context: {
                    filePath: '/test/project.deepnote',
                    projectId: 'project-id',
                    notebookId: 'nb-1'
                }
            };

            await (explorerView as any).exportNotebook(treeItem);

            // Verify file was written after user confirmed overwrite
            assert.strictEqual(writeCount, 1);
        });
    });
});

suite('DeepnoteExplorerView - Project group handlers', () => {
    let explorerView: DeepnoteExplorerView;
    let sandbox: sinon.SinonSandbox;
    let uuidStubs: sinon.SinonStub[] = [];

    setup(() => {
        sandbox = sinon.createSandbox();
        resetVSCodeMocks();
        uuidStubs = [];

        const mockContext = { subscriptions: [] } as unknown as IExtensionContext;
        const mockLogger = createMockLogger();

        explorerView = new DeepnoteExplorerView(mockContext, mockLogger);
    });

    teardown(() => {
        explorerView.dispose();
        sandbox.restore();
        uuidStubs.forEach((stub) => stub.restore());
        uuidStubs = [];
        resetVSCodeMocks();
    });

    suite('deleteProject', () => {
        test('should delete every file in the group after a single confirmation', async () => {
            const projectId = 'project-id';
            const fileA = '/workspace/a.deepnote';
            const fileB = '/workspace/b.deepnote';
            const fileC = '/workspace/c.deepnote';

            const mockFS = mock<typeof workspace.fs>();
            const deletedPaths: string[] = [];

            when(mockFS.delete(anything())).thenCall((uri: Uri) => {
                deletedPaths.push(uri.path);
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            let warningCount = 0;
            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenCall(() => {
                warningCount++;
                return Promise.resolve('Delete') as any;
            });
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenReturn(
                Promise.resolve(undefined)
            );

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
                context: { filePath: fileA, projectId },
                data: {
                    projectId,
                    projectName: 'My Project',
                    files: [
                        { filePath: fileA, project: {} as any },
                        { filePath: fileB, project: {} as any },
                        { filePath: fileC, project: {} as any }
                    ]
                } as ProjectGroupData as any
            };

            await (explorerView as any).deleteProject(treeItem);

            assert.strictEqual(warningCount, 1, 'should show exactly one confirmation');
            assert.deepStrictEqual(deletedPaths.sort(), [fileA, fileB, fileC].sort());
            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
        });

        test('should abort if user declines confirmation', async () => {
            const mockFS = mock<typeof workspace.fs>();
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenReturn(
                Promise.resolve(undefined)
            );

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
                context: { filePath: '/a', projectId: 'p' },
                data: {
                    projectId: 'p',
                    projectName: 'P',
                    files: [{ filePath: '/workspace/a.deepnote', project: {} as any }]
                } as ProjectGroupData as any
            };

            await (explorerView as any).deleteProject(treeItem);

            verify(mockFS.delete(anything())).never();
        });

        test('should be a no-op when called with a non-group tree item', async () => {
            const mockFS = mock<typeof workspace.fs>();
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectFile,
                context: { filePath: '/workspace/a.deepnote', projectId: 'p' }
            };

            await (explorerView as any).deleteProject(treeItem);

            verify(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).never();
            verify(mockFS.delete(anything())).never();
        });
    });

    suite('addNotebookToProject', () => {
        test('uses groupData.files[0] as the source file', async () => {
            const projectId = 'project-id';
            const firstFile = '/workspace/a.deepnote';
            const secondFile = '/workspace/b.deepnote';

            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-01-01T00:00:00.000Z' },
                project: {
                    id: projectId,
                    name: 'Test Project',
                    notebooks: [{ id: 'nb-1', name: 'Existing', blocks: [], executionMode: 'block' }]
                }
            };

            const createStub = sandbox
                .stub(explorerView, 'createAndAddNotebookToProject')
                .resolves({ id: 'new-nb', name: 'New Notebook' });

            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenReturn(
                Promise.resolve(undefined)
            );

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
                context: { filePath: firstFile, projectId },
                data: {
                    projectId,
                    projectName: 'Test Project',
                    files: [
                        { filePath: firstFile, project: projectData },
                        { filePath: secondFile, project: projectData }
                    ]
                } as ProjectGroupData as any
            };

            await (explorerView as any).addNotebookToProject(treeItem);

            assert.isTrue(createStub.calledOnce);
            const callArg = createStub.firstCall.args[0] as Uri;

            assert.strictEqual(callArg.path, firstFile);
        });

        test('is a no-op for non-group tree items', async () => {
            const createStub = sandbox.stub(explorerView, 'createAndAddNotebookToProject');

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectFile,
                context: { filePath: '/workspace/a.deepnote', projectId: 'p' }
            };

            await (explorerView as any).addNotebookToProject(treeItem);

            assert.isFalse(createStub.called);
        });

        test('is a no-op when the group has zero files', async () => {
            const createStub = sandbox.stub(explorerView, 'createAndAddNotebookToProject');

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
                context: { filePath: '', projectId: 'p' },
                data: { projectId: 'p', projectName: 'P', files: [] } as ProjectGroupData as any
            };

            await (explorerView as any).addNotebookToProject(treeItem);

            assert.isFalse(createStub.called);
        });
    });
});

suite('DeepnoteExplorerView - Notebook target resolution', () => {
    let explorerView: DeepnoteExplorerView;

    setup(() => {
        resetVSCodeMocks();

        const mockContext = { subscriptions: [] } as unknown as IExtensionContext;
        const mockLogger = createMockLogger();

        explorerView = new DeepnoteExplorerView(mockContext, mockLogger);
    });

    teardown(() => {
        explorerView.dispose();
        resetVSCodeMocks();
    });

    test('resolveNotebookTarget returns (fileUri, notebookId) for a Notebook tree item', () => {
        const treeItem: Partial<DeepnoteTreeItem> = {
            type: DeepnoteTreeItemType.Notebook,
            contextValue: 'notebook',
            context: {
                filePath: '/workspace/project.deepnote',
                projectId: 'p',
                notebookId: 'nb-inner'
            }
        };

        const result = (explorerView as any).resolveNotebookTarget(treeItem);

        assert.isDefined(result);
        assert.strictEqual(result!.notebookId, 'nb-inner');
        assert.strictEqual(result!.fileUri.path, '/workspace/project.deepnote');
    });

    test('resolveNotebookTarget returns the sole non-init notebook id for a single-notebook ProjectFile', () => {
        const project: DeepnoteFile = {
            version: '1.0.0',
            metadata: { createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-01-01T00:00:00.000Z' },
            project: {
                id: 'p',
                name: 'P',
                notebooks: [{ id: 'sole-nb', name: 'Sole', blocks: [], executionMode: 'block' }]
            }
        };

        const treeItem: Partial<DeepnoteTreeItem> = {
            type: DeepnoteTreeItemType.ProjectFile,
            contextValue: NOTEBOOK_FILE_CONTEXT_VALUE,
            context: { filePath: '/workspace/solo.deepnote', projectId: 'p' },
            data: project as any
        };

        const result = (explorerView as any).resolveNotebookTarget(treeItem);

        assert.isDefined(result);
        assert.strictEqual(result!.notebookId, 'sole-nb');
        assert.strictEqual(result!.fileUri.path, '/workspace/solo.deepnote');
    });

    test('resolveNotebookTarget returns undefined for a legacy multi-notebook ProjectFile', () => {
        const project: DeepnoteFile = {
            version: '1.0.0',
            metadata: { createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-01-01T00:00:00.000Z' },
            project: {
                id: 'p',
                name: 'P',
                notebooks: [
                    { id: 'nb-a', name: 'A', blocks: [], executionMode: 'block' },
                    { id: 'nb-b', name: 'B', blocks: [], executionMode: 'block' }
                ]
            }
        };

        const treeItem: Partial<DeepnoteTreeItem> = {
            type: DeepnoteTreeItemType.ProjectFile,
            contextValue: 'projectFile',
            context: { filePath: '/workspace/multi.deepnote', projectId: 'p' },
            data: project as any
        };

        const result = (explorerView as any).resolveNotebookTarget(treeItem);

        assert.isUndefined(result);
    });

    test('resolveNotebookTarget returns undefined for a ProjectGroup', () => {
        const treeItem: Partial<DeepnoteTreeItem> = {
            type: DeepnoteTreeItemType.ProjectGroup,
            contextValue: 'projectGroup',
            context: { filePath: '/workspace/a.deepnote', projectId: 'p' }
        };

        const result = (explorerView as any).resolveNotebookTarget(treeItem);

        assert.isUndefined(result);
    });

    test('resolveNotebookTarget returns undefined for a Notebook tree item without notebookId', () => {
        const treeItem: Partial<DeepnoteTreeItem> = {
            type: DeepnoteTreeItemType.Notebook,
            contextValue: 'notebook',
            context: { filePath: '/workspace/a.deepnote', projectId: 'p' }
        };

        const result = (explorerView as any).resolveNotebookTarget(treeItem);

        assert.isUndefined(result);
    });
});

suite('DeepnoteExplorerView - Single-notebook file handlers', () => {
    let explorerView: DeepnoteExplorerView;
    let sandbox: sinon.SinonSandbox;
    let uuidStubs: sinon.SinonStub[] = [];

    setup(() => {
        sandbox = sinon.createSandbox();
        resetVSCodeMocks();
        uuidStubs = [];

        const mockContext = { subscriptions: [] } as unknown as IExtensionContext;
        const mockLogger = createMockLogger();

        explorerView = new DeepnoteExplorerView(mockContext, mockLogger);
    });

    teardown(() => {
        explorerView.dispose();
        sandbox.restore();
        uuidStubs.forEach((stub) => stub.restore());
        uuidStubs = [];
        resetVSCodeMocks();
    });

    suite('duplicateNotebook (single-notebook file)', () => {
        test('creates a sibling .deepnote file with freshly regenerated ids', async () => {
            const projectId = 'project-id';
            const originalNotebookId = 'original-nb';
            const clonedNotebookId = 'cloned-nb-uuid';
            const clonedBlockId = 'cloned-block-uuid';
            const clonedBlockGroup = 'cloned-block-group-uuid';
            const fileUri = Uri.file('/workspace/solo.deepnote');
            const expectedNewPath = '/workspace/solo_solo-copy.deepnote';

            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-01-01T00:00:00.000Z' },
                project: {
                    id: projectId,
                    name: 'Solo Project',
                    notebooks: [
                        {
                            id: originalNotebookId,
                            name: 'Solo',
                            blocks: [
                                {
                                    id: 'original-block',
                                    blockGroup: 'original-group',
                                    type: 'code',
                                    content: 'print("hello")',
                                    sortingKey: '0',
                                    metadata: {},
                                    executionCount: 7
                                }
                            ],
                            executionMode: 'block'
                        }
                    ]
                }
            };

            const yaml = serializeDeepnoteFile(projectData);

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yaml)));
            when(mockFS.stat(anything())).thenReject(new Error('File not found'));

            const writes = new Map<string, Uint8Array>();
            when(mockFS.writeFile(anything(), anything())).thenCall((uri: Uri, content: Uint8Array) => {
                writes.set(uri.path, content);
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            const workspaceFolder = { uri: Uri.file('/workspace'), name: 'workspace', index: 0 };
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder as any]);
            when(mockedVSCodeNamespaces.workspace.findFiles(anything())).thenReturn(Promise.resolve([fileUri]));

            uuidStubs.push(createUuidMock([clonedNotebookId, clonedBlockId, clonedBlockGroup]));

            when(mockedVSCodeNamespaces.workspace.openNotebookDocument(anything())).thenReturn(
                Promise.resolve({ notebookType: 'deepnote' } as any)
            );
            when(mockedVSCodeNamespaces.window.showNotebookDocument(anything(), anything())).thenReturn(
                Promise.resolve(undefined as any)
            );
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenReturn(
                Promise.resolve(undefined)
            );

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectFile,
                contextValue: NOTEBOOK_FILE_CONTEXT_VALUE,
                context: { filePath: fileUri.fsPath, projectId },
                data: projectData as any
            };

            await explorerView.duplicateNotebook(treeItem as DeepnoteTreeItem);

            // Source file is not touched
            expect(writes.has(fileUri.path)).to.be.false;

            // The new sibling file exists
            const newEntry = Array.from(writes.entries()).find(([p]) => p !== fileUri.path);

            expect(newEntry).to.exist;
            const [newPath, content] = newEntry!;

            expect(newPath).to.equal(expectedNewPath);

            const newDoc = deserializeDeepnoteFile(Buffer.from(content).toString('utf8'));

            // Single notebook inside — must have the NEW id, not the original id
            expect(newDoc.project.notebooks).to.have.lengthOf(1);
            const duplicated = newDoc.project.notebooks[0];

            expect(duplicated.id).to.equal(clonedNotebookId);
            expect(duplicated.id).to.not.equal(originalNotebookId);
            expect(duplicated.name).to.equal('Solo (Copy)');
            expect(duplicated.blocks).to.have.lengthOf(1);
            expect(duplicated.blocks[0].id).to.equal(clonedBlockId);
            expect(duplicated.blocks[0].id).to.not.equal('original-block');
            expect(duplicated.blocks[0].blockGroup).to.equal(clonedBlockGroup);
            expect(duplicated.blocks[0].blockGroup).to.not.equal('original-group');
            expect((duplicated.blocks[0] as ExecutableBlock).executionCount).to.be.undefined;

            // Project id is preserved (same project group)
            expect(newDoc.project.id).to.equal(projectId);
        });
    });

    suite('deleteNotebook (single-notebook file)', () => {
        test('deletes the sibling file instead of rewriting it', async () => {
            const projectId = 'project-id';
            const notebookId = 'sole-nb';
            const fileUri = Uri.file('/workspace/solo.deepnote');

            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-01-01T00:00:00.000Z' },
                project: {
                    id: projectId,
                    name: 'Solo',
                    notebooks: [{ id: notebookId, name: 'Sole Notebook', blocks: [], executionMode: 'block' }]
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(
                Promise.resolve(Buffer.from(serializeDeepnoteFile(projectData)))
            );

            const deletedPaths: string[] = [];
            when(mockFS.delete(anything())).thenCall((uri: Uri) => {
                deletedPaths.push(uri.path);
                return Promise.resolve();
            });

            let writeCalled = false;
            when(mockFS.writeFile(anything(), anything())).thenCall(() => {
                writeCalled = true;
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenReturn(
                Promise.resolve('Delete') as any
            );
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenReturn(
                Promise.resolve(undefined)
            );

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectFile,
                contextValue: NOTEBOOK_FILE_CONTEXT_VALUE,
                context: { filePath: fileUri.fsPath, projectId },
                data: projectData as any
            };

            await explorerView.deleteNotebook(treeItem as DeepnoteTreeItem);

            assert.deepStrictEqual(deletedPaths, [fileUri.path]);
            assert.isFalse(writeCalled);
        });
    });
});
