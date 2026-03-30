import { inject, injectable, optional } from 'inversify';
import { commands, l10n, workspace, window, type Disposable, type NotebookDocumentContentOptions } from 'vscode';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { ITelemetryService } from '../../platform/analytics/types';
import { IExtensionContext } from '../../platform/common/types';
import { ILogger } from '../../platform/logging/types';
import { IDeepnoteNotebookManager } from '../types';
import { DeepnoteNotebookSerializer } from './deepnoteSerializer';
import { DeepnoteExplorerView } from './deepnoteExplorerView';
import { IIntegrationManager } from './integrations/types';
import { DeepnoteInputBlockEditProtection } from './deepnoteInputBlockEditProtection';
import { SnapshotService } from './snapshots/snapshotService';

/**
 * Service responsible for activating and configuring Deepnote notebook support in VS Code.
 * Registers serializers, command handlers, and manages the notebook selection workflow.
 */
@injectable()
export class DeepnoteActivationService implements IExtensionSyncActivationService {
    private editProtection: DeepnoteInputBlockEditProtection;

    private explorerView: DeepnoteExplorerView;

    private integrationManager: IIntegrationManager;

    private serializer: DeepnoteNotebookSerializer;

    private serializerRegistration?: Disposable;

    private snapshotsEnabled = false;

    constructor(
        @inject(IExtensionContext) private extensionContext: IExtensionContext,
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(IIntegrationManager) integrationManager: IIntegrationManager,
        @inject(ILogger) private readonly logger: ILogger,
        @inject(ITelemetryService) private readonly analytics: ITelemetryService,
        @inject(SnapshotService) @optional() private readonly snapshotService?: SnapshotService
    ) {
        this.integrationManager = integrationManager;
    }

    /**
     * Activates Deepnote support by registering serializers and commands.
     * Called during extension activation to set up Deepnote integration.
     */
    public activate() {
        this.serializer = new DeepnoteNotebookSerializer(this.notebookManager, this.snapshotService);
        this.explorerView = new DeepnoteExplorerView(
            this.extensionContext,
            this.notebookManager,
            this.logger,
            this.analytics
        );
        this.editProtection = new DeepnoteInputBlockEditProtection(this.logger);
        this.snapshotsEnabled = this.isSnapshotsEnabled();

        this.registerSerializer();
        this.extensionContext.subscriptions.push(this.editProtection);
        this.extensionContext.subscriptions.push(
            workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('deepnote.snapshots.enabled')) {
                    const snapshotsEnabled = this.isSnapshotsEnabled();

                    if (!this.snapshotsEnabled && snapshotsEnabled) {
                        this.promptReloadForSnapshots();
                    }

                    this.snapshotsEnabled = snapshotsEnabled;
                    this.registerSerializer();
                }
            })
        );

        this.explorerView.activate();
        this.integrationManager.activate();
    }

    private isSnapshotsEnabled(): boolean {
        if (this.snapshotService) {
            return this.snapshotService.isSnapshotsEnabled();
        }

        const config = workspace.getConfiguration('deepnote');

        return config.get<boolean>('snapshots.enabled', true);
    }

    private promptReloadForSnapshots(): void {
        const hasOpenDeepnoteNotebooks = workspace.notebookDocuments.some(
            (notebook) => notebook.notebookType === 'deepnote'
        );

        if (!hasOpenDeepnoteNotebooks) {
            void window.showInformationMessage(l10n.t('Snapshots enabled for this workspace.'));

            return;
        }

        const reloadOption = l10n.t('Reload Window');
        const laterOption = l10n.t('Later'); // Dismisses the dialog without action

        void window
            .showInformationMessage(
                l10n.t('Snapshots enabled. Reload the window to apply to open notebooks.'),
                reloadOption,
                laterOption
            )
            .then((selection) => {
                if (selection === reloadOption) {
                    void commands.executeCommand('workbench.action.reloadWindow');
                }
                // "Later" or dialog dismissal: no action needed
            });
    }

    private registerSerializer(): void {
        // When snapshots are enabled, treat outputs as transient so VS Code
        // doesn't mark the document dirty when outputs change during execution
        const contentOptions: NotebookDocumentContentOptions = {};

        if (this.isSnapshotsEnabled()) {
            contentOptions.transientOutputs = true;
        }

        if (this.serializerRegistration) {
            this.serializerRegistration.dispose();

            const idx = this.extensionContext.subscriptions.indexOf(this.serializerRegistration);

            if (idx >= 0) {
                this.extensionContext.subscriptions.splice(idx, 1);
            }
        }

        this.serializerRegistration = workspace.registerNotebookSerializer('deepnote', this.serializer, contentOptions);
        this.extensionContext.subscriptions.push(this.serializerRegistration);
    }
}
