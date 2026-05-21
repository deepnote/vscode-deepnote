import { inject, injectable } from 'inversify';
import { NotebookDocument, workspace } from 'vscode';

import { IExtensionSyncActivationService } from '../../../../platform/activation/types';
import { IDisposableRegistry } from '../../../../platform/common/types';
import { logger } from '../../../../platform/logging';
import { IKernelProvider } from '../../../../kernels/types';
import { IDeepnoteNotebookManager } from '../../../types';
import { IFederatedAuthTokenStorage } from '../types';

/**
 * Node-only bridge that restarts kernels for notebooks whose Deepnote
 * project references a federated integration whose token just changed.
 *
 * This restart is mostly defensive: no federated cell references the
 * integration between executions (the silent pre-execute defines a fresh
 * variable for every run). But restarting on token change clears any
 * stale `os.environ` mutations and any kernel globals defined in earlier
 * sessions, so the next cell starts with a clean slate.
 *
 * The existing {@link IntegrationKernelRestartHandler} stays unchanged —
 * it's bound on both node and web, and {@link IFederatedAuthTokenStorage}
 * is node-only. Per the plan (Step 9), the federated path lives in this
 * separate `.node.ts` bridge.
 */
@injectable()
export class FederatedAuthKernelRestartBridge implements IExtensionSyncActivationService {
    constructor(
        @inject(IFederatedAuthTokenStorage) private readonly tokenStorage: IFederatedAuthTokenStorage,
        @inject(IKernelProvider) private readonly kernelProvider: IKernelProvider,
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(IDisposableRegistry) disposables: IDisposableRegistry
    ) {
        logger.info('FederatedAuthKernelRestartBridge: Initialized');

        disposables.push(
            this.tokenStorage.onDidChangeTokens((integrationId) => {
                this.onTokenChanged(integrationId).catch((err) =>
                    logger.error(
                        `FederatedAuthKernelRestartBridge: Failed to handle token change for integration ${integrationId}`,
                        err
                    )
                );
            })
        );
    }

    public activate(): void {
        // Service is activated via constructor.
    }

    /**
     * Walk open notebook documents, find the ones whose Deepnote project
     * references the affected integration, and restart their kernels.
     */
    private async onTokenChanged(integrationId: string): Promise<void> {
        logger.info(
            `FederatedAuthKernelRestartBridge: Token changed for integration ${integrationId}, checking affected kernels`
        );

        const notebooksToRestart: NotebookDocument[] = [];

        for (const notebook of workspace.notebookDocuments) {
            if (notebook.notebookType !== 'deepnote') {
                continue;
            }

            const kernel = this.kernelProvider.get(notebook);
            if (!kernel || !kernel.startedAtLeastOnce) {
                continue;
            }

            const projectId = notebook.metadata?.deepnoteProjectId as string | undefined;
            if (!projectId) {
                continue;
            }

            const project = this.notebookManager.getOriginalProject(projectId);
            if (!project) {
                continue;
            }

            const projectIntegrations = project.project.integrations ?? [];
            if (projectIntegrations.some((integration) => integration.id === integrationId)) {
                notebooksToRestart.push(notebook);
            }
        }

        if (notebooksToRestart.length === 0) {
            logger.info(
                `FederatedAuthKernelRestartBridge: No running kernels reference integration ${integrationId}; nothing to restart`
            );
            return;
        }

        logger.info(
            `FederatedAuthKernelRestartBridge: Restarting ${notebooksToRestart.length} kernel(s) for integration ${integrationId}`
        );

        // Per-iteration error handling keeps one failure from stopping the rest.
        await Promise.all(
            notebooksToRestart.map(async (notebook) => {
                const kernel = this.kernelProvider.get(notebook);
                if (!kernel) {
                    return;
                }
                try {
                    await kernel.restart();
                    logger.info(
                        `FederatedAuthKernelRestartBridge: Successfully restarted kernel for ${notebook.uri.toString()}`
                    );
                } catch (error) {
                    logger.error(
                        `FederatedAuthKernelRestartBridge: Failed to restart kernel for ${notebook.uri.toString()}`,
                        error
                    );
                }
            })
        );
    }
}
