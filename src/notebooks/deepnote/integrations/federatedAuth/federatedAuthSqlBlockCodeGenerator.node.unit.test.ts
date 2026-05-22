import type { DeepnoteBlock } from '@deepnote/blocks';
import { assert } from 'chai';
import sinon from 'sinon';

import { ConfigurableDatabaseIntegrationConfig } from '../../../../platform/notebooks/deepnote/integrationTypes';
import { IIntegrationStorage } from '../../../../platform/notebooks/deepnote/types';
import {
    FederatedAuthTokenEntry,
    IFederatedAuthTokenStorage,
    NotAuthenticatedError,
    OAuthClientMisconfiguredError
} from '../types';
import {
    FederatedAuthSqlBlockCodeGenerator,
    federatedSqlVariableName
} from './federatedAuthSqlBlockCodeGenerator.node';
import { InvalidClientError, InvalidGrantError, computeMetadataFingerprint } from './federatedAuthTokenStorage.node';

type FetcherFn = (
    entry: FederatedAuthTokenEntry,
    oauthConfig: { tokenUrl: string; clientId: string; clientSecret: string }
) => Promise<{ accessToken: string; newRefreshToken?: string }>;

suite('FederatedAuthSqlBlockCodeGenerator', () => {
    const INTEGRATION_ID = 'bq-integration-1';
    const PROJECT = 'my-gcp-project';
    const CLIENT_ID = 'client-id-abc';
    const CLIENT_SECRET = 'client-secret-xyz';
    const REFRESH_TOKEN = 'refresh-token-abc';
    const ACCESS_TOKEN = 'access-token-secret-do-not-log';
    const VALID_FINGERPRINT = computeMetadataFingerprint({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        project: PROJECT
    });

    let integrationStore: Map<string, ConfigurableDatabaseIntegrationConfig>;
    let tokenStore: Map<string, FederatedAuthTokenEntry>;
    let deleteSpy: sinon.SinonSpy;
    let saveSpy: sinon.SinonSpy;
    let fetcher: sinon.SinonStub<Parameters<FetcherFn>, ReturnType<FetcherFn>>;
    let integrationStorage: IIntegrationStorage;
    let tokenStorage: IFederatedAuthTokenStorage;
    let generator: FederatedAuthSqlBlockCodeGenerator;

    setup(() => {
        integrationStore = new Map();
        tokenStore = new Map();

        // Minimal IIntegrationStorage stub: only the method generate() calls.
        integrationStorage = {
            getIntegrationConfig: async (id: string) => integrationStore.get(id)
        } as unknown as IIntegrationStorage;

        deleteSpy = sinon.spy(async (id: string) => {
            tokenStore.delete(id);
        });
        saveSpy = sinon.spy(async (entry: FederatedAuthTokenEntry) => {
            tokenStore.set(entry.integrationId, entry);
        });

        tokenStorage = {
            get: async (id: string) => tokenStore.get(id),
            delete: deleteSpy as unknown as IFederatedAuthTokenStorage['delete'],
            save: saveSpy as unknown as IFederatedAuthTokenStorage['save']
        } as unknown as IFederatedAuthTokenStorage;

        fetcher = sinon.stub<Parameters<FetcherFn>, ReturnType<FetcherFn>>();
        fetcher.resolves({ accessToken: ACCESS_TOKEN });

        generator = new FederatedAuthSqlBlockCodeGenerator(
            integrationStorage,
            tokenStorage,
            fetcher as unknown as FetcherFn
        );
    });

    function setupValidFederatedIntegration() {
        integrationStore.set(INTEGRATION_ID, {
            id: INTEGRATION_ID,
            name: 'My BigQuery',
            type: 'big-query',
            metadata: {
                authMethod: 'google-oauth',
                project: PROJECT,
                clientId: CLIENT_ID,
                clientSecret: CLIENT_SECRET
            }
        } as ConfigurableDatabaseIntegrationConfig);

        tokenStore.set(INTEGRATION_ID, {
            integrationId: INTEGRATION_ID,
            refreshToken: REFRESH_TOKEN,
            metadataFingerprint: VALID_FINGERPRINT
        });
    }

    function sqlBlock(overrides?: { sql_integration_id?: string; deepnote_variable_name?: string }): DeepnoteBlock {
        return {
            id: 'block-1',
            type: 'sql',
            blockGroup: 'group-1',
            sortingKey: '0',
            content: 'SELECT 1 AS one',
            metadata: {
                sql_integration_id: overrides?.sql_integration_id ?? INTEGRATION_ID,
                deepnote_variable_name: overrides?.deepnote_variable_name
            }
        } as unknown as DeepnoteBlock;
    }

    function codeBlock(): DeepnoteBlock {
        return {
            id: 'block-1',
            type: 'code',
            blockGroup: 'group-1',
            sortingKey: '0',
            content: 'print("hi")',
            metadata: {}
        } as unknown as DeepnoteBlock;
    }

    test('returns undefined for a non-SQL block', async () => {
        setupValidFederatedIntegration();
        const result = await generator.generate(codeBlock());
        assert.strictEqual(result, undefined);
        sinon.assert.notCalled(fetcher);
    });

    test('returns undefined when SQL block has no sql_integration_id', async () => {
        setupValidFederatedIntegration();
        const block = {
            id: 'block-1',
            type: 'sql',
            blockGroup: 'group-1',
            sortingKey: '0',
            content: 'SELECT 1',
            metadata: {}
        } as unknown as DeepnoteBlock;
        const result = await generator.generate(block);
        assert.strictEqual(result, undefined);
        sinon.assert.notCalled(fetcher);
    });

    test('returns undefined when integration is not BigQuery (e.g. pgsql)', async () => {
        integrationStore.set(INTEGRATION_ID, {
            id: INTEGRATION_ID,
            name: 'My Postgres',
            type: 'pgsql',
            metadata: {
                host: 'db.example.com',
                user: 'me',
                database: 'mydb'
            }
        } as unknown as ConfigurableDatabaseIntegrationConfig);

        const result = await generator.generate(sqlBlock());
        assert.strictEqual(result, undefined);
        sinon.assert.notCalled(fetcher);
    });

    test('returns undefined when BigQuery integration uses service-account auth', async () => {
        integrationStore.set(INTEGRATION_ID, {
            id: INTEGRATION_ID,
            name: 'My BigQuery (SA)',
            type: 'big-query',
            metadata: {
                authMethod: 'service-account',
                service_account: '{"type": "service_account"}'
            }
        } as unknown as ConfigurableDatabaseIntegrationConfig);

        const result = await generator.generate(sqlBlock());
        assert.strictEqual(result, undefined);
        sinon.assert.notCalled(fetcher);
    });

    test('returns undefined when integration is not found (e.g. id typo)', async () => {
        const result = await generator.generate(sqlBlock({ sql_integration_id: 'unknown-id' }));
        assert.strictEqual(result, undefined);
        sinon.assert.notCalled(fetcher);
    });

    test('throws NotAuthenticatedError when federated integration has no stored token', async () => {
        integrationStore.set(INTEGRATION_ID, {
            id: INTEGRATION_ID,
            name: 'My BigQuery',
            type: 'big-query',
            metadata: {
                authMethod: 'google-oauth',
                project: PROJECT,
                clientId: CLIENT_ID,
                clientSecret: CLIENT_SECRET
            }
        } as ConfigurableDatabaseIntegrationConfig);

        try {
            await generator.generate(sqlBlock());
            assert.fail('Expected NotAuthenticatedError');
        } catch (err) {
            assert.instanceOf(err, NotAuthenticatedError);
            assert.strictEqual((err as NotAuthenticatedError).integrationName, 'My BigQuery');
        }
        sinon.assert.notCalled(fetcher);
    });

    test('throws NotAuthenticatedError and deletes the token when the metadata fingerprint is stale', async () => {
        setupValidFederatedIntegration();
        // Overwrite with a token whose fingerprint won't match the integration metadata.
        tokenStore.set(INTEGRATION_ID, {
            integrationId: INTEGRATION_ID,
            refreshToken: REFRESH_TOKEN,
            metadataFingerprint: 'stale-fingerprint'
        });

        try {
            await generator.generate(sqlBlock());
            assert.fail('Expected NotAuthenticatedError');
        } catch (err) {
            assert.instanceOf(err, NotAuthenticatedError);
        }
        sinon.assert.calledOnceWithExactly(deleteSpy, INTEGRATION_ID);
        sinon.assert.notCalled(fetcher);
    });

    test('returns { prelude, cellCode } for a valid federated SQL block', async () => {
        setupValidFederatedIntegration();

        const result = await generator.generate(sqlBlock());
        if (!result) {
            throw new Error('expected a non-undefined result');
        }

        const expectedVariableName = federatedSqlVariableName(INTEGRATION_ID);
        const escapedVariableName = expectedVariableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // prelude is exactly `<variable> = '<safe_json>'`.
        const preludeRegex = new RegExp(`^${escapedVariableName} = '([^]*)'$`);
        const match = preludeRegex.exec(result.prelude);
        if (!match) {
            throw new Error(`prelude did not match expected shape: ${result.prelude}`);
        }
        const safeJson = match[1];
        const parsed = JSON.parse(safeJson.replace(/\\'/g, "'")) as Record<string, unknown>;
        assert.deepStrictEqual(parsed, {
            integration_id: INTEGRATION_ID,
            url: 'bigquery://?user_supplied_client=true',
            params: { access_token: ACCESS_TOKEN, project: PROJECT },
            param_style: 'pyformat'
        });

        // cellCode invokes the connection-json function and references the variable by name (no quotes).
        assert.include(result.cellCode, '_dntk.execute_sql_with_connection_json(');
        // The variable is referenced unquoted between the commas.
        const inlineRef = new RegExp(`,\\s*${escapedVariableName}\\s*,`);
        assert.match(result.cellCode, inlineRef, 'cellCode should reference the variable as a bare identifier');

        // Critical M3 invariant: the access token MUST NOT appear in cellCode.
        assert.isFalse(
            result.cellCode.includes(ACCESS_TOKEN),
            `cellCode unexpectedly contains the access token: ${result.cellCode}`
        );
    });

    test('prelude round-trips through Python+json.loads when integration id contains backslash, newline, and single quote', async () => {
        // Catches: regressing to a single-char `\\'` escape would leave `\\`/`\n` undecoded and break `json.loads` at the kernel.
        const hostileIntegrationId = "bq-with-\\-and-\n-and-'-id";
        integrationStore.set(hostileIntegrationId, {
            id: hostileIntegrationId,
            name: 'My BigQuery',
            type: 'big-query',
            metadata: {
                authMethod: 'google-oauth',
                project: PROJECT,
                clientId: CLIENT_ID,
                clientSecret: CLIENT_SECRET
            }
        } as ConfigurableDatabaseIntegrationConfig);
        tokenStore.set(hostileIntegrationId, {
            integrationId: hostileIntegrationId,
            refreshToken: REFRESH_TOKEN,
            metadataFingerprint: VALID_FINGERPRINT
        });

        const result = await generator.generate(sqlBlock({ sql_integration_id: hostileIntegrationId }));
        if (!result) {
            throw new Error('expected a non-undefined result');
        }

        // Strip `<variable> = ` prefix and parse what Python would.
        const expectedVariableName = federatedSqlVariableName(hostileIntegrationId);
        const assignmentPrefix = `${expectedVariableName} = `;
        assert.isTrue(
            result.prelude.startsWith(assignmentPrefix),
            `prelude did not begin with the expected assignment prefix: ${result.prelude}`
        );
        const literal = result.prelude.slice(assignmentPrefix.length);

        // Inverse of \\, \', \n — parses what Python would.
        function parsePythonSingleQuoted(escaped: string): string {
            assert.isTrue(escaped.startsWith("'") && escaped.endsWith("'"), 'must be wrapped in single quotes');
            const body = escaped.slice(1, -1);
            let out = '';
            for (let i = 0; i < body.length; i++) {
                if (body[i] === '\\' && i + 1 < body.length) {
                    const next = body[i + 1];
                    if (next === '\\') {
                        out += '\\';
                    } else if (next === "'") {
                        out += "'";
                    } else if (next === 'n') {
                        out += '\n';
                    } else {
                        out += '\\' + next;
                    }
                    i++;
                } else {
                    out += body[i];
                }
            }
            return out;
        }
        const decoded = parsePythonSingleQuoted(literal);
        const parsed = JSON.parse(decoded) as Record<string, unknown>;
        assert.deepStrictEqual(parsed, {
            integration_id: hostileIntegrationId,
            url: 'bigquery://?user_supplied_client=true',
            params: { access_token: ACCESS_TOKEN, project: PROJECT },
            param_style: 'pyformat'
        });
    });

    test('two sequential calls trigger two fetches (no caching)', async () => {
        setupValidFederatedIntegration();
        fetcher.onFirstCall().resolves({ accessToken: 'token-1' });
        fetcher.onSecondCall().resolves({ accessToken: 'token-2' });

        const first = await generator.generate(sqlBlock());
        const second = await generator.generate(sqlBlock());

        sinon.assert.calledTwice(fetcher);
        assert.notStrictEqual(first?.prelude, second?.prelude);
        assert.include(first?.prelude ?? '', 'token-1');
        assert.include(second?.prelude ?? '', 'token-2');
    });

    test('InvalidGrantError from refresh: throws NotAuthenticatedError and deletes the token', async () => {
        setupValidFederatedIntegration();
        fetcher.rejects(new InvalidGrantError());

        try {
            await generator.generate(sqlBlock());
            assert.fail('Expected NotAuthenticatedError');
        } catch (err) {
            assert.instanceOf(err, NotAuthenticatedError);
        }
        sinon.assert.calledOnceWithExactly(deleteSpy, INTEGRATION_ID);
    });

    test('InvalidClientError from refresh: throws OAuthClientMisconfiguredError and does NOT delete the token', async () => {
        // Generator wraps node-only `InvalidClientError` into cross-platform `OAuthClientMisconfiguredError` so web-bound callers can `instanceof`-check.
        setupValidFederatedIntegration();
        fetcher.rejects(new InvalidClientError());

        try {
            await generator.generate(sqlBlock());
            assert.fail('Expected OAuthClientMisconfiguredError');
        } catch (err) {
            assert.instanceOf(err, OAuthClientMisconfiguredError);
            assert.notInstanceOf(err, NotAuthenticatedError);
            assert.notInstanceOf(err, InvalidClientError);
            assert.equal((err as OAuthClientMisconfiguredError).integrationName, 'My BigQuery');
        }
        sinon.assert.notCalled(deleteSpy);
    });

    test('persists a rotated refresh token before resolving', async () => {
        setupValidFederatedIntegration();
        fetcher.resolves({ accessToken: ACCESS_TOKEN, newRefreshToken: 'new-refresh-token' });

        const result = await generator.generate(sqlBlock());
        assert.ok(result);

        sinon.assert.calledOnce(saveSpy);
        const savedEntry = saveSpy.firstCall.args[0] as FederatedAuthTokenEntry;
        assert.deepStrictEqual(savedEntry, {
            integrationId: INTEGRATION_ID,
            refreshToken: 'new-refresh-token',
            metadataFingerprint: VALID_FINGERPRINT
        });
    });

    test('persists a rotated refresh token with { silent: true } so listeners do not restart the in-flight kernel', async () => {
        // Catches: a rotation event firing `onDidChangeTokens` would queue a `kernel.restart()` while the prelude+main execute are running.
        setupValidFederatedIntegration();
        fetcher.resolves({ accessToken: ACCESS_TOKEN, newRefreshToken: 'new-refresh-token' });

        await generator.generate(sqlBlock());

        sinon.assert.calledOnce(saveSpy);
        const options = saveSpy.firstCall.args[1] as { silent?: boolean } | undefined;
        assert.strictEqual(options?.silent, true, 'rotation save must pass { silent: true }');
    });

    test('does NOT call save when the returned refresh token is identical to the stored one', async () => {
        setupValidFederatedIntegration();
        fetcher.resolves({ accessToken: ACCESS_TOKEN, newRefreshToken: REFRESH_TOKEN });

        await generator.generate(sqlBlock());

        sinon.assert.notCalled(saveSpy);
    });

    test('does NOT call save when the response carries no refresh token at all', async () => {
        setupValidFederatedIntegration();
        fetcher.resolves({ accessToken: ACCESS_TOKEN });

        await generator.generate(sqlBlock());

        sinon.assert.notCalled(saveSpy);
    });

    test('cellCode honors deepnote_variable_name by emitting an assignment', async () => {
        setupValidFederatedIntegration();
        const result = await generator.generate(sqlBlock({ deepnote_variable_name: 'my_df' }));
        if (!result) {
            throw new Error('expected a non-undefined result');
        }
        // Match upstream's shape: `my_df = _dntk.execute_sql_with_connection_json(...)` followed by `my_df` on the next line.
        assert.include(result.cellCode, 'my_df = _dntk.execute_sql_with_connection_json(');
    });

    suite('federatedSqlVariableName', () => {
        test('replaces non-identifier characters with underscores', () => {
            assert.strictEqual(
                federatedSqlVariableName('abc-123-def'),
                '__deepnote_federated_sql_connection__abc_123_def'
            );
        });

        test('leaves already-valid identifier characters alone', () => {
            assert.strictEqual(federatedSqlVariableName('abc_123'), '__deepnote_federated_sql_connection__abc_123');
        });

        test('replaces a UUID-style id with underscores', () => {
            assert.strictEqual(
                federatedSqlVariableName('11111111-2222-3333-4444-555555555555'),
                '__deepnote_federated_sql_connection__11111111_2222_3333_4444_555555555555'
            );
        });
    });
});
