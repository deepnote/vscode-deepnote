import { inject, injectable } from 'inversify';
import {
    Disposable,
    Event,
    EventEmitter,
    NotebookDocument,
    NotebookEditor,
    StatusBarAlignment,
    StatusBarItem,
    ThemeColor,
    Uri,
    l10n,
    window,
    workspace
} from 'vscode';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { logger } from '../../platform/logging';
import {
    DEEPNOTE_NOTEBOOK_TYPE,
    IDeepnoteEnvironmentManager,
    IDeepnoteProjectEnvironmentMapper
} from '../../kernels/deepnote/types';
import { IControllerRegistration, IVSCodeNotebookController } from '../controllers/types';
import { Commands } from '../../platform/common/constants';

export interface DeepnoteNotebookKernelStatus {
    readonly label: string;
    readonly connectionId: string;
    readonly controllerId: string;
    readonly environmentId?: string;
    readonly notebookUri: Uri;
    readonly notebookId?: string;
}

export interface DeepnoteNotebookKernelStatusChange {
    key: string;
    status?: DeepnoteNotebookKernelStatus;
}

export const IDeepnoteKernelStatusService = Symbol('IDeepnoteKernelStatusService');

export interface IDeepnoteKernelStatusService {
    readonly onDidChangeStatus: Event<DeepnoteNotebookKernelStatusChange>;
    getStatus(key: string): DeepnoteNotebookKernelStatus | undefined;
    getStatusForNotebook(notebook: NotebookDocument): DeepnoteNotebookKernelStatus | undefined;
    getAllStatuses(): IterableIterator<[string, DeepnoteNotebookKernelStatus]>;
}

function normalizeNotebookBaseUri(uri: Uri): string {
    const normalized = uri.with({ query: '', fragment: '' });
    // toString(true) keeps the URI unencoded, matching how fsPath-based keys are generated elsewhere
    return normalized.toString(true);
}

export function getNotebookStatusKeyFromNotebook(notebook: NotebookDocument): string {
    const base = normalizeNotebookBaseUri(notebook.uri);
    const notebookId = notebook.metadata?.deepnoteNotebookId;
    return notebookId ? `${base}#${notebookId}` : base;
}

export function getNotebookStatusKeyFromFilePath(filePath: string, notebookId?: string): string {
    const base = normalizeNotebookBaseUri(Uri.file(filePath));
    return notebookId ? `${base}#${notebookId}` : base;
}

interface InternalNotebookKernelStatus extends DeepnoteNotebookKernelStatus {
    readonly statusKey: string;
}

@injectable()
export class DeepnoteKernelStatusIndicator
    implements IDeepnoteKernelStatusService, IExtensionSyncActivationService, Disposable
{
    private readonly statusEmitter = new EventEmitter<DeepnoteNotebookKernelStatusChange>();
    private readonly statuses = new Map<string, InternalNotebookKernelStatus>();
    private readonly controllerDisposables = new Map<string, Disposable>();
    private readonly disposables: Disposable[] = [];
    private statusBarItem: StatusBarItem | undefined;
    private updateTimer: NodeJS.Timeout | undefined;
    private disposed = false;
    private readonly statusBarBackground = new ThemeColor('statusBarItem.warningBackground');
    private readonly statusBarForeground = new ThemeColor('statusBarItem.warningForeground');

    constructor(
        @inject(IDisposableRegistry) disposableRegistry: IDisposableRegistry,
        @inject(IControllerRegistration) private readonly controllerRegistration: IControllerRegistration,
        @inject(IDeepnoteProjectEnvironmentMapper)
        private readonly environmentMapper: IDeepnoteProjectEnvironmentMapper,
        @inject(IDeepnoteEnvironmentManager) private readonly environmentManager: IDeepnoteEnvironmentManager
    ) {
        disposableRegistry.push(this);
    }

    public get onDidChangeStatus(): Event<DeepnoteNotebookKernelStatusChange> {
        return this.statusEmitter.event;
    }

    public getStatus(key: string): DeepnoteNotebookKernelStatus | undefined {
        return this.statuses.get(key);
    }

    public getStatusForNotebook(notebook: NotebookDocument): DeepnoteNotebookKernelStatus | undefined {
        const key = getNotebookStatusKeyFromNotebook(notebook);
        return this.statuses.get(key);
    }

    public getAllStatuses(): IterableIterator<[string, DeepnoteNotebookKernelStatus]> {
        return this.statuses.entries();
    }

    public activate(): void {
        this.statusBarItem = window.createStatusBarItem('deepnote.kernelStatus', StatusBarAlignment.Right, 100);
        this.statusBarItem.name = l10n.t('Deepnote Kernel Status');
        this.statusBarItem.tooltip = l10n.t('Deepnote kernel status indicator');
        this.statusBarItem.hide();
        this.statusBarItem.backgroundColor = this.statusBarBackground;
        this.statusBarItem.color = this.statusBarForeground;
        this.statusBarItem.command = Commands.RevealInDeepnoteExplorer;
        this.disposables.push(this.statusBarItem);

        this.controllerRegistration.onControllerSelected(this.handleControllerSelected, this, this.disposables);
        this.controllerRegistration.onControllerSelectionChanged(
            this.handleControllerSelectionChanged,
            this,
            this.disposables
        );
        workspace.onDidCloseNotebookDocument(this.handleNotebookClosed, this, this.disposables);
        window.onDidChangeActiveNotebookEditor(this.handleActiveEditorChanged, this, this.disposables);
        this.environmentManager.onDidChangeEnvironments(this.handleEnvironmentsChanged, this, this.disposables);

        for (const notebook of workspace.notebookDocuments) {
            this.initializeNotebookStatus(notebook);
        }

        void this.environmentManager.waitForInitialization().then(
            () => this.handleEnvironmentsChanged(),
            (error) => logger.error('Failed waiting for Deepnote environment manager initialization', error)
        );

        this.scheduleStatusBarUpdate();
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;

        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
            this.updateTimer = undefined;
        }

        for (const disposable of this.controllerDisposables.values()) {
            disposable.dispose();
        }
        this.controllerDisposables.clear();

        this.statusEmitter.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            try {
                disposable?.dispose();
            } catch (error) {
                logger.warn('Error disposing Deepnote kernel status indicator resource', error);
            }
        }
    }

    private initializeNotebookStatus(notebook: NotebookDocument) {
        if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        const controller = this.controllerRegistration.getSelected(notebook);
        if (controller && controller.connection.kind === 'startUsingDeepnoteKernel') {
            this.setStatus(notebook, controller);
        }
    }

    private handleControllerSelected(event: { notebook: NotebookDocument; controller: IVSCodeNotebookController }) {
        if (event.notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        if (event.controller.connection.kind !== 'startUsingDeepnoteKernel') {
            return;
        }

        this.setStatus(event.notebook, event.controller);
    }

    private handleControllerSelectionChanged(event: {
        notebook: NotebookDocument;
        controller: IVSCodeNotebookController;
        selected: boolean;
    }) {
        if (event.notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        if (event.controller.connection.kind !== 'startUsingDeepnoteKernel') {
            return;
        }

        if (event.selected) {
            this.setStatus(event.notebook, event.controller);
        } else {
            this.removeStatus(getNotebookStatusKeyFromNotebook(event.notebook), event.controller.connection.id);
        }
    }

    private handleNotebookClosed(notebook: NotebookDocument) {
        if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        this.removeStatus(getNotebookStatusKeyFromNotebook(notebook));
    }

    private handleActiveEditorChanged(_: NotebookEditor | undefined) {
        this.scheduleStatusBarUpdate();
    }

    private handleEnvironmentsChanged() {
        for (const notebook of workspace.notebookDocuments) {
            if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
                continue;
            }
            const key = getNotebookStatusKeyFromNotebook(notebook);
            if (!this.statuses.has(key)) {
                continue;
            }
            const controller = this.controllerRegistration.getSelected(notebook);
            if (!controller || controller.connection.kind !== 'startUsingDeepnoteKernel') {
                continue;
            }
            this.setStatus(notebook, controller);
        }
        this.scheduleStatusBarUpdate();
    }

    private setStatus(notebook: NotebookDocument, controller: IVSCodeNotebookController) {
        const key = getNotebookStatusKeyFromNotebook(notebook);
        const status = this.createStatus(key, notebook, controller);
        if (!status) {
            return;
        }

        this.statuses.set(key, status);

        // Dispose any previous listener
        this.controllerDisposables.get(key)?.dispose();
        const disposeListener = controller.onDidDispose(() => {
            this.removeStatus(key, controller.connection.id);
        });
        this.controllerDisposables.set(key, disposeListener);

        this.statusEmitter.fire({ key, status });
        this.scheduleStatusBarUpdate();
    }

    private removeStatus(key: string, controllerConnectionId?: string) {
        const existing = this.statuses.get(key);
        if (!existing) {
            return;
        }

        if (controllerConnectionId && existing.connectionId !== controllerConnectionId) {
            return;
        }

        this.statuses.delete(key);
        const disposable = this.controllerDisposables.get(key);
        disposable?.dispose();
        this.controllerDisposables.delete(key);

        this.statusEmitter.fire({ key, status: undefined });
        this.scheduleStatusBarUpdate();
    }

    private createStatus(
        statusKey: string,
        notebook: NotebookDocument,
        controller: IVSCodeNotebookController
    ): InternalNotebookKernelStatus | undefined {
        if (controller.connection.kind !== 'startUsingDeepnoteKernel') {
            return undefined;
        }

        const projectId = notebook.metadata?.deepnoteProjectId as string | undefined;
        const environmentId = projectId ? this.environmentMapper.getEnvironmentForProject(projectId) : undefined;
        const environmentName = environmentId ? this.environmentManager.getEnvironment(environmentId)?.name : undefined;
        const connection = controller.connection;

        const label = environmentName ?? connection.environmentName ?? controller.controller.label ?? connection.id;

        return {
            statusKey,
            label,
            connectionId: connection.id,
            controllerId: controller.id,
            environmentId,
            notebookUri: notebook.uri,
            notebookId: notebook.metadata?.deepnoteNotebookId
        };
    }

    private scheduleStatusBarUpdate() {
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
        }
        this.updateTimer = setTimeout(() => {
            this.updateTimer = undefined;
            this.updateStatusBar();
        }, 100);
    }

    private updateStatusBar() {
        const item = this.statusBarItem;
        if (!item) {
            return;
        }

        const editor = window.activeNotebookEditor;
        if (!editor) {
            item.backgroundColor = undefined;
            item.hide();
            return;
        }

        const notebook = editor.notebook;
        if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            item.backgroundColor = undefined;
            item.hide();
            return;
        }

        const status = this.getStatusForNotebook(notebook);
        if (!status) {
            item.backgroundColor = undefined;
            item.hide();
            return;
        }

        item.text = `$(beaker) ${l10n.t('Deepnote kernel: {0}', status.label)}`;

        const tooltipLines = [l10n.t('Deepnote kernel: {0}', status.label)];
        tooltipLines.push(l10n.t('Controller ID: {0}', status.connectionId));
        if (status.environmentId) {
            tooltipLines.push(l10n.t('Environment ID: {0}', status.environmentId));
        }

        item.tooltip = tooltipLines.join('\n');
        item.backgroundColor = this.statusBarBackground;
        item.color = this.statusBarForeground;
        item.show();
    }
}
