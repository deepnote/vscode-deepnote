import { inject, injectable, optional } from 'inversify';
import {
    CancellationTokenSource,
    commands,
    l10n,
    NotebookEdit,
    NotebookRange,
    workspace,
    window,
    WorkspaceEdit,
    type Disposable,
    type NotebookDocument,
    type NotebookDocumentContentOptions
} from 'vscode';

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
const MISMATCH_CHECK_DELAY_MS = 200;
const MAX_MISMATCH_RETRIES = 10;

@injectable()
export class DeepnoteActivationService implements IExtensionSyncActivationService {
    private editProtection: DeepnoteInputBlockEditProtection;

    private explorerView: DeepnoteExplorerView;

    private integrationManager: IIntegrationManager;

    private mismatchCheckTimer: ReturnType<typeof setTimeout> | undefined;

    private mismatchRetryCount = 0;

    private serializer: DeepnoteNotebookSerializer;

    private serializerRegistration?: Disposable;

    private snapshotsEnabled = false;

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
        this.snapshotsEnabled = this.isSnapshotsEnabled();

        this.extensionContext.subscriptions.push(
            workspace.onDidOpenNotebookDocument((doc) => {
                if (doc.notebookType !== 'deepnote') {
                    return;
                }

                if (new URLSearchParams(doc.uri.query).has('notebook')) {
                    this.scheduleMismatchCheck();
                }
            })
        );

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

    /**
     * Checks all open deepnote documents for URI/metadata notebook ID mismatches
     * and fixes them by re-deserializing with the correct notebook ID.
     * This handles the case where VS Code's deserializeNotebook API does not
     * pass the document URI, causing the wrong notebook to be loaded on reload.
     */
    private async checkAndFixMismatches(): Promise<void> {
        const hasLoadingDocs = workspace.notebookDocuments.some(
            (doc) =>
                doc.notebookType === 'deepnote' &&
                !doc.metadata?.deepnoteNotebookId &&
                new URLSearchParams(doc.uri.query).has('notebook')
        );

        if (hasLoadingDocs && this.mismatchRetryCount < MAX_MISMATCH_RETRIES) {
            this.mismatchRetryCount++;
            this.scheduleMismatchCheck();

            return;
        }

        this.mismatchRetryCount = 0;

        for (const doc of workspace.notebookDocuments) {
            if (doc.notebookType !== 'deepnote' || doc.isClosed) {
                continue;
            }

            const uriNotebookId = new URLSearchParams(doc.uri.query).get('notebook');
            const metadataNotebookId = doc.metadata?.deepnoteNotebookId as string | undefined;

            if (!uriNotebookId || uriNotebookId === metadataNotebookId) {
                continue;
            }

            await this.fixDocumentNotebook(doc, uriNotebookId);
        }
    }

    private async fixDocumentNotebook(doc: NotebookDocument, correctNotebookId: string): Promise<void> {
        const fileUri = doc.uri.with({ query: '', fragment: '' });

        let content: Uint8Array;
        try {
            content = await workspace.fs.readFile(fileUri);
        } catch {
            this.logger.warn(`[DeepnoteActivation] Cannot read file for mismatch fix: ${fileUri.path}`);

            return;
        }

        const cts = new CancellationTokenSource();
        try {
            const data = await this.serializer.deserializeNotebook(content, cts.token, correctNotebookId);

            const wsEdit = new WorkspaceEdit();
            wsEdit.set(doc.uri, [
                NotebookEdit.replaceCells(new NotebookRange(0, doc.cellCount), data.cells),
                NotebookEdit.updateNotebookMetadata(data.metadata!)
            ]);
            await workspace.applyEdit(wsEdit);
            await doc.save();

            this.logger.info(
                `[DeepnoteActivation] Fixed notebook mismatch for ${doc.uri.path}: ` +
                    `loaded ${correctNotebookId} (was ${doc.metadata?.deepnoteNotebookId})`
            );
        } catch (error) {
            this.logger.error(`[DeepnoteActivation] Failed to fix notebook mismatch: ${doc.uri.path}`, error);
        } finally {
            cts.dispose();
        }
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

    private scheduleMismatchCheck(): void {
        if (this.mismatchCheckTimer !== undefined) {
            clearTimeout(this.mismatchCheckTimer);
        }

        this.mismatchCheckTimer = setTimeout(() => {
            this.mismatchCheckTimer = undefined;
            void this.checkAndFixMismatches();
        }, MISMATCH_CHECK_DELAY_MS);
    }
}
