import { assert } from 'chai';
import sinon from 'sinon';
import { CancellationError, CancellationTokenSource } from 'vscode';
import { anyString, anything, instance, mock, reset, when } from 'ts-mockito';

import { ConfigurableDatabaseIntegrationConfig } from '../../../../platform/notebooks/deepnote/integrationTypes';
import { IIntegrationStorage } from '../../../../platform/notebooks/deepnote/types';
import { IExtensionContext, IDisposable } from '../../../../platform/common/types';
import { FederatedAuthCommandHandlerNode } from './federatedAuthCommandHandler.node';
import { FederatedAuthTokenEntry, IFederatedAuthTokenStorage } from '../types';
import { computeMetadataFingerprint } from './federatedAuthTokenStorage.node';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../../test/vscode-mock';
import type { RunOAuthFlowParams } from './oauthLoopbackFlow.node';

suite('FederatedAuthCommandHandlerNode', () => {
    const INTEGRATION_ID = 'bq-1';
    const PROJECT = 'my-gcp-project';
    const CLIENT_ID = 'client-abc';
    const CLIENT_SECRET = 'secret-xyz';
    const REFRESH_TOKEN = 'refresh-token-value';

    let extensionContext: IExtensionContext;
    let integrationStorage: IIntegrationStorage;
    let tokenStorage: IFederatedAuthTokenStorage;
    let subscriptions: IDisposable[];
    let runOAuthFlowStub: sinon.SinonStub<[RunOAuthFlowParams], Promise<{ refreshToken: string }>>;
    let handler: FederatedAuthCommandHandlerNode;

    let integrationStore: Map<string, ConfigurableDatabaseIntegrationConfig>;
    let savedTokens: FederatedAuthTokenEntry[];

    setup(() => {
        resetVSCodeMocks();
        subscriptions = [];
        integrationStore = new Map();
        savedTokens = [];

        extensionContext = mock<IExtensionContext>();
        when(extensionContext.subscriptions).thenReturn(subscriptions);

        integrationStorage = {
            getIntegrationConfig: async (id: string) => integrationStore.get(id)
        } as unknown as IIntegrationStorage;

        tokenStorage = {
            save: async (entry: FederatedAuthTokenEntry) => {
                savedTokens.push(entry);
            }
        } as unknown as IFederatedAuthTokenStorage;

        runOAuthFlowStub = sinon.stub<[RunOAuthFlowParams], Promise<{ refreshToken: string }>>();
        runOAuthFlowStub.resolves({ refreshToken: REFRESH_TOKEN });

        // env.asExternalUri returns the input untouched in the mock.
        when(mockedVSCodeNamespaces.env.asExternalUri(anything())).thenCall((uri) => Promise.resolve(uri));
        when(mockedVSCodeNamespaces.env.openExternal(anything())).thenResolve(true as unknown as void);

        handler = new FederatedAuthCommandHandlerNode(
            instance(extensionContext),
            integrationStorage,
            tokenStorage,
            runOAuthFlowStub
        );
    });

    teardown(() => {
        // Tests configure env.remoteName per-test; resetVSCodeMocks() in setup clears stale state.
        reset(mockedVSCodeNamespaces.env);
        reset(mockedVSCodeNamespaces.window);
    });

    function setupValidGoogleOauthIntegration(): void {
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
    }

    test('shows remote-not-supported toast and does not start the OAuth flow when env.remoteName is set', async () => {
        when(mockedVSCodeNamespaces.env.remoteName).thenReturn('ssh-remote');
        setupValidGoogleOauthIntegration();

        await handler.authenticate(INTEGRATION_ID);

        assert.strictEqual(runOAuthFlowStub.callCount, 0, 'runOAuthFlow should not have been called');
        assert.lengthOf(savedTokens, 0, 'no token should be saved');
    });

    test('shows error toast for a non-existent integration', async () => {
        when(mockedVSCodeNamespaces.env.remoteName).thenReturn(undefined);

        await handler.authenticate('unknown-integration-id');

        assert.strictEqual(runOAuthFlowStub.callCount, 0);
        assert.lengthOf(savedTokens, 0);
    });

    test('shows error toast for a non-BigQuery integration', async () => {
        when(mockedVSCodeNamespaces.env.remoteName).thenReturn(undefined);
        integrationStore.set(INTEGRATION_ID, {
            id: INTEGRATION_ID,
            name: 'My Postgres',
            type: 'pgsql',
            metadata: {
                host: 'localhost',
                port: '5432',
                database: 'db',
                user: 'u',
                password: 'p',
                sslEnabled: false
            }
        } as ConfigurableDatabaseIntegrationConfig);

        await handler.authenticate(INTEGRATION_ID);

        assert.strictEqual(runOAuthFlowStub.callCount, 0);
        assert.lengthOf(savedTokens, 0);
    });

    test('shows error toast for a service-account BigQuery integration', async () => {
        when(mockedVSCodeNamespaces.env.remoteName).thenReturn(undefined);
        integrationStore.set(INTEGRATION_ID, {
            id: INTEGRATION_ID,
            name: 'SA BigQuery',
            type: 'big-query',
            metadata: {
                authMethod: 'service-account',
                service_account: '{}'
            }
        } as ConfigurableDatabaseIntegrationConfig);

        await handler.authenticate(INTEGRATION_ID);

        assert.strictEqual(runOAuthFlowStub.callCount, 0);
        assert.lengthOf(savedTokens, 0);
    });

    test('happy path: saves the captured refresh token with a fresh fingerprint and surfaces the success toast', async () => {
        when(mockedVSCodeNamespaces.env.remoteName).thenReturn(undefined);
        setupValidGoogleOauthIntegration();

        await handler.authenticate(INTEGRATION_ID);

        assert.strictEqual(runOAuthFlowStub.callCount, 1);
        assert.lengthOf(savedTokens, 1);
        assert.deepStrictEqual(savedTokens[0], {
            integrationId: INTEGRATION_ID,
            refreshToken: REFRESH_TOKEN,
            metadataFingerprint: computeMetadataFingerprint({
                clientId: CLIENT_ID,
                clientSecret: CLIENT_SECRET,
                project: PROJECT
            })
        });

        // Sanity-check that the strategy + completion were threaded through.
        const callArg = runOAuthFlowStub.firstCall.args[0];
        assert.strictEqual(callArg.integrationId, INTEGRATION_ID);
        assert.isFunction(callArg.onListening);
    });

    test('silently returns when the user cancels the flow', async () => {
        when(mockedVSCodeNamespaces.env.remoteName).thenReturn(undefined);
        setupValidGoogleOauthIntegration();
        runOAuthFlowStub.rejects(new CancellationError());

        await handler.authenticate(INTEGRATION_ID);

        assert.strictEqual(runOAuthFlowStub.callCount, 1);
        assert.lengthOf(savedTokens, 0);
    });

    test('surfaces a generic OAuth error via the failure toast and does not save a token', async () => {
        when(mockedVSCodeNamespaces.env.remoteName).thenReturn(undefined);
        setupValidGoogleOauthIntegration();
        runOAuthFlowStub.rejects(new Error('boom'));

        await handler.authenticate(INTEGRATION_ID);

        assert.strictEqual(runOAuthFlowStub.callCount, 1);
        assert.lengthOf(savedTokens, 0);
    });

    test('activate registers the command and pushes a disposable into the extension context subscriptions', () => {
        when(mockedVSCodeNamespaces.commands.registerCommand(anyString(), anything())).thenReturn({
            dispose: () => undefined
        } as IDisposable);

        handler.activate();

        assert.strictEqual(subscriptions.length, 1, 'one disposable subscription should be registered');
    });

    test('cancellation token from withProgress is threaded into runOAuthFlow', async () => {
        when(mockedVSCodeNamespaces.env.remoteName).thenReturn(undefined);
        setupValidGoogleOauthIntegration();

        // Drive withProgress with a token so we can assert it lands in runOAuthFlow's params.
        const tokenSource = new CancellationTokenSource();
        try {
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall((_options, callback) =>
                Promise.resolve(callback({ report: () => undefined }, tokenSource.token))
            );

            await handler.authenticate(INTEGRATION_ID);

            const callArg = runOAuthFlowStub.firstCall.args[0];
            assert.strictEqual(callArg.token, tokenSource.token);
        } finally {
            tokenSource.dispose();
        }
    });
});
