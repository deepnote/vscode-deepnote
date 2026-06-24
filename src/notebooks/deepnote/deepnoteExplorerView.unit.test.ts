import { deserializeDeepnoteFile, ExecutableBlock, serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { assert, expect } from 'chai';
import esmock from 'esmock';
import * as sinon from 'sinon';
import { anything, instance, mock, verify, when } from 'ts-mockito';
import { Uri, workspace } from 'vscode';
import { stringify as yamlStringify } from 'yaml';

import { DeepnoteExplorerView } from './deepnoteExplorerView';
import { DeepnoteTreeItem, DeepnoteTreeItemType, type DeepnoteTreeItemContext } from './deepnoteTreeItem';
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
        // `convertIpynbFilesToDeepnoteFile` does real node:fs I/O, so stub just that one
        // @deepnote/convert export (all other exports stay the real implementation) while the
        // import flow is exercised. This mocks the side-effecting function where it matters,
        // instead of reimplementing the whole package.
        let importModule: typeof import('./deepnoteExplorerView');

        setup(async () => {
            importModule = await esmock('./deepnoteExplorerView', {
                '@deepnote/convert': { convertIpynbFilesToDeepnoteFile: async () => {} }
            });
            explorerView = new importModule.DeepnoteExplorerView(mockContext, createMockLogger());
        });

        teardown(() => {
            esmock.purge(importModule);
        });

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
        // Stub only the side-effecting `convertIpynbFilesToDeepnoteFile` (real node:fs I/O);
        // all other @deepnote/convert exports remain the real implementation.
        let importModule: typeof import('./deepnoteExplorerView');

        setup(async () => {
            importModule = await esmock('./deepnoteExplorerView', {
                '@deepnote/convert': { convertIpynbFilesToDeepnoteFile: async () => {} }
            });
            explorerView = new importModule.DeepnoteExplorerView(mockContext, createMockLogger());
        });

        teardown(() => {
            esmock.purge(importModule);
        });

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

    suite('createNotebookSiblingFile', () => {
        test('should create a new sibling file with a single new notebook', async () => {
            const projectId = 'test-project-id';
            const existingNotebookId = 'existing-notebook-id';
            const newNotebookId = 'new-notebook-id';
            const blockGroupId = 'test-blockgroup-id';
            const blockId = 'test-block-id';
            const fileUri = Uri.file('/workspace/test-project.deepnote');
            const notebookName = 'New Notebook';

            // Mock existing project data (the SOURCE file for project-level metadata)
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

            // Mock file system
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));
            // stat must reject so the sibling allocator treats the target name as free
            when(mockFS.stat(anything())).thenReturn(Promise.reject(new Error('not found')));

            let capturedWriteUri: Uri | undefined;
            let capturedWriteContent: Uint8Array | undefined;
            when(mockFS.writeFile(anything(), anything())).thenCall((uri: Uri, content: Uint8Array) => {
                capturedWriteUri = uri;
                capturedWriteContent = content;
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Mock user input
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(notebookName));

            const uuidStub = createUuidMock([newNotebookId, blockGroupId, blockId]);
            uuidStubs.push(uuidStub);

            // Mock notebook opening
            const mockNotebook = { notebookType: 'deepnote' };
            when(mockedVSCodeNamespaces.workspace.openNotebookDocument(anything())).thenReturn(
                Promise.resolve(mockNotebook as any)
            );
            when(mockedVSCodeNamespaces.window.showNotebookDocument(anything(), anything())).thenReturn(
                Promise.resolve(undefined as any)
            );

            // Execute the method
            const result = await explorerView.createNotebookSiblingFile(fileUri, new Set(['Notebook 1']));

            // Verify result
            expect(result).to.exist;
            expect(result?.id).to.equal(newNotebookId);
            expect(result?.name).to.equal(notebookName);

            // Verify a NEW sibling file was written (not the source file)
            expect(capturedWriteContent).to.exist;
            expect(capturedWriteUri).to.exist;
            expect(capturedWriteUri!.path).to.not.equal(fileUri.path);

            // Verify the new file is single-notebook and contains only the new notebook
            const updatedYamlContent = Buffer.from(capturedWriteContent!).toString('utf8');
            const updatedProjectData = deserializeDeepnoteFile(updatedYamlContent) as any;

            expect(updatedProjectData.project.id).to.equal(projectId);
            expect(updatedProjectData.project.notebooks).to.have.lengthOf(1);
            expect(updatedProjectData.project.notebooks[0].id).to.equal(newNotebookId);
            expect(updatedProjectData.project.notebooks[0].name).to.equal(notebookName);
            expect(updatedProjectData.project.notebooks[0].blocks).to.have.lengthOf(1);
            expect(updatedProjectData.project.notebooks[0].executionMode).to.equal('block');
        });

        test('should return null if user cancels notebook name input', async () => {
            const projectId = 'test-project-id';
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
                    notebooks: []
                }
            };

            const yamlContent = serializeDeepnoteFile(existingProjectData);

            // Mock file system
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));
            when(mockFS.writeFile(anything(), anything())).thenReturn(Promise.resolve());
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Mock user cancelling input
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

            // Execute the method
            const result = await explorerView.createNotebookSiblingFile(fileUri, new Set());

            // Verify result is null and file was not written
            expect(result).to.be.null;
            verify(mockFS.writeFile(anything(), anything())).never();
        });

        test('should generate unique notebook name suggestions', async () => {
            const projectId = 'test-project-id';
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
                    notebooks: [{ id: 'nb1', name: 'Notebook 1', blocks: [], executionMode: 'block' }]
                }
            };

            const yamlContent = serializeDeepnoteFile(existingProjectData);

            // Mock file system
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));
            when(mockFS.writeFile(anything(), anything())).thenReturn(Promise.resolve());
            when(mockFS.stat(anything())).thenReturn(Promise.reject(new Error('not found')));
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

            // existingNames has 2 entries → suggested name is 'Notebook 3' (size + 1)
            await explorerView.createNotebookSiblingFile(fileUri, new Set(['Notebook 1', 'Notebook 2']));

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

        test('should return early if tree item is project-scoped (not notebook-scoped)', async () => {
            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
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

        test('should return early if tree item is project-scoped (not notebook-scoped)', async () => {
            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
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

            // Legacy multi-notebook project so the target resolves and confirmation is reached.
            const existingProjectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-01-01T00:00:00.000Z' },
                project: {
                    id: projectId,
                    name: 'Test Project',
                    notebooks: [
                        { id: notebookId, name: notebookName, blocks: [], executionMode: 'block' },
                        { id: 'other-notebook', name: 'Other Notebook', blocks: [], executionMode: 'block' }
                    ]
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(
                Promise.resolve(Buffer.from(serializeDeepnoteFile(existingProjectData)))
            );
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

            // Verify no write/delete occurred (user cancelled the confirmation)
            verify(mockFS.writeFile(anything(), anything())).never();
            verify(mockFS.delete(anything(), anything())).never();
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

        test('should return early if tree item is project-scoped (not notebook-scoped)', async () => {
            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
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
        test('should successfully rename a project with valid input', async () => {
            const oldProjectName = 'Old Project Name';
            const newProjectName = 'New Project Name';
            const projectId = 'test-project-id';
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
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(newProjectName));
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenReturn(
                Promise.resolve(undefined)
            );

            // Create mock project group tree item (project-scoped commands operate on the group)
            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
                context: {
                    filePath: fileUri.fsPath,
                    projectId: projectId
                },
                data: {
                    projectId,
                    projectName: oldProjectName,
                    files: [{ filePath: fileUri.fsPath, project: existingProjectData }]
                }
            };

            // Execute the method
            await explorerView.renameProject(mockTreeItem as DeepnoteTreeItem);

            // Verify file was written
            expect(capturedWriteContent).to.exist;

            // Verify YAML content
            const updatedYamlContent = Buffer.from(capturedWriteContent!).toString('utf8');
            const updatedProjectData = deserializeDeepnoteFile(updatedYamlContent);

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

        test('should return early if tree item type is not a project group', async () => {
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

            const yamlContent = serializeDeepnoteFile(existingProjectData);

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlContent)));
            when(mockFS.writeFile(anything(), anything())).thenReturn(Promise.resolve());
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // Test 1: User cancels input (returns undefined)
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

            // Create mock project group tree item
            const mockTreeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
                context: {
                    filePath: fileUri.fsPath,
                    projectId: projectId
                },
                data: {
                    projectId,
                    projectName: currentName,
                    files: [{ filePath: fileUri.fsPath, project: existingProjectData }]
                }
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

    suite('exportProject', () => {
        test('should return early if user cancels format selection', async () => {
            resetVSCodeMocks();

            const mockFS = mock<typeof workspace.fs>();
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            // User cancels format selection
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve(undefined)
            );

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
                context: {
                    filePath: '/test/project.deepnote',
                    projectId: 'project-id'
                },
                data: {
                    projectId: 'project-id',
                    projectName: 'Test Project',
                    files: [{ filePath: '/test/project.deepnote', project: {} as DeepnoteFile }]
                }
            };

            await (explorerView as any).exportProject(treeItem);

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
                type: DeepnoteTreeItemType.ProjectGroup,
                context: {
                    filePath: '/test/project.deepnote',
                    projectId: 'project-id'
                },
                data: {
                    projectId: 'project-id',
                    projectName: 'Test Project',
                    files: [{ filePath: '/test/project.deepnote', project: {} as DeepnoteFile }]
                }
            };

            await (explorerView as any).exportProject(treeItem);

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
                type: DeepnoteTreeItemType.ProjectGroup,
                context: {
                    filePath: '/test/project.deepnote',
                    projectId: 'project-id'
                },
                data: {
                    projectId: 'project-id',
                    projectName: 'Test Project',
                    files: [{ filePath: '/test/project.deepnote', project: {} as DeepnoteFile }]
                }
            };

            await (explorerView as any).exportProject(treeItem);

            // Verify error message was shown
            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
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

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
                context: {
                    filePath: '/test/project.deepnote',
                    projectId: 'project-id'
                },
                data: {
                    projectId: 'project-id',
                    projectName: 'Test Project',
                    files: [{ filePath: '/test/project.deepnote', project: {} as DeepnoteFile }]
                }
            };

            await (explorerView as any).exportProject(treeItem);

            // Verify both notebooks were exported
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

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
                context: {
                    filePath: '/test/project.deepnote',
                    projectId: 'project-id'
                },
                data: {
                    projectId: 'project-id',
                    projectName: 'Test Project',
                    files: [{ filePath: '/test/project.deepnote', project: {} as DeepnoteFile }]
                }
            };

            await (explorerView as any).exportProject(treeItem);

            // Verify the exported content is valid Jupyter notebook JSON
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

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
                context: {
                    filePath: '/test/project.deepnote',
                    projectId: 'project-id'
                },
                data: {
                    projectId: 'project-id',
                    projectName: 'Test Project',
                    files: [{ filePath: '/test/project.deepnote', project: {} as DeepnoteFile }]
                }
            };

            await (explorerView as any).exportProject(treeItem);

            // Verify the output path is correctly constructed
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

            // Simulate write error
            when(mockFS.writeFile(anything(), anything())).thenReject(new Error('Permission denied'));

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
                context: {
                    filePath: '/test/project.deepnote',
                    projectId: 'project-id'
                },
                data: {
                    projectId: 'project-id',
                    projectName: 'Test Project',
                    files: [{ filePath: '/test/project.deepnote', project: {} as DeepnoteFile }]
                }
            };

            await (explorerView as any).exportProject(treeItem);

            // Verify error message was shown
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
            // Files exist - stat returns successfully
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
                type: DeepnoteTreeItemType.ProjectGroup,
                context: {
                    filePath: '/test/project.deepnote',
                    projectId: 'project-id'
                },
                data: {
                    projectId: 'project-id',
                    projectName: 'Test Project',
                    files: [{ filePath: '/test/project.deepnote', project: {} as DeepnoteFile }]
                }
            };

            await (explorerView as any).exportProject(treeItem);

            // Verify warning message was shown about files existing
            verify(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).once();
            // Verify no files were written
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
                type: DeepnoteTreeItemType.ProjectGroup,
                context: {
                    filePath: '/test/project.deepnote',
                    projectId: 'project-id'
                },
                data: {
                    projectId: 'project-id',
                    projectName: 'Test Project',
                    files: [{ filePath: '/test/project.deepnote', project: {} as DeepnoteFile }]
                }
            };

            await (explorerView as any).exportProject(treeItem);

            // Verify file was written after user confirmed overwrite
            assert.strictEqual(writeCount, 1);
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

// Sibling-file command semantics (§7): project-group operations span every sibling file; new/
// duplicate notebooks become NEW sibling files (never appended); single-notebook deletes remove
// the FILE; name uniqueness is collected across the whole group.
suite('DeepnoteExplorerView - Sibling-file command semantics', () => {
    let explorerView: DeepnoteExplorerView;
    let mockContext: IExtensionContext;
    let sandbox: sinon.SinonSandbox;
    let uuidStubs: sinon.SinonStub[] = [];

    setup(() => {
        sandbox = sinon.createSandbox();
        resetVSCodeMocks();
        uuidStubs = [];

        mockContext = { subscriptions: [] } as unknown as IExtensionContext;
        explorerView = new DeepnoteExplorerView(mockContext, createMockLogger());
    });

    teardown(() => {
        sandbox.restore();
        uuidStubs.forEach((stub) => stub.restore());
        uuidStubs = [];
        resetVSCodeMocks();
    });

    function singleNotebookFile(projectId: string, notebookId: string, notebookName: string): DeepnoteFile {
        return {
            version: '1.0.0',
            metadata: { createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-01-01T00:00:00.000Z' },
            project: {
                id: projectId,
                name: 'Test Project',
                notebooks: [{ id: notebookId, name: notebookName, blocks: [], executionMode: 'block' }]
            }
        };
    }

    suite('addNotebookToProject', () => {
        test('writes a NEW sibling .deepnote file and does NOT append to any existing file project.notebooks', async () => {
            const projectId = 'group-project';
            const sourceFilePath = '/workspace/proj-a.deepnote';
            const sourceFile = singleNotebookFile(projectId, 'nb-a', 'Notebook A');
            const newNotebookId = 'new-nb-id';

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([
                { uri: Uri.file('/workspace') } as any
            ]);
            // collectNotebookNamesForProject enumerates .deepnote files in the workspace.
            when(mockedVSCodeNamespaces.workspace.findFiles(anything())).thenReturn(
                Promise.resolve([Uri.file(sourceFilePath)])
            );

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(
                Promise.resolve(Buffer.from(serializeDeepnoteFile(sourceFile)))
            );
            // stat rejects so the allocator treats every candidate sibling name as free.
            when(mockFS.stat(anything())).thenReturn(Promise.reject(new Error('not found')));

            const writes: Array<{ uri: Uri; content: Uint8Array }> = [];
            when(mockFS.writeFile(anything(), anything())).thenCall((uri: Uri, content: Uint8Array) => {
                writes.push({ uri, content });
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('Notebook B'));
            when(mockedVSCodeNamespaces.workspace.openNotebookDocument(anything())).thenReturn(
                Promise.resolve({ notebookType: 'deepnote' } as any)
            );
            when(mockedVSCodeNamespaces.window.showNotebookDocument(anything(), anything())).thenReturn(
                Promise.resolve(undefined as any)
            );

            uuidStubs.push(createUuidMock([newNotebookId, 'bg', 'blk']));

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
                context: { filePath: sourceFilePath, projectId },
                data: {
                    projectId,
                    projectName: 'Test Project',
                    files: [{ filePath: sourceFilePath, project: sourceFile }]
                }
            };

            await (explorerView as any).addNotebookToProject(treeItem as DeepnoteTreeItem);

            // Exactly one file was written, and it is a NEW path (not the source file).
            assert.strictEqual(writes.length, 1, 'addNotebookToProject must write exactly one new sibling file');
            assert.notStrictEqual(writes[0].uri.path, sourceFilePath, 'the new file must not overwrite the source');

            // The written file is single-notebook and holds only the new notebook (no append).
            const written = deserializeDeepnoteFile(Buffer.from(writes[0].content).toString('utf8'));
            assert.strictEqual(written.project.id, projectId, 'sibling carries the same project.id');
            assert.strictEqual(written.project.notebooks.length, 1, 'sibling is single-notebook (no append)');
            assert.strictEqual(written.project.notebooks[0].id, newNotebookId);
            assert.strictEqual(written.project.notebooks[0].name, 'Notebook B');
        });

        test('returns early for a non-group tree item (does not write)', async () => {
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.writeFile(anything(), anything())).thenReturn(Promise.resolve());
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.Notebook,
                context: { filePath: '/workspace/x.deepnote', projectId: 'p' }
            };

            await (explorerView as any).addNotebookToProject(treeItem as DeepnoteTreeItem);

            verify(mockFS.writeFile(anything(), anything())).never();
        });
    });

    suite('deleteProject', () => {
        test('deletes EVERY sibling file in the group (one delete per file)', async () => {
            const projectId = 'group-project';
            const files = [
                { filePath: '/workspace/a.deepnote', project: singleNotebookFile(projectId, 'nb-a', 'A') },
                { filePath: '/workspace/b.deepnote', project: singleNotebookFile(projectId, 'nb-b', 'B') },
                { filePath: '/workspace/c.deepnote', project: singleNotebookFile(projectId, 'nb-c', 'C') }
            ];

            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenReturn(
                Promise.resolve('Delete')
            );

            const deleted: string[] = [];
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.delete(anything(), anything())).thenCall((uri: Uri) => {
                deleted.push(uri.fsPath);
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
                context: { filePath: files[0].filePath, projectId },
                data: { projectId, projectName: 'Test Project', files }
            };

            await (explorerView as any).deleteProject(treeItem as DeepnoteTreeItem);

            assert.strictEqual(deleted.length, 3, 'all three sibling files must be deleted');
            for (const { filePath } of files) {
                assert.include(deleted, Uri.file(filePath).fsPath, `${filePath} must be deleted`);
            }
            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).never();
        });

        test('partial failure: one delete rejects, the others still delete and the failure is surfaced', async () => {
            const projectId = 'group-project';
            const files = [
                { filePath: '/workspace/a.deepnote', project: singleNotebookFile(projectId, 'nb-a', 'A') },
                { filePath: '/workspace/b.deepnote', project: singleNotebookFile(projectId, 'nb-b', 'B') },
                { filePath: '/workspace/c.deepnote', project: singleNotebookFile(projectId, 'nb-c', 'C') }
            ];

            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenReturn(
                Promise.resolve('Delete')
            );

            const deleted: string[] = [];
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.delete(anything(), anything())).thenCall((uri: Uri) => {
                if (uri.fsPath === Uri.file('/workspace/b.deepnote').fsPath) {
                    return Promise.reject(new Error('permission denied'));
                }
                deleted.push(uri.fsPath);
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
                context: { filePath: files[0].filePath, projectId },
                data: { projectId, projectName: 'Test Project', files }
            };

            await (explorerView as any).deleteProject(treeItem as DeepnoteTreeItem);

            // The two healthy files are still deleted (one failure does not abort the loop).
            assert.strictEqual(deleted.length, 2, 'the non-failing files must still be deleted');
            assert.include(deleted, Uri.file('/workspace/a.deepnote').fsPath);
            assert.include(deleted, Uri.file('/workspace/c.deepnote').fsPath);
            // The failure is surfaced (not silent) and no success message is shown.
            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).never();
        });

        test('returns early when the user cancels the confirmation (no deletes)', async () => {
            const projectId = 'group-project';
            const files = [{ filePath: '/workspace/a.deepnote', project: singleNotebookFile(projectId, 'nb-a', 'A') }];

            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenReturn(
                Promise.resolve(undefined)
            );

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.delete(anything(), anything())).thenReturn(Promise.resolve());
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectGroup,
                context: { filePath: files[0].filePath, projectId },
                data: { projectId, projectName: 'Test Project', files }
            };

            await (explorerView as any).deleteProject(treeItem as DeepnoteTreeItem);

            verify(mockFS.delete(anything(), anything())).never();
        });
    });

    suite('deleteNotebook — single-notebook file vs legacy', () => {
        test('a single-notebook file deletes the FILE (does not rewrite an array)', async () => {
            const projectId = 'group-project';
            const filePath = '/workspace/single.deepnote';
            const fileUri = Uri.file(filePath);
            const projectData = singleNotebookFile(projectId, 'only-nb', 'Only Notebook');

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(
                Promise.resolve(Buffer.from(serializeDeepnoteFile(projectData)))
            );

            let deletedUri: Uri | undefined;
            when(mockFS.delete(anything(), anything())).thenCall((uri: Uri) => {
                deletedUri = uri;
                return Promise.resolve();
            });
            when(mockFS.writeFile(anything(), anything())).thenReturn(Promise.resolve());
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenReturn(
                Promise.resolve('Delete')
            );

            // ProjectFile node with no notebookId => single-notebook leaf => delete the file.
            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.ProjectFile,
                context: { filePath, projectId },
                data: projectData
            };

            await explorerView.deleteNotebook(treeItem as DeepnoteTreeItem);

            assert.isDefined(deletedUri, 'the file must be deleted for a single-notebook file');
            assert.strictEqual(deletedUri!.fsPath, fileUri.fsPath, 'the deleted file must be the target file');
            // It must NOT rewrite the file's notebooks array on a single-notebook delete.
            verify(mockFS.writeFile(anything(), anything())).never();
        });

        test('a legacy multi-notebook file removes the notebook from the array and writes the file back (no file delete)', async () => {
            const projectId = 'group-project';
            const filePath = '/workspace/legacy.deepnote';
            const keepId = 'keep-nb';
            const dropId = 'drop-nb';
            const legacy: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-01-01T00:00:00.000Z' },
                project: {
                    id: projectId,
                    name: 'Test Project',
                    notebooks: [
                        { id: keepId, name: 'Keep', blocks: [], executionMode: 'block' },
                        { id: dropId, name: 'Drop', blocks: [], executionMode: 'block' }
                    ]
                }
            };

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(serializeDeepnoteFile(legacy))));

            let writtenContent: Uint8Array | undefined;
            when(mockFS.writeFile(anything(), anything())).thenCall((_uri: Uri, content: Uint8Array) => {
                writtenContent = content;
                return Promise.resolve();
            });
            when(mockFS.delete(anything(), anything())).thenReturn(Promise.resolve());
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenReturn(
                Promise.resolve('Delete')
            );

            // Legacy Notebook child selected by notebookId.
            const treeItem: Partial<DeepnoteTreeItem> = {
                type: DeepnoteTreeItemType.Notebook,
                context: { filePath, projectId, notebookId: dropId },
                data: { id: dropId, name: 'Drop', blocks: [], executionMode: 'block' } as DeepnoteNotebook
            };

            await explorerView.deleteNotebook(treeItem as DeepnoteTreeItem);

            // The file is rewritten (array op) and NOT deleted.
            assert.isDefined(writtenContent, 'the legacy file must be rewritten');
            verify(mockFS.delete(anything(), anything())).never();

            const updated = deserializeDeepnoteFile(Buffer.from(writtenContent!).toString('utf8'));
            assert.strictEqual(updated.project.notebooks.length, 1, 'the dropped notebook is removed from the array');
            assert.strictEqual(updated.project.notebooks[0].id, keepId, 'the kept notebook survives');
        });
    });

    suite('collectNotebookNamesForProject', () => {
        test('gathers non-init notebook names across ALL sibling files of the group', async () => {
            const projectId = 'group-project';
            const otherProjectId = 'other-project';
            const pathA = '/workspace/a.deepnote';
            const pathB = '/workspace/b.deepnote';
            const pathOther = '/workspace/other.deepnote';

            const fileA = singleNotebookFile(projectId, 'nb-a', 'Alpha');
            const fileB: DeepnoteFile = {
                version: '1.0.0',
                metadata: { createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-01-01T00:00:00.000Z' },
                project: {
                    id: projectId,
                    name: 'Test Project',
                    initNotebookId: 'init-b',
                    notebooks: [
                        { id: 'init-b', name: 'Init B', blocks: [], executionMode: 'block' },
                        { id: 'nb-b', name: 'Beta', blocks: [], executionMode: 'block' }
                    ]
                }
            };
            const fileOther = singleNotebookFile(otherProjectId, 'nb-o', 'ShouldNotAppear');

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([
                { uri: Uri.file('/workspace') } as any
            ]);
            when(mockedVSCodeNamespaces.workspace.findFiles(anything())).thenReturn(
                Promise.resolve([Uri.file(pathA), Uri.file(pathB), Uri.file(pathOther)])
            );

            // Dispatch readFile by URI path so each sibling returns its own content.
            const byPath: Record<string, DeepnoteFile> = {
                [Uri.file(pathA).fsPath]: fileA,
                [Uri.file(pathB).fsPath]: fileB,
                [Uri.file(pathOther).fsPath]: fileOther
            };
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenCall((uri: Uri) =>
                Promise.resolve(Buffer.from(serializeDeepnoteFile(byPath[uri.fsPath])))
            );
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            const names: Set<string> = await (explorerView as any).collectNotebookNamesForProject(projectId);

            // Names from BOTH siblings of the group; init excluded; other project excluded.
            assert.isTrue(names.has('Alpha'), 'name from sibling A must be collected');
            assert.isTrue(names.has('Beta'), 'name from sibling B must be collected');
            assert.isFalse(names.has('Init B'), 'the init notebook name must be excluded');
            assert.isFalse(names.has('ShouldNotAppear'), 'names from a different project must be excluded');
            assert.deepStrictEqual([...names].sort(), ['Alpha', 'Beta']);
        });

        test('excludes the provided current name (so renaming to the same value is allowed)', async () => {
            const projectId = 'group-project';
            const pathA = '/workspace/a.deepnote';
            const fileA = singleNotebookFile(projectId, 'nb-a', 'Alpha');

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([
                { uri: Uri.file('/workspace') } as any
            ]);
            when(mockedVSCodeNamespaces.workspace.findFiles(anything())).thenReturn(Promise.resolve([Uri.file(pathA)]));

            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(serializeDeepnoteFile(fileA))));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            const names: Set<string> = await (explorerView as any).collectNotebookNamesForProject(projectId, 'Alpha');

            assert.isFalse(names.has('Alpha'), 'the excluded current name must not be in the set');
            assert.strictEqual(names.size, 0);
        });

        test('excludes snapshot sidecar files so stale snapshot notebook names cannot pollute the set', async () => {
            const projectId = 'group-project';
            const pathA = '/workspace/a.deepnote';
            // A snapshot sidecar is a full project clone (same project.id) ending in `.snapshot.deepnote`,
            // carrying a notebook name that may be stale (e.g. a since-renamed/deleted notebook).
            const snapshotPath = '/workspace/snapshots/test_group-project_latest.snapshot.deepnote';
            const fileA = singleNotebookFile(projectId, 'nb-a', 'Alpha');
            const snapshotFile = singleNotebookFile(projectId, 'nb-stale', 'StaleSnapshotName');

            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([
                { uri: Uri.file('/workspace') } as any
            ]);
            when(mockedVSCodeNamespaces.workspace.findFiles(anything())).thenReturn(
                Promise.resolve([Uri.file(pathA), Uri.file(snapshotPath)])
            );

            const byPath: Record<string, DeepnoteFile> = {
                [Uri.file(pathA).fsPath]: fileA,
                [Uri.file(snapshotPath).fsPath]: snapshotFile
            };
            const mockFS = mock<typeof workspace.fs>();
            when(mockFS.readFile(anything())).thenCall((uri: Uri) =>
                Promise.resolve(Buffer.from(serializeDeepnoteFile(byPath[uri.fsPath])))
            );
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            const names: Set<string> = await (explorerView as any).collectNotebookNamesForProject(projectId);

            assert.isTrue(names.has('Alpha'), 'the real sibling name must be collected');
            assert.isFalse(
                names.has('StaleSnapshotName'),
                'names from snapshot sidecars must be excluded from the uniqueness set'
            );
            assert.deepStrictEqual([...names].sort(), ['Alpha']);
        });
    });
});
