import { injectable, inject, optional } from 'inversify';
import { workspace, type Disposable, type NotebookDocumentContentOptions } from 'vscode';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
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

    constructor(
        @inject(IExtensionContext) private extensionContext: IExtensionContext,
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(IIntegrationManager) integrationManager: IIntegrationManager,
        @inject(ILogger) private readonly logger: ILogger,
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
        this.explorerView = new DeepnoteExplorerView(this.extensionContext, this.notebookManager, this.logger);
        this.editProtection = new DeepnoteInputBlockEditProtection(this.logger);

        this.registerSerializer();
        this.extensionContext.subscriptions.push(this.editProtection);
        this.extensionContext.subscriptions.push(
            workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('deepnote.snapshots.enabled')) {
                    this.registerSerializer();
                }
            })
        );

        this.explorerView.activate();
        this.integrationManager.activate();
    }

    private registerSerializer(): void {
        // When snapshots are enabled, treat outputs as transient so VS Code
        // doesn't mark the document dirty when outputs change during execution
        const contentOptions: NotebookDocumentContentOptions = {};

        if (this.snapshotService?.isSnapshotsEnabled()) {
            contentOptions.transientOutputs = true;
        }

        this.serializerRegistration?.dispose();
        this.serializerRegistration = workspace.registerNotebookSerializer('deepnote', this.serializer, contentOptions);
        this.extensionContext.subscriptions.push(this.serializerRegistration);
    }
}
