import { assert } from 'chai';
import sinon from 'sinon';
import { EventEmitter } from 'vscode';

import {
    FederatedAuthTokenEntry,
    IFederatedAuthTokenStorage,
    NotAuthenticatedError,
    OAuthClientMisconfiguredError
} from '../types';
import { FederatedAuthSqlBlockCodeGenerator } from './federatedAuthSqlBlockCodeGenerator.node';
import { IIntegrationStorage } from '../../../../platform/notebooks/deepnote/types';
import { InvalidClientError, InvalidGrantError, computeMetadataFingerprint } from './federatedAuthTokenStorage.node';
import {
    FED_AUTH_FIXTURE,
    buildCodeBlock,
    buildGoogleOauthIntegration,
    buildPostgresIntegration,
    buildServiceAccountIntegration,
    buildSqlBlock,
    buildTokenEntry,
    parsePythonSingleQuoted
} from './federatedAuthTestHelpers';
import type { ConfigurableDatabaseIntegrationConfig } from '../../../../platform/notebooks/deepnote/integrationTypes';

type FetcherFn = (
    entry: FederatedAuthTokenEntry,
    oauthConfig: { tokenUrl: string; clientId: string; clientSecret: string }
) => Promise<{ accessToken: string; newRefreshToken?: string }>;

suite('FederatedAuthSqlBlockCodeGenerator', () => {
    const { INTEGRATION_ID, PROJECT, CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN, ACCESS_TOKEN } = FED_AUTH_FIXTURE;
    const VALID_FINGERPRINT = computeMetadataFingerprint({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        project: PROJECT
    });

    let integrations: Map<string, ConfigurableDatabaseIntegrationConfig>;
    let tokens: Map<string, FederatedAuthTokenEntry>;
    let onDidChangeTokens: EventEmitter<string>;
    let onDidChangeIntegrations: EventEmitter<void>;
    let saveSpy: sinon.SinonSpy<[FederatedAuthTokenEntry, { silent?: boolean }?], Promise<void>>;
    let deleteSpy: sinon.SinonSpy<[string], Promise<void>>;
    let integrationStorage: IIntegrationStorage;
    let tokenStorage: IFederatedAuthTokenStorage;
    let fetcher: sinon.SinonStub<Parameters<FetcherFn>, ReturnType<FetcherFn>>;
    let generator: FederatedAuthSqlBlockCodeGenerator;

    setup(() => {
        integrations = new Map();
        tokens = new Map();
        onDidChangeTokens = new EventEmitter<string>();
        onDidChangeIntegrations = new EventEmitter<void>();
        saveSpy = sinon.spy(async (entry: FederatedAuthTokenEntry, _options?: { silent?: boolean }) => {
            tokens.set(entry.integrationId, entry);
        });
        deleteSpy = sinon.spy(async (id: string) => {
            tokens.delete(id);
        });

        integrationStorage = {
            onDidChangeIntegrations: onDidChangeIntegrations.event,
            dispose: () => onDidChangeIntegrations.dispose(),
            async clear() {
                integrations.clear();
            },
            async delete(id) {
                integrations.delete(id);
            },
            async exists(id) {
                return integrations.has(id);
            },
            async getAll() {
                return Array.from(integrations.values());
            },
            async getIntegrationConfig(id) {
                return integrations.get(id);
            },
            async getProjectIntegrationConfig() {
                return undefined;
            },
            async save(config) {
                integrations.set(config.id, config);
            }
        };

        tokenStorage = {
            onDidChangeTokens: onDidChangeTokens.event,
            computeMetadataFingerprint: (m) => computeMetadataFingerprint(m),
            delete: deleteSpy,
            get: async (id) => tokens.get(id),
            has: async (id) => tokens.has(id),
            listIntegrationIds: async () => Array.from(tokens.keys()),
            save: saveSpy
        };

        generator = new FederatedAuthSqlBlockCodeGenerator(integrationStorage, tokenStorage);

        fetcher = sinon.stub(generator, 'fetchFreshAccessToken');
        fetcher.resolves({ accessToken: ACCESS_TOKEN });
    });

    teardown(() => {
        sinon.restore();
        onDidChangeTokens.dispose();
        onDidChangeIntegrations.dispose();
    });

    function setupValidFederatedIntegration() {
        integrations.set(INTEGRATION_ID, buildGoogleOauthIntegration());
        tokens.set(
            INTEGRATION_ID,
            buildTokenEntry({ refreshToken: REFRESH_TOKEN, metadataFingerprint: VALID_FINGERPRINT })
        );
    }

    /** Pull the connection-JSON literal (second positional arg) out of `_dntk.execute_sql_with_connection_json(...)`. */
    function extractConnectionJsonLiteral(code: string): string {
        const match = /_dntk\.execute_sql_with_connection_json\(\s*'(?:\\.|[^'\\])*',\s*('(?:\\.|[^'\\])*')/.exec(code);
        if (!match) {
            throw new Error(`could not locate connection JSON literal in code: ${code}`);
        }
        return match[1];
    }

    (
        [
            ['a non-SQL block', () => buildGoogleOauthIntegration(), () => buildCodeBlock()],
            [
                'SQL block with no sql_integration_id',
                () => buildGoogleOauthIntegration(),
                () => buildSqlBlock({ metadata: {} })
            ],
            [
                'SQL block with id typo (integration not found)',
                () => undefined,
                () => buildSqlBlock({ sql_integration_id: 'unknown-id' })
            ],
            [
                'integration that is not BigQuery',
                () => buildPostgresIntegration({ id: INTEGRATION_ID }),
                () => buildSqlBlock()
            ],
            [
                'BigQuery integration using service-account auth',
                () => buildServiceAccountIntegration(),
                () => buildSqlBlock()
            ]
        ] as const
    ).forEach(([label, buildIntegration, buildBlock]) => {
        test(`returns undefined for ${label}`, async () => {
            const integration = buildIntegration();
            if (integration) {
                integrations.set(integration.id, integration);
            }
            const result = await generator.generate(buildBlock());
            assert.strictEqual(result, undefined);
            sinon.assert.notCalled(fetcher);
        });
    });

    test('throws NotAuthenticatedError when federated integration has no stored token', async () => {
        integrations.set(INTEGRATION_ID, buildGoogleOauthIntegration());

        try {
            await generator.generate(buildSqlBlock());
            assert.fail('Expected NotAuthenticatedError');
        } catch (err) {
            assert(err instanceof NotAuthenticatedError);
            assert.strictEqual(err.integrationName, 'My BigQuery');
        }
        sinon.assert.notCalled(fetcher);
    });

    test('throws NotAuthenticatedError and deletes the token when the metadata fingerprint is stale', async () => {
        setupValidFederatedIntegration();
        tokens.set(
            INTEGRATION_ID,
            buildTokenEntry({ refreshToken: REFRESH_TOKEN, metadataFingerprint: 'stale-fingerprint' })
        );

        try {
            await generator.generate(buildSqlBlock());
            assert.fail('Expected NotAuthenticatedError');
        } catch (err) {
            assert.instanceOf(err, NotAuthenticatedError);
        }
        sinon.assert.calledOnceWithExactly(deleteSpy, INTEGRATION_ID);
        sinon.assert.notCalled(fetcher);
    });

    test('returns a single Python string embedding the access token in the execute call for a valid federated SQL block', async () => {
        // Mirrors deepnote-internal: one `_dntk.execute_sql_with_connection_json(...)` call with the connection JSON as a literal containing the fresh access token. Token is expected in the single execute payload, same as cloud.
        setupValidFederatedIntegration();

        const result = await generator.generate(buildSqlBlock());
        if (typeof result !== 'string') {
            throw new Error(`expected a string result, got ${typeof result}`);
        }

        assert.include(result, '_dntk.execute_sql_with_connection_json(');

        const literal = extractConnectionJsonLiteral(result);
        const parsed = JSON.parse(parsePythonSingleQuoted(literal));
        assert.deepStrictEqual(parsed, {
            url: 'bigquery://?user_supplied_client=true',
            params: { access_token: ACCESS_TOKEN, project: PROJECT },
            param_style: 'pyformat'
        });
    });

    test('connection JSON literal round-trips through Python+json.loads when integration name contains backslash, newline, and single quote', async () => {
        // Catches: regressing `escapePythonString` (e.g. swapping in a single-char `\\'` escape) would leave `\\`/`\n` undecoded and break `json.loads` at the kernel. The literal lives inside the execute call now (no separate prelude assignment).
        const hostileProject = "gcp-with-\\-and-\n-and-'-project";
        integrations.set(
            INTEGRATION_ID,
            buildGoogleOauthIntegration({
                metadata: {
                    authMethod: 'google-oauth',
                    project: hostileProject,
                    clientId: CLIENT_ID,
                    clientSecret: CLIENT_SECRET
                }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any)
        );
        const hostileFingerprint = computeMetadataFingerprint({
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            project: hostileProject
        });
        tokens.set(
            INTEGRATION_ID,
            buildTokenEntry({ refreshToken: REFRESH_TOKEN, metadataFingerprint: hostileFingerprint })
        );

        const result = await generator.generate(buildSqlBlock());
        if (typeof result !== 'string') {
            throw new Error(`expected a string result, got ${typeof result}`);
        }

        const literal = extractConnectionJsonLiteral(result);
        const decoded = parsePythonSingleQuoted(literal);
        const parsed = JSON.parse(decoded);
        assert.deepStrictEqual(parsed, {
            url: 'bigquery://?user_supplied_client=true',
            params: { access_token: ACCESS_TOKEN, project: hostileProject },
            param_style: 'pyformat'
        });
    });

    test('two sequential calls trigger two fetches (no caching)', async () => {
        setupValidFederatedIntegration();
        fetcher.onFirstCall().resolves({ accessToken: 'token-1' });
        fetcher.onSecondCall().resolves({ accessToken: 'token-2' });

        const first = await generator.generate(buildSqlBlock());
        const second = await generator.generate(buildSqlBlock());

        sinon.assert.calledTwice(fetcher);
        assert.notStrictEqual(first, second);
        assert.include(first ?? '', 'token-1');
        assert.include(second ?? '', 'token-2');
    });

    test('InvalidGrantError from refresh: throws NotAuthenticatedError and deletes the token', async () => {
        setupValidFederatedIntegration();
        fetcher.rejects(new InvalidGrantError());

        try {
            await generator.generate(buildSqlBlock());
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
            await generator.generate(buildSqlBlock());
            assert.fail('Expected OAuthClientMisconfiguredError');
        } catch (err) {
            assert(err instanceof OAuthClientMisconfiguredError);
            assert.notInstanceOf(err, NotAuthenticatedError);
            assert.notInstanceOf(err, InvalidClientError);
            assert.equal(err.integrationName, 'My BigQuery');
        }
        sinon.assert.notCalled(deleteSpy);
    });

    test('persists a rotated refresh token with { silent: true } so listeners do not restart the in-flight kernel', async () => {
        // Catches: a rotation event firing `onDidChangeTokens` would queue a `kernel.restart()` while the execute is running.
        setupValidFederatedIntegration();
        fetcher.resolves({ accessToken: ACCESS_TOKEN, newRefreshToken: 'new-refresh-token' });

        await generator.generate(buildSqlBlock());

        sinon.assert.calledOnce(saveSpy);
        const [savedEntry, options] = saveSpy.firstCall.args;
        assert.deepStrictEqual(savedEntry, {
            integrationId: INTEGRATION_ID,
            refreshToken: 'new-refresh-token',
            metadataFingerprint: VALID_FINGERPRINT
        });
        assert.strictEqual(options?.silent, true, 'rotation save must pass { silent: true }');
    });

    test('does NOT call save when the returned refresh token is identical to the stored one', async () => {
        setupValidFederatedIntegration();
        fetcher.resolves({ accessToken: ACCESS_TOKEN, newRefreshToken: REFRESH_TOKEN });

        await generator.generate(buildSqlBlock());

        sinon.assert.notCalled(saveSpy);
    });

    test('honors deepnote_variable_name by emitting an assignment in the generated code', async () => {
        setupValidFederatedIntegration();
        const result = await generator.generate(buildSqlBlock({ deepnote_variable_name: 'my_df' }));
        if (typeof result !== 'string') {
            throw new Error(`expected a string result, got ${typeof result}`);
        }
        // Match upstream's shape: `my_df = _dntk.execute_sql_with_connection_json(...)` followed by `my_df` on the next line.
        assert.include(result, 'my_df = _dntk.execute_sql_with_connection_json(');
    });
});
