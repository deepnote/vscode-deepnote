import { injectable, inject, optional } from 'inversify';
import { workspace } from 'vscode';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IExtensionContext } from '../../platform/common/types';
import { ILogger } from '../../platform/logging/types';
import { IDeepnoteNotebookManager } from '../types';
import { DeepnoteNotebookSerializer } from './deepnoteSerializer';
import { DeepnoteExplorerView } from './deepnoteExplorerView';
import { IIntegrationManager } from './integrations/types';
import { DeepnoteInputBlockEditProtection } from './deepnoteInputBlockEditProtection';
import { ISnapshotMetadataService, ISnapshotMetadataServiceFull } from './snapshotMetadataService';
import { ISnapshotFileService } from './snapshotFileServiceTypes';

/**
 * Service responsible for activating and configuring Deepnote notebook support in VS Code.
 * Registers serializers, command handlers, and manages the notebook selection workflow.
 */
@injectable()
export class DeepnoteActivationService implements IExtensionSyncActivationService {
    private explorerView: DeepnoteExplorerView;

    private integrationManager: IIntegrationManager;

    private serializer: DeepnoteNotebookSerializer;

    private editProtection: DeepnoteInputBlockEditProtection;

    constructor(
        @inject(IExtensionContext) private extensionContext: IExtensionContext,
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(IIntegrationManager) integrationManager: IIntegrationManager,
        @inject(ILogger) private readonly logger: ILogger,
        @inject(ISnapshotMetadataService) @optional() private readonly snapshotService?: ISnapshotMetadataServiceFull,
        @inject(ISnapshotFileService) @optional() private readonly snapshotFileService?: ISnapshotFileService
    ) {
        this.integrationManager = integrationManager;
    }

    /**
     * Activates Deepnote support by registering serializers and commands.
     * Called during extension activation to set up Deepnote integration.
     */
    public activate() {
        this.serializer = new DeepnoteNotebookSerializer(
            this.notebookManager,
            this.snapshotService,
            this.snapshotFileService
        );
        this.explorerView = new DeepnoteExplorerView(this.extensionContext, this.notebookManager, this.logger);
        this.editProtection = new DeepnoteInputBlockEditProtection(this.logger);

        this.extensionContext.subscriptions.push(workspace.registerNotebookSerializer('deepnote', this.serializer));
        this.extensionContext.subscriptions.push(this.editProtection);

        this.explorerView.activate();
        this.integrationManager.activate();
    }
}
