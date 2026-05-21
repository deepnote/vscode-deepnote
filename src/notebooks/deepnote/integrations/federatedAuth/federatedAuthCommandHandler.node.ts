import { inject, injectable } from 'inversify';
import { CancellationError, CancellationToken, ProgressLocation, Uri, commands, env, window } from 'vscode';

import { BigQueryAuthMethods } from '@deepnote/database-integrations';

import { IExtensionSyncActivationService } from '../../../../platform/activation/types';
import { Commands } from '../../../../platform/common/constants';
import { IExtensionContext } from '../../../../platform/common/types';
import { Integrations } from '../../../../platform/common/utils/localize';
import { logger } from '../../../../platform/logging';
import { IIntegrationStorage } from '../../../../platform/notebooks/deepnote/types';
import { IFederatedAuthTokenStorage, type FederatedAuthTokenEntry } from '../types';
import { buildBigQueryGoogleOAuthStrategy, createInMemoryPkceStore } from './googleOAuthProvider.node';
import { computeMetadataFingerprint } from './federatedAuthTokenStorage.node';
import { runOAuthFlow, type RunOAuthFlowParams } from './oauthLoopbackFlow.node';

/**
 * Function signature of {@link runOAuthFlow}. Exposed as a constructor seam
 * so unit tests can inject a stub without monkey-patching the real
 * implementation (which would also boot an `express` loopback server).
 */
export type RunOAuthFlowFn = (params: RunOAuthFlowParams) => Promise<{ refreshToken: string }>;

/**
 * Node-side command handler for `deepnote.authenticateIntegration`.
 *
 * Looks up the requested integration, validates that it's a BigQuery
 * integration configured for Google OAuth, then runs the loopback OAuth
 * flow built on `passport-google-oauth20`. On success the refresh token is
 * persisted via {@link IFederatedAuthTokenStorage}; on cancellation the
 * command exits silently; on any other failure it shows a localized error
 * toast.
 *
 * Remote VS Code (SSH-remote, Codespaces, WSL) is not supported in this
 * milestone — Google "Desktop app" OAuth clients only accept
 * `http://127.0.0.1:<port>/auth/callback` redirects, and tunneling the
 * callback through `asExternalUri` produces an `https://*.vscode.dev/...`
 * URL that Google rejects. We surface a clear message and exit early.
 */
@injectable()
export class FederatedAuthCommandHandlerNode implements IExtensionSyncActivationService {
    constructor(
        @inject(IExtensionContext) private readonly extensionContext: IExtensionContext,
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage,
        @inject(IFederatedAuthTokenStorage) private readonly tokenStorage: IFederatedAuthTokenStorage,
        private readonly runOAuthFlowFn: RunOAuthFlowFn = runOAuthFlow
    ) {}

    public activate(): void {
        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.AuthenticateIntegration, (integrationId: string) =>
                this.authenticate(integrationId)
            )
        );
    }

    /**
     * Core flow. Public so tests can drive the handler without going
     * through `commands.executeCommand`.
     */
    public async authenticate(integrationId: string): Promise<void> {
        if (typeof integrationId !== 'string' || integrationId.length === 0) {
            logger.warn(
                `FederatedAuthCommandHandlerNode: invoked without a valid integrationId (received: ${String(
                    integrationId
                )})`
            );
            return;
        }

        // Remote VS Code is not supported — see class comment.
        if (env.remoteName !== undefined) {
            logger.info(
                `FederatedAuthCommandHandlerNode: remote scenario detected (${env.remoteName}); aborting federated auth.`
            );
            void window.showInformationMessage(Integrations.federatedAuthNotSupportedInRemote);
            return;
        }

        const integration = await this.integrationStorage.getIntegrationConfig(integrationId);
        if (!integration) {
            logger.warn(`FederatedAuthCommandHandlerNode: integration "${integrationId}" not found.`);
            void window.showErrorMessage(Integrations.federatedAuthIntegrationNotFound(integrationId));
            return;
        }

        if (integration.type !== 'big-query' || integration.metadata.authMethod !== BigQueryAuthMethods.GoogleOauth) {
            logger.warn(
                `FederatedAuthCommandHandlerNode: integration "${integration.name}" is not configured for Google OAuth.`
            );
            void window.showErrorMessage(Integrations.federatedAuthIntegrationNotConfiguredForOAuth(integration.name));
            return;
        }

        const { clientId, clientSecret, project } = integration.metadata;
        const { strategy, completion } = buildBigQueryGoogleOAuthStrategy({
            clientId,
            clientSecret,
            store: createInMemoryPkceStore()
        });

        try {
            const refreshTokenResult = await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: Integrations.authenticating(integration.name),
                    cancellable: true
                },
                async (_progress, token: CancellationToken) => {
                    return this.runOAuthFlowFn({
                        integrationId,
                        strategy,
                        completion,
                        token,
                        onListening: async (startUrl: string) => {
                            try {
                                const externalUri = await env.asExternalUri(Uri.parse(startUrl));
                                const opened = await env.openExternal(externalUri);
                                if (!opened) {
                                    logger.warn(
                                        `FederatedAuthCommandHandlerNode: openExternal returned false for ${startUrl}; the user can paste the URL manually.`
                                    );
                                }
                            } catch (err) {
                                logger.warn(
                                    `FederatedAuthCommandHandlerNode: failed to open browser for ${startUrl}.`,
                                    err
                                );
                            }
                        }
                    });
                }
            );

            const entry: FederatedAuthTokenEntry = {
                integrationId,
                refreshToken: refreshTokenResult.refreshToken,
                metadataFingerprint: computeMetadataFingerprint({ clientId, clientSecret, project })
            };
            await this.tokenStorage.save(entry);

            void window.showInformationMessage(Integrations.authenticationSucceeded(integration.name));
        } catch (err) {
            if (err instanceof CancellationError) {
                logger.info(`FederatedAuthCommandHandlerNode: authentication cancelled for "${integration.name}".`);
                return;
            }
            const message = err instanceof Error ? err.message : String(err);
            logger.error(`FederatedAuthCommandHandlerNode: authentication failed for "${integration.name}".`, err);
            void window.showErrorMessage(Integrations.authenticationFailed(message));
        }
    }
}
