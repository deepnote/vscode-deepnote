import { assert } from 'chai';
import * as sinon from 'sinon';
import { instance, mock, when, anything } from 'ts-mockito';
import { Uri, TextDocument, TextEditor, NotebookDocument, NotebookEditor } from 'vscode';
import * as fs from 'fs';

import { OpenInDeepnoteHandler } from './openInDeepnoteHandler.node';
import { IExtensionContext } from '../../platform/common/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import * as importClient from './importClient.node';

suite('OpenInDeepnoteHandler', () => {
    let handler: OpenInDeepnoteHandler;
    let mockExtensionContext: IExtensionContext;
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        resetVSCodeMocks();
        sandbox = sinon.createSandbox();

        mockExtensionContext = {
            subscriptions: []
        } as any;

        handler = new OpenInDeepnoteHandler(mockExtensionContext);
    });

    teardown(() => {
        sandbox.restore();
    });

    suite('activate', () => {
        test('should register command when activated', () => {
            let registeredCommandId: string | undefined;
            let registeredCallback: Function | undefined;

            when(mockedVSCodeNamespaces.commands.registerCommand(anything(), anything())).thenCall((id, callback) => {
                registeredCommandId = id;
                registeredCallback = callback;
                return {
                    dispose: () => {
                        /* no-op */
                    }
                };
            });

            handler.activate();

            assert.strictEqual(
                registeredCommandId,
                'deepnote.openInDeepnote',
                'Command should be registered with correct ID'
            );
            assert.isFunction(registeredCallback, 'Second argument should be a function');
        });
    });

    suite('handleOpenInDeepnote', () => {
        const testFilePath = '/test/notebook.deepnote';
        const testFileUri = Uri.file(testFilePath);
        const testFileBuffer = Buffer.from('test content');

        function createMockTextEditor(uri: Uri, isDirty = false): TextEditor {
            const mockDocument = mock<TextDocument>();
            when(mockDocument.uri).thenReturn(uri);
            when(mockDocument.isDirty).thenReturn(isDirty);
            when(mockDocument.save()).thenReturn(Promise.resolve(true));

            const mockEditor = mock<TextEditor>();
            when(mockEditor.document).thenReturn(instance(mockDocument));

            return instance(mockEditor);
        }

        function createMockNotebookEditor(uri: Uri, notebookType: string): NotebookEditor {
            const mockNotebook = mock<NotebookDocument>();
            when(mockNotebook.uri).thenReturn(uri);
            when(mockNotebook.notebookType).thenReturn(notebookType);

            const mockEditor = mock<NotebookEditor>();
            when(mockEditor.notebook).thenReturn(instance(mockNotebook));

            return instance(mockEditor);
        }

        test('should handle no active editor or notebook', async () => {
            let errorMessage: string | undefined;

            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);
            when(mockedVSCodeNamespaces.window.activeTextEditor).thenReturn(undefined);
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall((message) => {
                errorMessage = message;
                return Promise.resolve(undefined);
            });

            await (handler as any).handleOpenInDeepnote();

            assert.isDefined(errorMessage, 'Should show error message');
            assert.isTrue(
                errorMessage!.includes('Please open a .deepnote file first'),
                'Error message should mention opening a .deepnote file'
            );
        });

        test('should handle Deepnote notebook editor', async () => {
            const notebookUri = testFileUri.with({ query: 'notebook=123' });
            const mockNotebookEditor = createMockNotebookEditor(notebookUri, 'deepnote');
            let withProgressCalled = false;

            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(mockNotebookEditor);
            when(mockedVSCodeNamespaces.commands.executeCommand(anything())).thenReturn(Promise.resolve(undefined));

            const statStub = sandbox.stub(fs.promises, 'stat').resolves({ size: 1000 } as fs.Stats);
            const readFileStub = sandbox.stub(fs.promises, 'readFile').resolves(testFileBuffer);
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall((_options, callback) => {
                withProgressCalled = true;
                return callback(
                    {
                        report: () => {
                            /* no-op */
                        }
                    } as any,
                    {} as any
                );
            });
            const initImportStub = sandbox.stub(importClient, 'initImport').resolves({
                importId: 'test-import-id',
                uploadUrl: 'https://test.com/upload',
                expiresAt: '2025-12-31T23:59:59Z'
            });
            const uploadFileStub = sandbox.stub(importClient, 'uploadFile').resolves();
            sandbox.stub(importClient, 'getDeepnoteDomain').returns('app.deepnote.com');
            when(mockedVSCodeNamespaces.env.openExternal(anything())).thenReturn(Promise.resolve(true));

            await (handler as any).handleOpenInDeepnote();

            assert.isTrue(statStub.calledOnce, 'Should stat the file');
            assert.isTrue(readFileStub.calledOnce, 'Should read the file');
            assert.isTrue(withProgressCalled, 'Should show progress');
            assert.isTrue(initImportStub.calledOnce, 'Should initialize import');
            assert.isTrue(uploadFileStub.calledOnce, 'Should upload file');
        });

        test('should fall back to text editor when notebook is not Deepnote type', async () => {
            const notebookUri = Uri.file('/test/other.ipynb');
            const mockNotebookEditor = createMockNotebookEditor(notebookUri, 'jupyter-notebook');
            const mockTextEditor = createMockTextEditor(testFileUri);

            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(mockNotebookEditor);
            when(mockedVSCodeNamespaces.window.activeTextEditor).thenReturn(mockTextEditor);

            const statStub = sandbox.stub(fs.promises, 'stat').resolves({ size: 1000 } as fs.Stats);
            const readFileStub = sandbox.stub(fs.promises, 'readFile').resolves(testFileBuffer);
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall((_options, callback) => {
                return callback(
                    {
                        report: () => {
                            /* no-op */
                        }
                    } as any,
                    {} as any
                );
            });
            sandbox.stub(importClient, 'initImport').resolves({
                importId: 'test-import-id',
                uploadUrl: 'https://test.com/upload',
                expiresAt: '2025-12-31T23:59:59Z'
            });
            sandbox.stub(importClient, 'uploadFile').resolves();
            sandbox.stub(importClient, 'getDeepnoteDomain').returns('app.deepnote.com');
            when(mockedVSCodeNamespaces.env.openExternal(anything())).thenReturn(Promise.resolve(true));

            await (handler as any).handleOpenInDeepnote();

            assert.isTrue(statStub.calledOnce, 'Should stat the file');
            assert.isTrue(readFileStub.calledOnce, 'Should read the file');
        });

        test('should handle text editor with .deepnote file', async () => {
            const mockTextEditor = createMockTextEditor(testFileUri);

            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);
            when(mockedVSCodeNamespaces.window.activeTextEditor).thenReturn(mockTextEditor);

            const statStub = sandbox.stub(fs.promises, 'stat').resolves({ size: 1000 } as fs.Stats);
            const readFileStub = sandbox.stub(fs.promises, 'readFile').resolves(testFileBuffer);
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall((_options, callback) => {
                return callback(
                    {
                        report: () => {
                            /* no-op */
                        }
                    } as any,
                    {} as any
                );
            });
            sandbox.stub(importClient, 'initImport').resolves({
                importId: 'test-import-id',
                uploadUrl: 'https://test.com/upload',
                expiresAt: '2025-12-31T23:59:59Z'
            });
            sandbox.stub(importClient, 'uploadFile').resolves();
            sandbox.stub(importClient, 'getDeepnoteDomain').returns('app.deepnote.com');
            when(mockedVSCodeNamespaces.env.openExternal(anything())).thenReturn(Promise.resolve(true));

            await (handler as any).handleOpenInDeepnote();

            assert.isTrue(statStub.calledOnce, 'Should stat the file');
            assert.isTrue(readFileStub.calledOnce, 'Should read the file');
        });

        test('should reject non-.deepnote files', async () => {
            const otherFileUri = Uri.file('/test/notebook.ipynb');
            const mockTextEditor = createMockTextEditor(otherFileUri);
            let errorMessage: string | undefined;

            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);
            when(mockedVSCodeNamespaces.window.activeTextEditor).thenReturn(mockTextEditor);
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall((message) => {
                errorMessage = message;
                return Promise.resolve(undefined);
            });

            await (handler as any).handleOpenInDeepnote();

            assert.isDefined(errorMessage, 'Should show error message');
            assert.isTrue(
                errorMessage!.includes('only works with .deepnote files'),
                'Error message should mention .deepnote files'
            );
        });

        test('should save dirty text editor before opening', async () => {
            const mockTextEditor = createMockTextEditor(testFileUri, true);
            const mockDocument = mockTextEditor.document;

            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);
            when(mockedVSCodeNamespaces.window.activeTextEditor).thenReturn(mockTextEditor);

            const saveStub = sandbox.stub(mockDocument, 'save').resolves(true);
            sandbox.stub(fs.promises, 'stat').resolves({ size: 1000 } as fs.Stats);
            sandbox.stub(fs.promises, 'readFile').resolves(testFileBuffer);
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall((_options, callback) => {
                return callback(
                    {
                        report: () => {
                            /* no-op */
                        }
                    } as any,
                    {} as any
                );
            });
            sandbox.stub(importClient, 'initImport').resolves({
                importId: 'test-import-id',
                uploadUrl: 'https://test.com/upload',
                expiresAt: '2025-12-31T23:59:59Z'
            });
            sandbox.stub(importClient, 'uploadFile').resolves();
            sandbox.stub(importClient, 'getDeepnoteDomain').returns('app.deepnote.com');
            when(mockedVSCodeNamespaces.env.openExternal(anything())).thenReturn(Promise.resolve(true));

            await (handler as any).handleOpenInDeepnote();

            assert.isTrue(saveStub.calledOnce, 'Should save dirty document');
        });

        test('should handle file save failure', async () => {
            const mockTextEditor = createMockTextEditor(testFileUri, true);
            const mockDocument = mockTextEditor.document;
            let errorMessage: string | undefined;

            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);
            when(mockedVSCodeNamespaces.window.activeTextEditor).thenReturn(mockTextEditor);

            const saveStub = sandbox.stub(mockDocument, 'save').resolves(false);
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall((message) => {
                errorMessage = message;
                return Promise.resolve(undefined);
            });

            await (handler as any).handleOpenInDeepnote();

            assert.isTrue(saveStub.calledOnce, 'Should attempt to save');
            assert.isDefined(errorMessage, 'Should show error message');
            assert.isTrue(errorMessage!.includes('save the file'), 'Error message should mention saving');
        });

        test('should reject files exceeding size limit', async () => {
            const mockTextEditor = createMockTextEditor(testFileUri);
            let errorMessage: string | undefined;

            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);
            when(mockedVSCodeNamespaces.window.activeTextEditor).thenReturn(mockTextEditor);

            const largeSize = importClient.MAX_FILE_SIZE + 1;
            const statStub = sandbox.stub(fs.promises, 'stat').resolves({ size: largeSize } as fs.Stats);
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall((message) => {
                errorMessage = message;
                return Promise.resolve(undefined);
            });

            await (handler as any).handleOpenInDeepnote();

            assert.isTrue(statStub.calledOnce, 'Should stat the file');
            assert.isDefined(errorMessage, 'Should show error message');
            assert.isTrue(errorMessage!.includes('exceeds'), 'Error message should mention file size limit');
        });

        test('should handle import initialization error', async () => {
            const mockTextEditor = createMockTextEditor(testFileUri);
            let errorMessage: string | undefined;

            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);
            when(mockedVSCodeNamespaces.window.activeTextEditor).thenReturn(mockTextEditor);

            sandbox.stub(fs.promises, 'stat').resolves({ size: 1000 } as fs.Stats);
            sandbox.stub(fs.promises, 'readFile').resolves(testFileBuffer);
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall((_options, callback) => {
                return callback(
                    {
                        report: () => {
                            /* no-op */
                        }
                    } as any,
                    {} as any
                );
            });
            const initImportStub = sandbox.stub(importClient, 'initImport').rejects(new Error('Network error'));
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall((message) => {
                errorMessage = message;
                return Promise.resolve(undefined);
            });

            await (handler as any).handleOpenInDeepnote();

            assert.isTrue(initImportStub.calledOnce, 'Should attempt to initialize import');
            assert.isDefined(errorMessage, 'Should show error message');
        });

        test('should handle upload error', async () => {
            const mockTextEditor = createMockTextEditor(testFileUri);
            let errorMessage: string | undefined;

            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);
            when(mockedVSCodeNamespaces.window.activeTextEditor).thenReturn(mockTextEditor);

            sandbox.stub(fs.promises, 'stat').resolves({ size: 1000 } as fs.Stats);
            sandbox.stub(fs.promises, 'readFile').resolves(testFileBuffer);
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall((_options, callback) => {
                return callback(
                    {
                        report: () => {
                            /* no-op */
                        }
                    } as any,
                    {} as any
                );
            });
            sandbox.stub(importClient, 'initImport').resolves({
                importId: 'test-import-id',
                uploadUrl: 'https://test.com/upload',
                expiresAt: '2025-12-31T23:59:59Z'
            });
            const uploadFileStub = sandbox.stub(importClient, 'uploadFile').rejects(new Error('Upload failed'));
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall((message) => {
                errorMessage = message;
                return Promise.resolve(undefined);
            });

            await (handler as any).handleOpenInDeepnote();

            assert.isTrue(uploadFileStub.calledOnce, 'Should attempt to upload');
            assert.isDefined(errorMessage, 'Should show error message');
        });

        test('should remove query params from notebook URI', async () => {
            const notebookUri = testFileUri.with({ query: 'notebook=123', fragment: 'cell0' });
            const mockNotebookEditor = createMockNotebookEditor(notebookUri, 'deepnote');

            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(mockNotebookEditor);
            when(mockedVSCodeNamespaces.commands.executeCommand(anything())).thenReturn(Promise.resolve(undefined));

            const statStub = sandbox.stub(fs.promises, 'stat').resolves({ size: 1000 } as fs.Stats);
            sandbox.stub(fs.promises, 'readFile').resolves(testFileBuffer);
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall((_options, callback) => {
                return callback(
                    {
                        report: () => {
                            /* no-op */
                        }
                    } as any,
                    {} as any
                );
            });
            sandbox.stub(importClient, 'initImport').resolves({
                importId: 'test-import-id',
                uploadUrl: 'https://test.com/upload',
                expiresAt: '2025-12-31T23:59:59Z'
            });
            sandbox.stub(importClient, 'uploadFile').resolves();
            sandbox.stub(importClient, 'getDeepnoteDomain').returns('app.deepnote.com');
            when(mockedVSCodeNamespaces.env.openExternal(anything())).thenReturn(Promise.resolve(true));

            await (handler as any).handleOpenInDeepnote();

            assert.isTrue(statStub.calledOnce, 'Should stat the file');
            const statPath = statStub.firstCall.args[0];
            assert.strictEqual(statPath, testFilePath, 'Should use base file path without query params');
        });
    });
});
