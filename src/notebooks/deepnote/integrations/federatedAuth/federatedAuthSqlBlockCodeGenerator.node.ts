import type { DeepnoteBlock } from '@deepnote/blocks';
import { BigQueryAuthMethods } from '@deepnote/database-integrations';
import { inject, injectable } from 'inversify';
import { Uri } from 'vscode';

import { ISqlIntegrationEnvVarsProvider } from '../../../../platform/notebooks/deepnote/types';
import {
    fetchFreshAccessToken,
    InvalidClientError,
    InvalidGrantError,
    computeMetadataFingerprint
} from './federatedAuthTokenStorage.node';
import { GOOGLE_TOKEN_URL } from './googleOAuthProvider.node';
import {
    createDataFrameConfig,
    executeSqlQueryWithConnectionJson,
    sanitizePythonVariableName,
    SqlCacheMode,
    SqlCellVariableType
} from './vendoredBlocksHelpers';
import {
    FederatedAuthTokenEntry,
    IFederatedAuthSqlBlockCodeGenerator,
    IFederatedAuthTokenStorage,
    NotAuthenticatedError,
    OAuthClientMisconfiguredError
} from '../types';

@injectable()
export class FederatedAuthSqlBlockCodeGenerator implements IFederatedAuthSqlBlockCodeGenerator {
    constructor(
        @inject(ISqlIntegrationEnvVarsProvider)
        private readonly sqlIntegrationEnvVars: ISqlIntegrationEnvVarsProvider,
        @inject(IFederatedAuthTokenStorage) private readonly tokenStorage: IFederatedAuthTokenStorage
    ) {}

    /** Delegates to {@link fetchFreshAccessToken}; instance method so tests can `sinon.stub` without a ctor seam. */
    public fetchFreshAccessToken(
        entry: FederatedAuthTokenEntry,
        oauthConfig: { tokenUrl: string; clientId: string; clientSecret: string }
    ): Promise<{ accessToken: string; newRefreshToken?: string }> {
        return fetchFreshAccessToken(entry, oauthConfig);
    }

    public async generate(block: DeepnoteBlock, notebookUri: Uri): Promise<string | undefined> {
        if (block.type !== 'sql') {
            return undefined;
        }

        // Discriminator above narrows `block` to `SqlBlock`.
        const sqlBlock = block;
        const integrationId = sqlBlock.metadata?.sql_integration_id;
        if (!integrationId) {
            return undefined;
        }

        // Merged configs, not SecretStorage: a federated integration can be declared purely in `.deepnote.env.yaml`,
        // and when both sources have it the file wins — same resolution the kernel and the SQL LSP use.
        const integration = (await this.sqlIntegrationEnvVars.getMergedConfigs(notebookUri)).find(
            (config) => config.id === integrationId
        );
        if (!integration || integration.type !== 'big-query') {
            return undefined;
        }
        if (integration.metadata.authMethod !== BigQueryAuthMethods.GoogleOauth) {
            return undefined;
        }

        // Federated path: any "no usable token" branch must throw NotAuthenticatedError so the UI offers Authenticate.
        const entry = await this.tokenStorage.get(integrationId);
        if (!entry) {
            throw new NotAuthenticatedError(integration.name);
        }

        const currentFingerprint = computeMetadataFingerprint({
            clientId: integration.metadata.clientId,
            clientSecret: integration.metadata.clientSecret,
            project: integration.metadata.project
        });
        if (currentFingerprint !== entry.metadataFingerprint) {
            // OAuth client metadata edited since save: stored refresh token is bound to a different client. Drop it.
            await this.tokenStorage.delete(integrationId);
            throw new NotAuthenticatedError(integration.name);
        }

        let accessToken: string;
        let newRefreshToken: string | undefined;
        try {
            const result = await this.fetchFreshAccessToken(entry, {
                tokenUrl: GOOGLE_TOKEN_URL,
                clientId: integration.metadata.clientId,
                clientSecret: integration.metadata.clientSecret
            });
            accessToken = result.accessToken;
            newRefreshToken = result.newRefreshToken;
        } catch (error) {
            if (error instanceof InvalidGrantError) {
                // Refresh token revoked/expired: drop locally, rethrow as NotAuthenticatedError for the re-auth path.
                await this.tokenStorage.delete(integrationId);
                throw new NotAuthenticatedError(integration.name);
            }
            if (error instanceof InvalidClientError) {
                // Wrong clientId/clientSecret: re-auth won't help. Rethrow as cross-platform sentinel; keep the refresh token.
                throw new OAuthClientMisconfiguredError(integration.name);
            }
            // Other errors: token probably still valid; don't delete.
            throw error;
        }

        // Persist rotated refresh token silently — firing onDidChangeTokens would restart the kernel mid-cell.
        if (newRefreshToken !== undefined && newRefreshToken !== entry.refreshToken) {
            await this.tokenStorage.save({ ...entry, refreshToken: newRefreshToken }, { silent: true });
        }

        const connectionJson = JSON.stringify({
            url: 'bigquery://?user_supplied_client=true',
            params: { access_token: accessToken, project: integration.metadata.project },
            param_style: 'pyformat'
        });

        // Mirror upstream `createPythonCodeForSqlBlock`'s metadata reads.
        const query = sqlBlock.content ?? '';
        const rawVariableName = sqlBlock.metadata?.deepnote_variable_name;
        const pythonVariableName =
            rawVariableName !== undefined ? sanitizePythonVariableName(rawVariableName) ?? 'input_1' : undefined;
        const returnVariableType: SqlCellVariableType = sqlBlock.metadata?.deepnote_return_variable_type ?? 'dataframe';
        const sqlCacheMode: SqlCacheMode = 'cache_disabled';

        const dataFrameConfig = createDataFrameConfig(sqlBlock);
        const executeSqlCall = executeSqlQueryWithConnectionJson({
            query,
            auditComment: '',
            connectionJson,
            pythonVariableName,
            sqlCacheMode,
            returnVariableType
        });

        return `${dataFrameConfig}\n\n${executeSqlCall}`;
    }
}
