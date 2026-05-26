// VENDORED: helpers that should land in `@deepnote/blocks` (Step 10 of the upstream-migration plan).
// Adapts upstream's `executeSqlQueryWithConnectionJson` to accept a Python *expression* so the caller
// can reference a kernel-global holding the fresh access token. Delete once upstream exports it.
// TODO(deepnote-followups): remove when @deepnote/blocks exports the expression-form helper.

import type { DeepnoteBlock } from '@deepnote/blocks';
import { BigQueryAuthMethods } from '@deepnote/database-integrations';
import { inject, injectable } from 'inversify';
import { dedent } from 'ts-dedent';

import { IIntegrationStorage } from '../../../../platform/notebooks/deepnote/types';
import {
    fetchFreshAccessToken,
    InvalidClientError,
    InvalidGrantError,
    computeMetadataFingerprint
} from './federatedAuthTokenStorage.node';
import { GOOGLE_TOKEN_URL } from './googleOAuthProvider.node';
import {
    createDataFrameConfig,
    escapePythonString,
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

/** Per-integration kernel-global variable name holding the fresh SqlAlchemy JSON. Non-identifier chars are replaced with `_` to keep the name valid for UUID-style ids. */
export function federatedSqlVariableName(integrationId: string): string {
    const sanitized = integrationId.replace(/[^A-Za-z0-9_]/g, '_');
    return `__deepnote_federated_sql_connection__${sanitized}`;
}

/**
 * VENDORED: mirrors upstream `executeSqlQueryWithConnectionJson` but emits `connectionJsonExpression`
 * as a bare Python identifier (kernel-global ref) instead of a string literal.
 * TODO(deepnote-followups): remove when @deepnote/blocks exports the expression-form helper.
 */
function executeSqlQueryWithConnectionJson(params: {
    query: string;
    auditComment?: string;
    connectionJsonExpression: string;
    pythonVariableName?: string;
    sqlCacheMode: SqlCacheMode;
    returnVariableType: SqlCellVariableType;
}): string {
    const escapedQuery = escapePythonString(params.query);
    const escapedAuditComment = escapePythonString(params.auditComment ?? '');
    const executeSqlFunctionCall = dedent`_dntk.execute_sql_with_connection_json(
      ${escapedQuery},
      ${params.connectionJsonExpression},
      audit_sql_comment=${escapedAuditComment},
      sql_cache_mode='${params.sqlCacheMode}',
      return_variable_type='${params.returnVariableType}'
    )`;

    return params.pythonVariableName === undefined
        ? executeSqlFunctionCall
        : dedent`
            ${params.pythonVariableName} = ${executeSqlFunctionCall}
            ${params.pythonVariableName}
        `;
}

/**
 * Builds Python prelude + cell code for federated BigQuery SQL blocks. Returns `undefined` for unrelated
 * blocks so callers fall back to `@deepnote/blocks.createPythonCode`. Prelude (silent execute, no history)
 * sets the SqlAlchemy JSON into a kernel global; cellCode references it by name. Access tokens are never
 * cached: every `generate()` triggers a fresh refresh.
 */
@injectable()
export class FederatedAuthSqlBlockCodeGenerator implements IFederatedAuthSqlBlockCodeGenerator {
    constructor(
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage,
        @inject(IFederatedAuthTokenStorage) private readonly tokenStorage: IFederatedAuthTokenStorage
    ) {}

    /** Delegates to {@link fetchFreshAccessToken}; instance method so tests can `sinon.stub` without a ctor seam. */
    public fetchFreshAccessToken(
        entry: FederatedAuthTokenEntry,
        oauthConfig: { tokenUrl: string; clientId: string; clientSecret: string }
    ): Promise<{ accessToken: string; newRefreshToken?: string }> {
        return fetchFreshAccessToken(entry, oauthConfig);
    }

    public async generate(block: DeepnoteBlock): Promise<{ prelude: string; cellCode: string } | undefined> {
        if (block.type !== 'sql') {
            return undefined;
        }

        // Discriminator above narrows `block` to `SqlBlock`.
        const sqlBlock = block;
        const integrationId = sqlBlock.metadata?.sql_integration_id;
        if (!integrationId) {
            return undefined;
        }

        const integration = await this.integrationStorage.getIntegrationConfig(integrationId);
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
            integration_id: integration.id,
            url: 'bigquery://?user_supplied_client=true',
            params: { access_token: accessToken, project: integration.metadata.project },
            param_style: 'pyformat'
        });

        const variableName = federatedSqlVariableName(integration.id);

        // `escapePythonString` handles `\`, `'`, `\n` so a hostile `integration.id` can't break Python's `json.loads`.
        const prelude = `${variableName} = ${escapePythonString(connectionJson)}`;

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
            connectionJsonExpression: variableName,
            pythonVariableName,
            sqlCacheMode,
            returnVariableType
        });

        const cellCode = `${dataFrameConfig}\n\n${executeSqlCall}`;

        return { prelude, cellCode };
    }
}
