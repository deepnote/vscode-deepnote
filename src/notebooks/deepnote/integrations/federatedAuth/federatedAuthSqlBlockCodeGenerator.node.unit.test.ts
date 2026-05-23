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

suite('FederatedAuthSqlBlockCodeGenerator', () => {
    const { INTEGRATION_ID, PROJECT, CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN, ACCESS_TOKEN } = FED_AUTH_FIXTURE;
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

        generator = new FederatedAuthSqlBlockCodeGenerator(integrationStorage, tokenStorage);
        generator.fetchFreshAccessToken = fetcher as unknown as FetcherFn;
    });

    function setupValidFederatedIntegration() {
        integrationStore.set(INTEGRATION_ID, buildGoogleOauthIntegration());
        tokenStore.set(
            INTEGRATION_ID,
            buildTokenEntry({ refreshToken: REFRESH_TOKEN, metadataFingerprint: VALID_FINGERPRINT })
        );
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
                integrationStore.set(INTEGRATION_ID, integration);
            }
            const result = await generator.generate(buildBlock());
            assert.strictEqual(result, undefined);
            sinon.assert.notCalled(fetcher);
        });
    });

    test('throws NotAuthenticatedError when federated integration has no stored token', async () => {
        integrationStore.set(INTEGRATION_ID, buildGoogleOauthIntegration());

        try {
            await generator.generate(buildSqlBlock());
            assert.fail('Expected NotAuthenticatedError');
        } catch (err) {
            assert.instanceOf(err, NotAuthenticatedError);
            assert.strictEqual((err as NotAuthenticatedError).integrationName, 'My BigQuery');
        }
        sinon.assert.notCalled(fetcher);
    });

    test('throws NotAuthenticatedError and deletes the token when the metadata fingerprint is stale', async () => {
        setupValidFederatedIntegration();
        tokenStore.set(
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

    test('returns { prelude, cellCode } for a valid federated SQL block', async () => {
        setupValidFederatedIntegration();

        const result = await generator.generate(buildSqlBlock());
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
        integrationStore.set(hostileIntegrationId, buildGoogleOauthIntegration({ id: hostileIntegrationId }));
        tokenStore.set(
            hostileIntegrationId,
            buildTokenEntry({
                integrationId: hostileIntegrationId,
                refreshToken: REFRESH_TOKEN,
                metadataFingerprint: VALID_FINGERPRINT
            })
        );

        const result = await generator.generate(buildSqlBlock({ sql_integration_id: hostileIntegrationId }));
        if (!result) {
            throw new Error('expected a non-undefined result');
        }

        const expectedVariableName = federatedSqlVariableName(hostileIntegrationId);
        const assignmentPrefix = `${expectedVariableName} = `;
        assert.isTrue(
            result.prelude.startsWith(assignmentPrefix),
            `prelude did not begin with the expected assignment prefix: ${result.prelude}`
        );
        const literal = result.prelude.slice(assignmentPrefix.length);

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

        const first = await generator.generate(buildSqlBlock());
        const second = await generator.generate(buildSqlBlock());

        sinon.assert.calledTwice(fetcher);
        assert.notStrictEqual(first?.prelude, second?.prelude);
        assert.include(first?.prelude ?? '', 'token-1');
        assert.include(second?.prelude ?? '', 'token-2');
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
            assert.instanceOf(err, OAuthClientMisconfiguredError);
            assert.notInstanceOf(err, NotAuthenticatedError);
            assert.notInstanceOf(err, InvalidClientError);
            assert.equal((err as OAuthClientMisconfiguredError).integrationName, 'My BigQuery');
        }
        sinon.assert.notCalled(deleteSpy);
    });

    test('persists a rotated refresh token with { silent: true } so listeners do not restart the in-flight kernel', async () => {
        // Catches: a rotation event firing `onDidChangeTokens` would queue a `kernel.restart()` while the prelude+main execute are running.
        setupValidFederatedIntegration();
        fetcher.resolves({ accessToken: ACCESS_TOKEN, newRefreshToken: 'new-refresh-token' });

        await generator.generate(buildSqlBlock());

        sinon.assert.calledOnce(saveSpy);
        const [savedEntry, options] = saveSpy.firstCall.args as [FederatedAuthTokenEntry, { silent?: boolean }];
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

    test('cellCode honors deepnote_variable_name by emitting an assignment', async () => {
        setupValidFederatedIntegration();
        const result = await generator.generate(buildSqlBlock({ deepnote_variable_name: 'my_df' }));
        if (!result) {
            throw new Error('expected a non-undefined result');
        }
        // Match upstream's shape: `my_df = _dntk.execute_sql_with_connection_json(...)` followed by `my_df` on the next line.
        assert.include(result.cellCode, 'my_df = _dntk.execute_sql_with_connection_json(');
    });

    suite('federatedSqlVariableName', () => {
        (
            [
                ['abc-123-def', '__deepnote_federated_sql_connection__abc_123_def'],
                ['abc_123', '__deepnote_federated_sql_connection__abc_123']
            ] as const
        ).forEach(([input, expected]) => {
            test(`maps ${JSON.stringify(input)} → ${expected}`, () => {
                assert.strictEqual(federatedSqlVariableName(input), expected);
            });
        });
    });
});
