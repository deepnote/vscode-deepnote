import { assert } from 'chai';
import sinon from 'sinon';
import { EventEmitter, Uri } from 'vscode';
import type { DatabaseIntegrationConfig } from '@deepnote/database-integrations';

import {
    FederatedAuthTokenEntry,
    IFederatedAuthTokenStorage,
    NotAuthenticatedError,
    OAuthClientMisconfiguredError
} from '../types';
import { FederatedAuthSqlBlockCodeGenerator } from './federatedAuthSqlBlockCodeGenerator.node';
import { ISqlIntegrationEnvVarsProvider } from '../../../../platform/notebooks/deepnote/types';
import { Resource } from '../../../../platform/common/types';
import { EnvironmentVariables } from '../../../../platform/common/variables/types';
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

type FetcherFn = (
    entry: FederatedAuthTokenEntry,
    oauthConfig: { tokenUrl: string; clientId: string; clientSecret: string }
) => Promise<{ accessToken: string; newRefreshToken?: string }>;

/** The OAuth-client metadata the fingerprint is computed over; derived from the library so it cannot drift. */
type GoogleOauthMetadata = Extract<
    Extract<DatabaseIntegrationConfig, { type: 'big-query' }>['metadata'],
    { authMethod: 'google-oauth' }
>;

suite('FederatedAuthSqlBlockCodeGenerator', () => {
    const { INTEGRATION_ID, PROJECT, CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN, ACCESS_TOKEN } = FED_AUTH_FIXTURE;
    const VALID_FINGERPRINT = computeMetadataFingerprint({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        project: PROJECT
    });
    const NOTEBOOK_URI = Uri.file('/workspace/project.deepnote');
    const OTHER_NOTEBOOK_URI = Uri.file('/workspace/other/project.deepnote');

    /** Merged (`.deepnote.env.yaml` over SecretStorage) configs keyed by the notebook they resolve for. */
    let mergedConfigs: Map<string, DatabaseIntegrationConfig[]>;
    let tokens: Map<string, FederatedAuthTokenEntry>;
    let onDidChangeTokens: EventEmitter<string>;
    let onDidChangeEnvironmentVariables: EventEmitter<Resource>;
    let saveSpy: sinon.SinonSpy<[FederatedAuthTokenEntry, { silent?: boolean }?], Promise<void>>;
    let deleteSpy: sinon.SinonSpy<[string], Promise<void>>;
    let getMergedIntegrationConfigsSpy: sinon.SinonSpy<[Resource], Promise<DatabaseIntegrationConfig[]>>;
    let sqlIntegrationEnvVars: ISqlIntegrationEnvVarsProvider;
    let tokenStorage: IFederatedAuthTokenStorage;
    let fetcher: sinon.SinonStub<Parameters<FetcherFn>, ReturnType<FetcherFn>>;
    let generator: FederatedAuthSqlBlockCodeGenerator;

    setup(() => {
        mergedConfigs = new Map();
        tokens = new Map();
        onDidChangeTokens = new EventEmitter<string>();
        onDidChangeEnvironmentVariables = new EventEmitter<Resource>();
        saveSpy = sinon.spy(async (entry: FederatedAuthTokenEntry, _options?: { silent?: boolean }) => {
            tokens.set(entry.integrationId, entry);
        });
        deleteSpy = sinon.spy(async (id: string) => {
            tokens.delete(id);
        });
        getMergedIntegrationConfigsSpy = sinon.spy(async (resource: Resource) =>
            resource ? mergedConfigs.get(resource.toString()) ?? [] : []
        );

        // Declared as a plain object (not a typed literal) so the extra members the provider grows for other
        // consumers stay assignable here; the generator only ever calls `getMergedIntegrationConfigs`.
        const envVarsProvider = {
            onDidChangeEnvironmentVariables: onDidChangeEnvironmentVariables.event,
            async getEnvironmentVariables(): Promise<EnvironmentVariables> {
                return {};
            },
            async getFederatedAuthCandidates(): Promise<ReadonlySet<string>> {
                return new Set<string>();
            },
            async getFileConfiguredIntegrationIds(): Promise<ReadonlySet<string>> {
                return new Set<string>();
            },
            getMergedIntegrationConfigs: getMergedIntegrationConfigsSpy
        };
        sqlIntegrationEnvVars = envVarsProvider;

        tokenStorage = {
            onDidChangeTokens: onDidChangeTokens.event,
            computeMetadataFingerprint: (m) => computeMetadataFingerprint(m),
            delete: deleteSpy,
            get: async (id) => tokens.get(id),
            has: async (id) => tokens.has(id),
            save: saveSpy
        };

        generator = new FederatedAuthSqlBlockCodeGenerator(sqlIntegrationEnvVars, tokenStorage);

        fetcher = sinon.stub(generator, 'fetchFreshAccessToken');
        fetcher.resolves({ accessToken: ACCESS_TOKEN });
    });

    teardown(() => {
        sinon.restore();
        onDidChangeTokens.dispose();
        onDidChangeEnvironmentVariables.dispose();
    });

    /** Publishes `configs` as what `.deepnote.env.yaml` + SecretStorage merge to for `uri`. */
    function setMergedConfigs(uri: Uri, ...configs: DatabaseIntegrationConfig[]) {
        mergedConfigs.set(uri.toString(), configs);
    }

    function setupValidFederatedIntegration() {
        setMergedConfigs(NOTEBOOK_URI, buildGoogleOauthIntegration());
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
                setMergedConfigs(NOTEBOOK_URI, integration);
            }
            const result = await generator.generate(buildBlock(), NOTEBOOK_URI);
            assert.strictEqual(result, undefined);
            sinon.assert.notCalled(fetcher);
        });
    });

    test('returns undefined when the supplied notebook resolves no config for the id, even if another notebook does', async () => {
        // Catches: resolving against an ambient/active notebook instead of the one the cell belongs to.
        setupValidFederatedIntegration();

        const result = await generator.generate(buildSqlBlock(), OTHER_NOTEBOOK_URI);

        assert.strictEqual(result, undefined);
        sinon.assert.calledOnceWithExactly(getMergedIntegrationConfigsSpy, OTHER_NOTEBOOK_URI);
        sinon.assert.notCalled(fetcher);
    });

    test('throws NotAuthenticatedError when federated integration has no stored token', async () => {
        setMergedConfigs(NOTEBOOK_URI, buildGoogleOauthIntegration());

        try {
            await generator.generate(buildSqlBlock(), NOTEBOOK_URI);
            assert.fail('Expected NotAuthenticatedError');
        } catch (err) {
            assert(err instanceof NotAuthenticatedError);
            assert.strictEqual(err.integrationName, 'My BigQuery');
        }
        sinon.assert.notCalled(fetcher);
    });

    test('a .deepnote.env.yaml edit to clientId throws NotAuthenticatedError and keeps the stored token', async () => {
        // A mismatch means "unusable by this notebook", not "dead": deleting would evict a sibling notebook that
        // declares the same id with its own OAuth client. Sign out is the supported way to clear a stale entry.
        // One perturbed field is enough: the generator hashes clientId/clientSecret/project through a single
        // `computeMetadataFingerprint` call, and per-field sensitivity is covered in the token-storage suite.
        const metadata: GoogleOauthMetadata = {
            authMethod: 'google-oauth',
            clientId: 'edited-in-yaml',
            clientSecret: CLIENT_SECRET,
            project: PROJECT
        };
        setMergedConfigs(NOTEBOOK_URI, buildGoogleOauthIntegration({ metadata }));
        tokens.set(
            INTEGRATION_ID,
            buildTokenEntry({ refreshToken: REFRESH_TOKEN, metadataFingerprint: VALID_FINGERPRINT })
        );

        try {
            await generator.generate(buildSqlBlock(), NOTEBOOK_URI);
            assert.fail('Expected NotAuthenticatedError');
        } catch (err) {
            assert.instanceOf(err, NotAuthenticatedError);
        }
        sinon.assert.notCalled(deleteSpy);
        sinon.assert.notCalled(fetcher);
    });

    test('a second notebook with a different OAuth client does not evict the first notebook’s token', async () => {
        setMergedConfigs(NOTEBOOK_URI, buildGoogleOauthIntegration());
        setMergedConfigs(
            OTHER_NOTEBOOK_URI,
            buildGoogleOauthIntegration({
                metadata: {
                    authMethod: 'google-oauth',
                    clientId: 'other-notebook-client',
                    clientSecret: CLIENT_SECRET,
                    project: PROJECT
                }
            })
        );
        tokens.set(
            INTEGRATION_ID,
            buildTokenEntry({ refreshToken: REFRESH_TOKEN, metadataFingerprint: VALID_FINGERPRINT })
        );

        try {
            await generator.generate(buildSqlBlock(), OTHER_NOTEBOOK_URI);
            assert.fail('Expected NotAuthenticatedError');
        } catch (err) {
            assert.instanceOf(err, NotAuthenticatedError);
        }

        // Deleting here would also fire onDidChangeTokens, restarting the first notebook's kernel mid-session.
        sinon.assert.notCalled(deleteSpy);
        assert.strictEqual(tokens.get(INTEGRATION_ID)?.refreshToken, REFRESH_TOKEN);
    });

    test('returns a single Python string embedding the access token in the execute call for a valid federated SQL block', async () => {
        // Mirrors deepnote-internal: one `_dntk.execute_sql_with_connection_json(...)` call with the connection JSON as a literal containing the fresh access token. Token is expected in the single execute payload, same as cloud.
        setupValidFederatedIntegration();

        const result = await generator.generate(buildSqlBlock(), NOTEBOOK_URI);
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
        const metadata: GoogleOauthMetadata = {
            authMethod: 'google-oauth',
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            project: hostileProject
        };
        setMergedConfigs(NOTEBOOK_URI, buildGoogleOauthIntegration({ metadata }));
        const hostileFingerprint = computeMetadataFingerprint({
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            project: hostileProject
        });
        tokens.set(
            INTEGRATION_ID,
            buildTokenEntry({ refreshToken: REFRESH_TOKEN, metadataFingerprint: hostileFingerprint })
        );

        const result = await generator.generate(buildSqlBlock(), NOTEBOOK_URI);
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

        const first = await generator.generate(buildSqlBlock(), NOTEBOOK_URI);
        const second = await generator.generate(buildSqlBlock(), NOTEBOOK_URI);

        sinon.assert.calledTwice(fetcher);
        assert.notStrictEqual(first, second);
        assert.include(first ?? '', 'token-1');
        assert.include(second ?? '', 'token-2');
    });

    test('InvalidGrantError from refresh: throws NotAuthenticatedError and deletes the token', async () => {
        setupValidFederatedIntegration();
        fetcher.rejects(new InvalidGrantError());

        try {
            await generator.generate(buildSqlBlock(), NOTEBOOK_URI);
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
            await generator.generate(buildSqlBlock(), NOTEBOOK_URI);
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

        await generator.generate(buildSqlBlock(), NOTEBOOK_URI);

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

        await generator.generate(buildSqlBlock(), NOTEBOOK_URI);

        sinon.assert.notCalled(saveSpy);
    });

    test('honors deepnote_variable_name by emitting an assignment in the generated code', async () => {
        setupValidFederatedIntegration();
        const result = await generator.generate(buildSqlBlock({ deepnote_variable_name: 'my_df' }), NOTEBOOK_URI);
        if (typeof result !== 'string') {
            throw new Error(`expected a string result, got ${typeof result}`);
        }
        // Match upstream's shape: `my_df = _dntk.execute_sql_with_connection_json(...)` followed by `my_df` on the next line.
        assert.include(result, 'my_df = _dntk.execute_sql_with_connection_json(');
    });
});
