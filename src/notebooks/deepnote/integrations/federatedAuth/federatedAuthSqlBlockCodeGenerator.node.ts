// VENDORED: this file vendors helpers that should land in
// `@deepnote/blocks` (see Step 1a of the plan at
// /home/ubuntu/.claude/plans/look-at-the-pr-curious-toast.md and the
// upstream-migration plan at Step 10). The local copy adapts upstream's
// `executeSqlQueryWithConnectionJson` by accepting a Python *expression*
// (`connectionJsonExpression`) instead of a literal JSON string, so the
// caller can reference a kernel-global variable that holds the freshly
// fetched access token. Delete this file once `@deepnote/blocks` exports
// the expression-form helper.

import type { DeepnoteBlock } from '@deepnote/blocks';
import { BigQueryAuthMethods } from '@deepnote/database-integrations';
import { inject, injectable, optional } from 'inversify';
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
    IFederatedAuthSqlBlockCodeGenerator,
    IFederatedAuthTokenStorage,
    NotAuthenticatedError,
    OAuthClientMisconfiguredError
} from '../types';

/**
 * Type signature of {@link fetchFreshAccessToken}. Used to declare the
 * optional test seam on {@link FederatedAuthSqlBlockCodeGenerator}'s
 * constructor.
 */
type FetchFreshAccessTokenFn = typeof fetchFreshAccessToken;

/**
 * Computes the kernel-global Python variable name used to hold the fresh
 * SqlAlchemy JSON for a federated BigQuery integration.
 *
 * Naming convention (double-underscore prefix + dunder-pattern suffix)
 * makes accidental shadowing unlikely; the per-integration scope means
 * multiple federated integrations in the same notebook don't trample each
 * other's tokens.
 *
 * The sanitization regex replaces any character outside `[A-Za-z0-9_]`
 * with `_` so the resulting identifier is always a valid Python name even
 * if the integration id contains characters like `-` (UUIDs frequently
 * do).
 */
export function federatedSqlVariableName(integrationId: string): string {
    const sanitized = integrationId.replace(/[^A-Za-z0-9_]/g, '_');
    return `__deepnote_federated_sql_connection__${sanitized}`;
}

/**
 * VENDORED helper. Mirrors the upstream-proposed
 * `pythonCode.executeSqlQueryWithConnectionJson` in
 * `@deepnote/blocks/python-snippets`, with one adjustment: the
 * `connectionJsonExpression` parameter is interpolated *without*
 * surrounding quotes so it is emitted as a Python expression (a bare
 * identifier referencing a kernel global) rather than as a Python
 * string literal.
 *
 * Output is structurally identical to upstream's
 * `createPythonCodeForSqlBlock` shape, except it invokes
 * `_dntk.execute_sql_with_connection_json(...)` and passes the
 * pre-populated JSON via the variable reference rather than via an
 * env-var name.
 *
 * TODO(deepnote-followups): remove when @deepnote/blocks exports the
 *   expression-form helper.
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
 * Generates the Python prelude + cell code for a federated-authentication
 * BigQuery SQL block. Returns `undefined` for any block that doesn't
 * qualify, so call sites can fall back to upstream
 * `@deepnote/blocks.createPythonCode`.
 *
 * The plan non-negotiable is that access tokens never appear in the cell's
 * main `code` argument to `kernel.requestExecute` (which uses
 * `store_history: true` — the input would land in the kernel's `In[]`
 * history). To honor that, this generator returns:
 *
 *  - `prelude`: a one-line assignment that puts the SqlAlchemy JSON
 *    (containing the fresh access token) into a kernel-global Python
 *    variable. The caller is expected to send this via a silent
 *    `requestExecute({ store_history: false })`.
 *  - `cellCode`: the Python source for the main cell execute, which only
 *    references the variable by name. Safe to put in `In[]` history.
 *
 * Plan non-negotiable: never cache the access token. Every call to
 * `generate()` triggers an unconditional refresh against the OAuth
 * provider's token endpoint.
 */
@injectable()
export class FederatedAuthSqlBlockCodeGenerator implements IFederatedAuthSqlBlockCodeGenerator {
    /**
     * Test seam: injectable replacement for {@link fetchFreshAccessToken}.
     * Production callers should let this default to the real
     * implementation. Tests pass a stub through the optional 3rd
     * constructor parameter to avoid hitting the real Google token
     * endpoint.
     */
    private readonly fetchFreshAccessToken: FetchFreshAccessTokenFn;

    constructor(
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage,
        @inject(IFederatedAuthTokenStorage) private readonly tokenStorage: IFederatedAuthTokenStorage,
        @optional() fetcher?: FetchFreshAccessTokenFn
    ) {
        this.fetchFreshAccessToken = fetcher ?? fetchFreshAccessToken;
    }

    public async generate(block: DeepnoteBlock): Promise<{ prelude: string; cellCode: string } | undefined> {
        if (block.type !== 'sql') {
            return undefined;
        }

        // `SqlBlock = Extract<DeepnoteBlock, { type: 'sql' }>` so the
        // discriminator check above narrows `block` to `SqlBlock` already.
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

        // From here on the integration is BigQuery + google-oauth, so it's
        // federated. Any "no usable token" branch must throw
        // NotAuthenticatedError so the UI can offer the Authenticate
        // command (Step 2 of the plan).
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
            // Metadata edited since the token was saved → the stored
            // refresh token is bound to a different OAuth client. Drop
            // it; `onDidChangeTokens` flips the pill in the UI.
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
                // The refresh token is no longer valid (revoked /
                // expired). Drop it locally; rethrow as
                // NotAuthenticatedError so the caller surfaces the
                // re-authenticate path.
                await this.tokenStorage.delete(integrationId);
                throw new NotAuthenticatedError(integration.name);
            }
            if (error instanceof InvalidClientError) {
                // The clientId/clientSecret on the integration are
                // wrong (Google returned `invalid_client` /
                // `unauthorized_client`). Re-authenticating won't help;
                // the user has to edit the credentials. Rethrow as a
                // cross-platform sentinel so the cell-execution path
                // can surface a distinct, more actionable error
                // message without importing the node-only error class.
                // The refresh token itself is still likely valid — do
                // NOT delete it.
                throw new OAuthClientMisconfiguredError(integration.name);
            }
            // Any other error means the token is probably still
            // valid — don't delete it. Rethrow so the caller can
            // surface the underlying error.
            throw error;
        }

        // Persist a rotated refresh token if Google issued one. Mirrors
        // production behavior described in plan Step 1a item 6.
        //
        // Save silently — a rotation event must NOT fire onDidChangeTokens.
        // Listeners (the kernel restart bridge, the webview's pill) treat
        // token changes as authentication state changes; firing here would
        // restart the kernel mid-cell because this save happens while
        // CellExecution is preparing the very SQL block that triggered the
        // rotation. The new refresh token still lands on disk; the next
        // SQL cell will read it via the same per-execution pre-execute
        // pathway.
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

        // Delegate to the vendored helper for the Python single-quoted
        // literal: it doubles backslashes, escapes single quotes, and
        // escapes newlines (and wraps the result in single quotes itself).
        // A user-supplied `integration.id` containing `\` or `\n` would
        // otherwise survive `JSON.stringify` and break Python's
        // `json.loads` on the kernel side.
        const prelude = `${variableName} = ${escapePythonString(connectionJson)}`;

        // Build the cell code by mirroring upstream
        // `createPythonCodeForSqlBlock`'s metadata reads.
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
