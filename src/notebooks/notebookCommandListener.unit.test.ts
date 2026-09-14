// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, instance, mock, verify, when } from 'ts-mockito';
import { NotebookDocument, NotebookEditor, Uri } from 'vscode';
import { IDataScienceErrorHandler } from '../kernels/errors/types';
import { IKernelStatusProvider } from '../kernels/kernelStatusProvider';
import { IKernel, IKernelProvider } from '../kernels/types';
import { Commands } from '../platform/common/constants';
import { IConfigurationService, IDisposable } from '../platform/common/types';
import { createDeferred, Deferred } from '../platform/common/utils/async';
import { dispose } from '../platform/common/utils/lifecycle';
import { IServiceContainer } from '../platform/ioc/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../test/vscode-mock';
import { KernelConnector } from './controllers/kernelConnector';
import { NotebookCellLanguageService } from './languages/cellLanguageService';
import { NotebookCommandListener } from './notebookCommandListener';
import { NotebookEditorProvider } from './notebookEditorProvider';
import { IDeepnoteInitNotebookRunner } from './types';

type CommandHandler = (...args: unknown[]) => unknown;

/**
 * The restart commands are invoked two ways: the notebook toolbar passes `{ notebookEditor: { notebookUri } }`,
 * the Command Palette passes nothing. These tests drive the registered handlers with no arguments, so the
 * command has to find the active Deepnote notebook itself, which is what #471's palette reports came down to.
 */
suite('Notebook Command Listener - restart commands from the Command Palette', () => {
    let disposables: IDisposable[] = [];
    let handlers: Map<string, CommandHandler>;
    let kernelProvider: IKernelProvider;
    let kernel: IKernel;
    let notebook: NotebookDocument;
    let wrapKernelMethod: sinon.SinonStub;
    let executedCommands: string[];
    let initNotebookRunner: IDeepnoteInitNotebookRunner;
    let configurationService: IConfigurationService;
    let initDone: Deferred<void>;

    setup(() => {
        resetVSCodeMocks();
        handlers = new Map();
        executedCommands = [];
        when(mockedVSCodeNamespaces.commands.registerCommand(anything(), anything())).thenCall(
            (command: string, handler: CommandHandler) => {
                handlers.set(command, handler);

                return { dispose: () => undefined };
            }
        );
        when(mockedVSCodeNamespaces.commands.executeCommand(anything())).thenCall((command: string) => {
            executedCommands.push(command);

            return Promise.resolve();
        });
        when(mockedVSCodeNamespaces.commands.executeCommand(anything(), anything())).thenCall((command: string) => {
            executedCommands.push(command);

            return Promise.resolve();
        });

        const document = mock<NotebookDocument>();
        when(document.uri).thenReturn(Uri.file('/workspace/analysis.deepnote'));
        when(document.notebookType).thenReturn('deepnote');
        notebook = instance(document);
        const editor = mock<NotebookEditor>();
        when(editor.notebook).thenReturn(notebook);
        when(editor.selection).thenReturn({ start: 1, end: 3, isEmpty: false, with: () => undefined } as any);
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(instance(editor));
        when(mockedVSCodeNamespaces.window.activeTextEditor).thenReturn(undefined);

        const kernelMock = mock<IKernel>();
        when(kernelMock.notebook).thenReturn(notebook);
        when(kernelMock.resourceUri).thenReturn(notebook.uri);
        kernel = instance(kernelMock);
        kernelProvider = mock<IKernelProvider>();
        when(kernelProvider.get(notebook)).thenReturn(kernel);
        when(kernelProvider.getKernelExecution(anything())).thenReturn({ pendingCells: [] } as any);

        configurationService = mock<IConfigurationService>();
        when(configurationService.getSettings(anything())).thenReturn({ askForKernelRestart: false } as any);

        // Resolve with nothing: a ts-mockito instance answers `.then`, so returning `kernel` would never settle.
        wrapKernelMethod = sinon.stub(KernelConnector, 'wrapKernelMethod').callsFake(async () => {
            executedCommands.push('restart');

            return undefined as unknown as IKernel;
        });

        initDone = createDeferred<void>();
        initDone.resolve();
        initNotebookRunner = mock<IDeepnoteInitNotebookRunner>();
        when(initNotebookRunner.waitForInit(anything())).thenCall(() => initDone.promise);

        const listener = new NotebookCommandListener(
            disposables,
            instance(mock<NotebookCellLanguageService>()),
            instance(configurationService),
            instance(kernelProvider),
            instance(mock<IDataScienceErrorHandler>()),
            new NotebookEditorProvider(),
            instance(mock<IServiceContainer>()),
            instance(mock<IKernelStatusProvider>()),
            instance(initNotebookRunner)
        );
        listener.activate();
    });

    teardown(() => {
        sinon.restore();
        disposables = dispose(disposables);
    });

    async function waitFor(condition: () => boolean): Promise<void> {
        for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.isTrue(condition(), `Timed out; commands so far: ${JSON.stringify(executedCommands)}`);
    }

    test('Restart Kernel with no arguments restarts the active Deepnote notebook kernel', async () => {
        await handlers.get(Commands.RestartKernel)!();

        verify(kernelProvider.get(notebook)).once();
        assert.strictEqual(wrapKernelMethod.callCount, 1);
        assert.strictEqual(wrapKernelMethod.firstCall.args[1], 'restart');
    });

    test('Restart Kernel and Run All Cells with no arguments restarts before running', async () => {
        await handlers.get(Commands.RestartKernelAndRunAllCells)!();

        await waitFor(() => executedCommands.includes('notebook.execute'));
        assert.deepStrictEqual(executedCommands, ['restart', 'notebook.execute']);
    });

    test('Restart Kernel and Run All Cells waits for the init notebook before running', async () => {
        initDone = createDeferred<void>();

        const command = handlers.get(Commands.RestartKernelAndRunAllCells)!();
        await waitFor(() => executedCommands.includes('restart'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepStrictEqual(executedCommands, ['restart'], 'cells must not run while init is in flight');
        verify(initNotebookRunner.waitForInit(kernel)).once();

        initDone.resolve();
        await command;
        await waitFor(() => executedCommands.includes('notebook.execute'));
        assert.deepStrictEqual(executedCommands, ['restart', 'notebook.execute']);
    });

    test('Restart Kernel and Run All Cells does not run cells when the user declines the restart', async () => {
        when(configurationService.getSettings(anything())).thenReturn({ askForKernelRestart: true } as any);
        when(
            mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything(), anything(), anything())
        ).thenResolve(undefined);

        await handlers.get(Commands.RestartKernelAndRunAllCells)!();
        await new Promise((resolve) => setTimeout(resolve, 20));

        assert.deepStrictEqual(executedCommands, [], 'neither a restart nor a run may happen');
    });

    test('Restart Kernel and Run All Cells does not run cells when the restart fails', async () => {
        wrapKernelMethod.callsFake(async () => {
            throw new Error('kernel died');
        });
        when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenResolve(undefined);

        await handlers.get(Commands.RestartKernelAndRunAllCells)!();
        await new Promise((resolve) => setTimeout(resolve, 20));

        assert.deepStrictEqual(executedCommands, [], 'cells must not run after a failed restart');
        verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
    });

    test('Restart Kernel and Run Up To Selected Cell with no arguments restarts, then runs to the selection', async () => {
        await handlers.get(Commands.RestartKernelAndRunUpToSelectedCell)!();

        await waitFor(() => executedCommands.includes('notebook.cell.execute'));
        assert.deepStrictEqual(executedCommands, ['restart', 'notebook.cell.execute']);
        verify(mockedVSCodeNamespaces.commands.executeCommand('notebook.cell.execute', anything())).once();
    });
});
