// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable, optional } from 'inversify';

import {
    ConfigurationTarget,
    Disposable,
    NotebookCellData,
    NotebookCellKind,
    NotebookEdit,
    NotebookRange,
    Uri,
    commands,
    window,
    workspace
} from 'vscode';
import { IConfigurationService, IDisposableRegistry } from '../platform/common/types';
import { Commands } from '../platform/common/constants';
import { noop } from '../platform/common/utils/misc';
import { NotebookCellLanguageService } from './languages/cellLanguageService';
import { DisplayOptions } from '../kernels/displayOptions';
import { IKernel, IKernelProvider } from '../kernels/types';
import { getDisplayPath } from '../platform/common/platform/fs-paths';
import { DataScience } from '../platform/common/utils/localize';
import { logger } from '../platform/logging';
import { IDeepnoteInitNotebookRunner, INotebookEditorProvider } from './types';
import { IServiceContainer } from '../platform/ioc/types';
import { endCellAndDisplayErrorsInCell } from '../kernels/execution/helpers';
import { chainWithPendingUpdates } from '../kernels/execution/notebookUpdater';
import { IDataScienceErrorHandler } from '../kernels/errors/types';
import { getNotebookMetadata } from '../platform/common/utils';
import { KernelConnector } from './controllers/kernelConnector';
import { IExtensionSyncActivationService } from '../platform/activation/types';
import { IKernelStatusProvider } from '../kernels/kernelStatusProvider';

export const INotebookCommandHandler = Symbol('INotebookCommandHandler');
export interface INotebookCommandHandler {
    /**
     * Restarts the kernel of `notebookUri` (or of the active notebook). Resolves `true` once the restart has
     * completed, `false` when there is no kernel or the restart failed (the failure is already shown to the user).
     */
    restartKernel(notebookUri: Uri | undefined, disableUI: boolean): Promise<boolean>;
}
/**
 * Registers commands specific to the notebook UI
 */
@injectable()
export class NotebookCommandListener implements INotebookCommandHandler, IExtensionSyncActivationService {
    private kernelInterruptedDontAskToRestart: boolean = false;
    constructor(
        @inject(IDisposableRegistry) private disposableRegistry: IDisposableRegistry,
        @inject(NotebookCellLanguageService) private readonly languageService: NotebookCellLanguageService,
        @inject(IConfigurationService) private configurationService: IConfigurationService,
        @inject(IKernelProvider) private kernelProvider: IKernelProvider,
        @inject(IDataScienceErrorHandler) private errorHandler: IDataScienceErrorHandler,
        @inject(INotebookEditorProvider) private notebookEditorProvider: INotebookEditorProvider,
        @inject(IServiceContainer) private serviceContainer: IServiceContainer,
        @inject(IKernelStatusProvider) private kernelStatusProvider: IKernelStatusProvider,
        @inject(IDeepnoteInitNotebookRunner)
        @optional()
        private readonly initNotebookRunner: IDeepnoteInitNotebookRunner | undefined
    ) {}

    activate(): void {
        this.register();
    }

    public register(): void {
        this.disposableRegistry.push(
            commands.registerCommand(Commands.NotebookEditorRemoveAllCells, () => this.removeAllCells())
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.NotebookEditorRunFocusedCell, () => this.runFocusedCell())
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.NotebookEditorAddCellBelow, () => this.addCellBelow())
        );
        this.disposableRegistry.push(
            // TODO: if contributed anywhere, add context support
            commands.registerCommand(Commands.RestartKernelAndRunUpToSelectedCell, () =>
                this.restartKernelAndRunUpToSelectedCell()
            )
        );

        this.disposableRegistry.push(
            commands.registerCommand(
                Commands.RestartKernel,
                (context?: { notebookEditor: { notebookUri: Uri } } | Uri) => {
                    if (context && 'notebookEditor' in context) {
                        return this.restartKernelImpl(this.findKernel(context?.notebookEditor?.notebookUri)).catch(
                            noop
                        );
                    } else {
                        return this.restartKernelImpl(this.findKernel(context)).catch(noop);
                    }
                }
            )
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.InterruptKernel, (context?: { notebookEditor: { notebookUri: Uri } }) =>
                this.interruptKernel(context?.notebookEditor?.notebookUri)
            )
        );
        this.disposableRegistry.push(
            commands.registerCommand(
                Commands.RestartKernelAndRunAllCells,
                (context?: { notebookEditor: { notebookUri: Uri } }) => {
                    if (context && 'notebookEditor' in context) {
                        this.restartKernelAndRunAllCells(context?.notebookEditor?.notebookUri).catch(noop);
                    } else {
                        this.restartKernelAndRunAllCells(context).catch(noop);
                    }
                }
            )
        );
    }

    private runAllCells(notebookUri: Uri) {
        const isOpen = workspace.notebookDocuments.some(
            (document) => document.uri.toString() === notebookUri.toString()
        );
        if (isOpen) {
            commands.executeCommand('notebook.execute', notebookUri).then(noop, noop);
        }
    }

    private runFocusedCell() {
        const editor = window.activeNotebookEditor;
        if (!editor) {
            return;
        }

        // Get the first selection range
        const range = editor.selections[0];
        if (!range) {
            return;
        }

        // Execute the cell at the start of the selection
        commands
            .executeCommand('notebook.cell.execute', {
                ranges: [{ start: range.start, end: range.start + 1 }],
                document: editor.notebook.uri
            })
            .then(noop, noop);
    }

    private addCellBelow() {
        if (window.activeNotebookEditor) {
            commands.executeCommand('notebook.cell.insertCodeCellBelow').then(noop, noop);
        }
    }

    private removeAllCells() {
        const document = window.activeNotebookEditor?.notebook;
        if (!document) {
            return;
        }
        const defaultLanguage = this.languageService.getPreferredLanguage(getNotebookMetadata(document));
        chainWithPendingUpdates(document, (edit) => {
            const nbEdit = NotebookEdit.replaceCells(new NotebookRange(0, document.cellCount), [
                new NotebookCellData(NotebookCellKind.Code, '', defaultLanguage)
            ]);
            edit.set(document.uri, [nbEdit]);
        }).then(noop, noop);
    }
    private async interruptKernel(notebookUri: Uri | undefined): Promise<void> {
        const uri = notebookUri ?? this.notebookEditorProvider.activeNotebookEditor?.notebook.uri;
        const document = workspace.notebookDocuments.find((document) => document.uri.toString() === uri?.toString());

        if (document === undefined) {
            return;
        }
        logger.debug(`Command interrupted kernel for ${getDisplayPath(document.uri)}`);

        const kernel = this.kernelProvider.get(document);
        if (!kernel) {
            logger.info(`Interrupt requested & no kernel.`);
            return;
        }
        await this.wrapKernelMethod('interrupt', kernel);
    }

    private async restartKernelAndRunAllCells(notebookUri: Uri | undefined) {
        const uri = notebookUri ?? this.notebookEditorProvider.activeNotebookEditor?.notebook.uri;
        if (!uri) {
            return;
        }

        if (await this.restartKernelAndWaitForInit(this.findKernel(uri))) {
            this.runAllCells(uri);
        }
    }

    private async restartKernelAndRunUpToSelectedCell() {
        const activeNBE = this.notebookEditorProvider.activeNotebookEditor;
        if (!activeNBE) {
            return;
        }

        const selectionEnd = activeNBE.selection.end;
        if (!(await this.restartKernelAndWaitForInit(this.findKernel(activeNBE.notebook.uri)))) {
            return;
        }

        commands
            .executeCommand('notebook.cell.execute', {
                ranges: [{ start: 0, end: selectionEnd }],
                document: activeNBE.notebook.uri
            })
            .then(noop, noop);
    }

    /**
     * Restarts `kernel` and, for a Deepnote notebook with an init notebook, waits for that init run too, so
     * cells run afterwards see the initialised state instead of racing it. Resolves `false` when the user
     * declined the restart or it failed, so callers do not run cells on a kernel that was not restarted.
     * Without a kernel there is nothing to restart and the run itself starts one, so that resolves `true`.
     */
    private async restartKernelAndWaitForInit(kernel: IKernel | undefined): Promise<boolean> {
        if (!kernel) {
            return true;
        }

        if (!(await this.restartKernelImpl(kernel))) {
            return false;
        }

        if (this.initNotebookRunner) {
            await this.initNotebookRunner.waitForInit(kernel);
        }

        return true;
    }

    /** The kernel of `notebookUri`, or of the active notebook when no URI is given (the Command Palette passes none). */
    private findKernel(notebookUri: Uri | undefined): IKernel | undefined {
        const uri = notebookUri ?? this.notebookEditorProvider.activeNotebookEditor?.notebook.uri;
        const document = workspace.notebookDocuments.find((document) => document.uri.toString() === uri?.toString());

        return document ? this.kernelProvider.get(document) : undefined;
    }

    /**
     * Restarts `kernel`, asking first when the setting says so. Resolves `true` once a restart has completed,
     * `false` when the user declined or the restart failed (the failure is already shown to the user).
     */
    private async restartKernelImpl(kernel: IKernel | undefined): Promise<boolean> {
        if (!kernel) {
            return false;
        }

        const notebookUri = kernel.notebook.uri;
        logger.debug(`Restart kernel command handler for ${getDisplayPath(notebookUri)}`);
        if (await this.shouldAskForRestart(notebookUri)) {
            // Ask the user if they want us to restart or not.
            const message = DataScience.restartKernelMessage;
            const yes = DataScience.restartKernelMessageYes;
            const dontAskAgain = DataScience.restartKernelMessageDontAskAgain;

            const response = await window.showInformationMessage(message, { modal: true }, yes, dontAskAgain);
            if (response === dontAskAgain) {
                await this.disableAskForRestart(notebookUri);
            } else if (response !== yes) {
                return false;
            }
        }

        return this.wrapKernelMethod('restart', kernel).catch(() => false);
    }

    public async restartKernel(notebookUri: Uri | undefined, disableUI: boolean = false): Promise<boolean> {
        const kernel = this.findKernel(notebookUri);
        if (!kernel) {
            return false;
        }

        return this.wrapKernelMethod('restart', kernel, disableUI);
    }

    private readonly pendingRestartInterrupt = new WeakMap<IKernel, Promise<boolean>>();
    private async wrapKernelMethod(
        currentContext: 'interrupt' | 'restart',
        kernel: IKernel,
        disableUI: boolean = false
    ): Promise<boolean> {
        const notebook = kernel.notebook;
        // We don't want to create multiple restarts/interrupt requests for the same kernel.
        const pendingPromise = this.pendingRestartInterrupt.get(kernel);
        if (pendingPromise) {
            return pendingPromise;
        }
        const promise = (async () => {
            const currentCell = this.kernelProvider.getKernelExecution(kernel).pendingCells[0];
            const disposable =
                disableUI && currentContext === 'restart'
                    ? this.kernelStatusProvider.hideRestartProgress(kernel)
                    : new Disposable(noop);
            try {
                // Wrap the restart/interrupt in a loop that allows the user to switch
                await KernelConnector.wrapKernelMethod(
                    // The kernel's own connection, not the selected controller's: the two diverge once
                    // the selection moves while this kernel runs, and getOrCreate disposes a kernel
                    // whose metadata id does not match — so interrupting would replace the very kernel
                    // it was asked to interrupt.
                    kernel.kernelConnectionMetadata,
                    currentContext,
                    kernel.creator,
                    this.serviceContainer,
                    { resource: kernel.resourceUri, notebook, controller: kernel.controller },
                    new DisplayOptions(disableUI),
                    this.disposableRegistry
                );
            } catch (ex) {
                if (currentCell) {
                    await endCellAndDisplayErrorsInCell(
                        currentCell,
                        kernel.controller,
                        await this.errorHandler.getErrorMessageForDisplayInCellOutput(
                            ex,
                            currentContext,
                            kernel.resourceUri
                        ),
                        false
                    );
                } else {
                    window.showErrorMessage(ex.toString()).then(noop, noop);
                }

                return false;
            } finally {
                disposable.dispose();
            }

            return true;
        })();
        promise
            .finally(() => {
                if (this.pendingRestartInterrupt.get(kernel) === promise) {
                    this.pendingRestartInterrupt.delete(kernel);
                }
            })
            .catch(noop);
        this.pendingRestartInterrupt.set(kernel, promise);
        return promise;
    }

    private async shouldAskForRestart(notebookUri: Uri): Promise<boolean> {
        if (this.kernelInterruptedDontAskToRestart) {
            return false;
        }
        const settings = this.configurationService.getSettings(notebookUri);
        return settings && settings.askForKernelRestart === true;
    }

    private async disableAskForRestart(notebookUri: Uri): Promise<void> {
        const settings = this.configurationService.getSettings(notebookUri);
        if (settings) {
            this.configurationService
                .updateSetting('askForKernelRestart', false, undefined, ConfigurationTarget.Global)
                .catch(noop);
        }
    }
}
