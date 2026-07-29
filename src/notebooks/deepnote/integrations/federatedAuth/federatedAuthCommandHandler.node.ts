import { inject, injectable } from 'inversify';
import { CancellationError, CancellationToken, ProgressLocation, Uri, commands, env, window, workspace } from 'vscode';

import { BigQueryAuthMethods } from '@deepnote/database-integrations';

import { IExtensionSyncActivationService } from '../../../../platform/activation/types';
import { Commands } from '../../../../platform/common/constants';
import { IExtensionContext } from '../../../../platform/common/types';
import { Integrations } from '../../../../platform/common/utils/localize';
import { logger } from '../../../../platform/logging';
import { ISqlIntegrationEnvVarsProvider } from '../../../../platform/notebooks/deepnote/types';
import { IFederatedAuthTokenStorage, type FederatedAuthTokenEntry } from '../types';
import { generateOAuthStateNonce, generatePkcePair } from './googleOAuthProvider.node';
import { computeMetadataFingerprint } from './federatedAuthTokenStorage.node';
import { runOAuthFlow, type RunOAuthFlowParams } from './oauthLoopbackFlow.node';

/** Signature of {@link runOAuthFlow}, exposed as a constructor seam so tests can stub the loopback server. */
export type RunOAuthFlowFn = (params: RunOAuthFlowParams) => Promise<{ refreshToken: string }>;

/**
 * Node-side command handler for `deepnote.authenticateIntegration`: validates the integration, opens a
 * deepnote.com OAuth-proxy URL in the user's browser, accepts the resulting authorization code on a
 * loopback callback, exchanges it for tokens against Google directly, persists the refresh token. The
 * deepnote.com proxy step lets us reuse the customer's existing Google OAuth Web-application client
 * (whose registered redirect URI is `https://deepnote.com/auth/bigquery/google-oauth-callback`) without
 * adding random loopback ports — the loopback URL is only the post-consent landing spot, never the
 * `redirect_uri` Google sees.
 */
@injectable()
export class FederatedAuthCommandHandlerNode implements IExtensionSyncActivationService {
    constructor(
        @inject(IExtensionContext) private readonly extensionContext: IExtensionContext,
        @inject(ISqlIntegrationEnvVarsProvider)
        private readonly sqlIntegrationEnvVars: ISqlIntegrationEnvVarsProvider,
        @inject(IFederatedAuthTokenStorage) private readonly tokenStorage: IFederatedAuthTokenStorage,
        private readonly runOAuthFlowFn: RunOAuthFlowFn = runOAuthFlow
    ) {}

    public activate(): void {
        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.AuthenticateIntegration, (integrationId: string, resource: Uri) =>
                this.authenticate(integrationId, resource)
            )
        );
    }

    /**
     * Core flow. Public so tests can drive the handler without `commands.executeCommand`.
     *
     * `resource` is the notebook the request came from. Required, because the config is resolved per notebook
     * from `.deepnote.env.yaml` merged over SecretStorage — falling back to whichever notebook happens to be
     * focused would let the caller's eligibility check and this lookup mean different notebooks.
     */
    public async authenticate(integrationId: string, resource: Uri): Promise<void> {
        if (typeof integrationId !== 'string' || integrationId.length === 0) {
            logger.warn(
                `FederatedAuthCommandHandlerNode: invoked without a valid integrationId (received: ${String(
                    integrationId
                )})`
            );
            return;
        }

        if (!resource) {
            logger.warn(
                `FederatedAuthCommandHandlerNode: invoked without a resource for integration "${integrationId}"`
            );
            return;
        }

        const integration = (await this.sqlIntegrationEnvVars.getMergedConfigs(resource)).find(
            (config) => config.id === integrationId
        );
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
        const state = generateOAuthStateNonce();
        const { challenge: codeChallenge, verifier: codeVerifier } = generatePkcePair();
        const deepnoteDomain = getDeepnoteDomain(resource);
        const proxyCallbackUrl = `https://${deepnoteDomain}/auth/bigquery/google-oauth-callback`;

        try {
            const refreshTokenResult = await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: Integrations.authenticating(integration.name),
                    cancellable: true
                },
                async (_progress, cancellationToken: CancellationToken) => {
                    return this.runOAuthFlowFn({
                        integrationId,
                        clientId,
                        clientSecret,
                        codeVerifier,
                        redirectUri: proxyCallbackUrl,
                        state,
                        token: cancellationToken,
                        onListening: async (externalCallbackUrl: string) => {
                            const startUrl = buildExtensionStartUrl({
                                deepnoteDomain,
                                clientId,
                                state,
                                codeChallenge,
                                finalRedirect: externalCallbackUrl
                            });
                            logger.info(`FederatedAuthCommandHandlerNode: opening start URL ${startUrl}`);
                            // The promise might hang, and not resolve
                            env.openExternal(Uri.parse(startUrl)).then(
                                (opened) => {
                                    if (!opened) {
                                        logger.warn(
                                            `FederatedAuthCommandHandlerNode: openExternal returned false for ${startUrl}; the user can paste the URL manually.`
                                        );
                                    }
                                },
                                (err) => {
                                    logger.warn(
                                        `FederatedAuthCommandHandlerNode: failed to open browser for ${startUrl}.`,
                                        err
                                    );
                                }
                            );
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

/**
 * Reads the deepnote-host override (`deepnote.domain` setting); default `deepnote.com`. Mirrors
 * `importClient.node.ts`. Scoped to the requesting notebook so workspace/folder overrides apply.
 */
function getDeepnoteDomain(resource: Uri): string {
    return workspace.getConfiguration('deepnote', resource).get<string>('domain') ?? 'deepnote.com';
}

/** Builds the proxy-start URL the user's browser will open. Public for unit tests. */
export function buildExtensionStartUrl(params: {
    clientId: string;
    codeChallenge: string;
    deepnoteDomain: string;
    finalRedirect: string;
    state: string;
}): string {
    const url = new URL(`https://${params.deepnoteDomain}/auth/bigquery/extension/start`);
    url.searchParams.set('client_id', params.clientId);
    url.searchParams.set('state', params.state);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('final_redirect', params.finalRedirect);

    return url.toString();
}
