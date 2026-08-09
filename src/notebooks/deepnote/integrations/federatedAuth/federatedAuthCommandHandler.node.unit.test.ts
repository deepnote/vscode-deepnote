import { assert } from 'chai';
import sinon from 'sinon';
import { CancellationError, Uri } from 'vscode';
import { anyString, anything, capture, deepEqual, instance, mock, verify, when } from 'ts-mockito';

import { IExtensionContext, IDisposable } from '../../../../platform/common/types';
import { FederatedAuthCommandHandlerNode, buildExtensionStartUrl } from './federatedAuthCommandHandler.node';
import { IFederatedAuthTokenStorage } from '../types';
import { IIntegrationStorage } from '../../../../platform/notebooks/deepnote/types';
import { computeMetadataFingerprint } from './federatedAuthTokenStorage.node';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../../test/vscode-mock';
import {
    FED_AUTH_FIXTURE,
    buildGoogleOauthIntegration,
    buildPostgresIntegration,
    buildServiceAccountIntegration
} from './federatedAuthTestHelpers';
import type { RunOAuthFlowParams } from './oauthLoopbackFlow.node';

suite('FederatedAuthCommandHandlerNode', () => {
    let extensionContext: IExtensionContext;
    let integrationStorage: IIntegrationStorage;
    let tokenStorage: IFederatedAuthTokenStorage;
    let subscriptions: IDisposable[];
    let runOAuthFlowStub: sinon.SinonStub<[RunOAuthFlowParams], Promise<{ refreshToken: string }>>;
    let handler: FederatedAuthCommandHandlerNode;

    setup(() => {
        resetVSCodeMocks();
        subscriptions = [];

        extensionContext = mock<IExtensionContext>();
        integrationStorage = mock<IIntegrationStorage>();
        tokenStorage = mock<IFederatedAuthTokenStorage>();
        when(extensionContext.subscriptions).thenReturn(subscriptions);

        runOAuthFlowStub = sinon.stub<[RunOAuthFlowParams], Promise<{ refreshToken: string }>>();
        runOAuthFlowStub.resolves({ refreshToken: FED_AUTH_FIXTURE.REFRESH_TOKEN });

        when(mockedVSCodeNamespaces.env.openExternal(anything())).thenReturn(Promise.resolve(true));

        handler = new FederatedAuthCommandHandlerNode(
            instance(extensionContext),
            instance(integrationStorage),
            instance(tokenStorage),
            runOAuthFlowStub
        );
    });

    (
        [
            ['unknown integration id', () => undefined, 'unknown-id'],
            ['non-BigQuery integration', () => buildPostgresIntegration({ id: FED_AUTH_FIXTURE.INTEGRATION_ID })],
            ['service-account BigQuery integration', () => buildServiceAccountIntegration()]
        ] as const
    ).forEach(([label, build, lookupId]) => {
        test(`skips OAuth flow for ${label}`, async () => {
            const config = build();
            const id = lookupId ?? FED_AUTH_FIXTURE.INTEGRATION_ID;
            when(integrationStorage.getIntegrationConfig(id)).thenResolve(config);

            const outcome = await handler.authenticate(id);

            assert.strictEqual(outcome, 'failed');
            assert.strictEqual(runOAuthFlowStub.callCount, 0);
            verify(tokenStorage.save(anything())).never();
        });
    });

    test('happy path: saves the captured refresh token with a fresh fingerprint and reports completed', async () => {
        when(integrationStorage.getIntegrationConfig(FED_AUTH_FIXTURE.INTEGRATION_ID)).thenResolve(
            buildGoogleOauthIntegration()
        );

        const outcome = await handler.authenticate(FED_AUTH_FIXTURE.INTEGRATION_ID);

        assert.strictEqual(outcome, 'completed');
        assert.strictEqual(runOAuthFlowStub.callCount, 1);
        verify(
            tokenStorage.save(
                deepEqual({
                    integrationId: FED_AUTH_FIXTURE.INTEGRATION_ID,
                    refreshToken: FED_AUTH_FIXTURE.REFRESH_TOKEN,
                    metadataFingerprint: computeMetadataFingerprint({
                        clientId: FED_AUTH_FIXTURE.CLIENT_ID,
                        clientSecret: FED_AUTH_FIXTURE.CLIENT_SECRET,
                        project: FED_AUTH_FIXTURE.PROJECT
                    })
                })
            )
        ).once();
    });

    test('runOAuthFlow is called with clientId, clientSecret, state, codeVerifier, and the deepnote-callback redirectUri', async () => {
        when(integrationStorage.getIntegrationConfig(FED_AUTH_FIXTURE.INTEGRATION_ID)).thenResolve(
            buildGoogleOauthIntegration()
        );

        await handler.authenticate(FED_AUTH_FIXTURE.INTEGRATION_ID);

        assert.strictEqual(runOAuthFlowStub.callCount, 1);
        const callArg = runOAuthFlowStub.firstCall.args[0];
        assert.strictEqual(callArg.integrationId, FED_AUTH_FIXTURE.INTEGRATION_ID);
        assert.strictEqual(callArg.clientId, FED_AUTH_FIXTURE.CLIENT_ID);
        assert.strictEqual(callArg.clientSecret, FED_AUTH_FIXTURE.CLIENT_SECRET);
        assert.strictEqual(callArg.redirectUri, 'https://deepnote.com/auth/bigquery/google-oauth-callback');
        assert.isString(callArg.state);
        assert.isAbove(callArg.state.length, 0);
        assert.isString(callArg.codeVerifier);
        assert.isAbove(callArg.codeVerifier.length, 0);
        assert.isFunction(callArg.onListening);
    });

    test('onListening opens the deepnote.com start URL with the externalized callback as finalRedirect', async () => {
        when(integrationStorage.getIntegrationConfig(FED_AUTH_FIXTURE.INTEGRATION_ID)).thenResolve(
            buildGoogleOauthIntegration()
        );

        runOAuthFlowStub.callsFake(async (params: RunOAuthFlowParams) => {
            await params.onListening('http://127.0.0.1:54321/auth/callback');

            return { refreshToken: FED_AUTH_FIXTURE.REFRESH_TOKEN };
        });

        await handler.authenticate(FED_AUTH_FIXTURE.INTEGRATION_ID);

        const [openedUri] = capture(mockedVSCodeNamespaces.env.openExternal).last();
        // Inspect the Uri directly — going through `Uri.parse(...).toString()` would mangle percent-encoded characters in the query (mock decodes during parse).
        const uri = openedUri as Uri;
        assert.strictEqual(uri.scheme, 'https');
        assert.strictEqual(uri.authority, 'deepnote.com');
        assert.strictEqual(uri.path, '/auth/bigquery/extension/start');

        const params = new URLSearchParams(uri.query);
        assert.strictEqual(params.get('client_id'), FED_AUTH_FIXTURE.CLIENT_ID);
        assert.strictEqual(params.get('final_redirect'), 'http://127.0.0.1:54321/auth/callback');
        assert.isString(params.get('state'));
        assert.isString(params.get('code_challenge'));

        // The state in the URL must match the state passed to runOAuthFlow (browser → server → callback → loopback contract).
        const callArg = runOAuthFlowStub.firstCall.args[0];
        assert.strictEqual(params.get('state'), callArg.state);
    });

    test('reports cancelled when the user cancels the flow', async () => {
        when(integrationStorage.getIntegrationConfig(FED_AUTH_FIXTURE.INTEGRATION_ID)).thenResolve(
            buildGoogleOauthIntegration()
        );
        runOAuthFlowStub.rejects(new CancellationError());

        const outcome = await handler.authenticate(FED_AUTH_FIXTURE.INTEGRATION_ID);

        assert.strictEqual(outcome, 'cancelled');
        assert.strictEqual(runOAuthFlowStub.callCount, 1);
        verify(tokenStorage.save(anything())).never();
    });

    test('surfaces a generic OAuth error via the failure toast, reports failed, and does not save a token', async () => {
        when(integrationStorage.getIntegrationConfig(FED_AUTH_FIXTURE.INTEGRATION_ID)).thenResolve(
            buildGoogleOauthIntegration()
        );
        runOAuthFlowStub.rejects(new Error('boom'));

        const outcome = await handler.authenticate(FED_AUTH_FIXTURE.INTEGRATION_ID);

        assert.strictEqual(outcome, 'failed');
        assert.strictEqual(runOAuthFlowStub.callCount, 1);
        verify(tokenStorage.save(anything())).never();
    });

    test('activate registers the AuthenticateIntegration command and pushes a disposable', () => {
        when(mockedVSCodeNamespaces.commands.registerCommand(anyString(), anything())).thenReturn({
            dispose: () => undefined
        } as IDisposable);

        handler.activate();

        assert.strictEqual(subscriptions.length, 1, 'one disposable subscription should be registered');
    });
});

suite('buildExtensionStartUrl', () => {
    test('builds the full deepnote.com start URL with all four query params', () => {
        const url = buildExtensionStartUrl({
            clientId: 'my-client-id',
            codeChallenge: 'pkce-challenge',
            deepnoteDomain: 'deepnote.com',
            finalRedirect: 'http://127.0.0.1:54321/auth/callback',
            state: 'state-nonce'
        });

        const parsed = new URL(url);
        assert.strictEqual(parsed.origin, 'https://deepnote.com');
        assert.strictEqual(parsed.pathname, '/auth/bigquery/extension/start');
        assert.strictEqual(parsed.searchParams.get('client_id'), 'my-client-id');
        assert.strictEqual(parsed.searchParams.get('state'), 'state-nonce');
        assert.strictEqual(parsed.searchParams.get('code_challenge'), 'pkce-challenge');
        assert.strictEqual(parsed.searchParams.get('final_redirect'), 'http://127.0.0.1:54321/auth/callback');
    });

    test('honors the deepnoteDomain override (for dev/staging hosts)', () => {
        const url = buildExtensionStartUrl({
            clientId: 'c',
            codeChallenge: 'c',
            deepnoteDomain: 'dev.deepnote.org',
            finalRedirect: 'http://127.0.0.1:1/cb',
            state: 's'
        });
        assert.strictEqual(new URL(url).host, 'dev.deepnote.org');
    });
});
