import { assert } from 'chai';
import sinon from 'sinon';
import { CancellationError, Uri } from 'vscode';
import { anyString, anything, capture, deepEqual, instance, mock, verify, when } from 'ts-mockito';
import type { DatabaseIntegrationConfig } from '@deepnote/database-integrations';

import { Commands } from '../../../../platform/common/constants';
import { IExtensionContext, IDisposable } from '../../../../platform/common/types';
import { FederatedAuthCommandHandlerNode, buildExtensionStartUrl } from './federatedAuthCommandHandler.node';
import { IFederatedAuthTokenStorage } from '../types';
import { ISqlIntegrationEnvVarsProvider } from '../../../../platform/notebooks/deepnote/types';
import { computeMetadataFingerprint } from './federatedAuthTokenStorage.node';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../../test/vscode-mock';
import { uriEquals } from '../../../../test/datascience/helpers';
import {
    FED_AUTH_FIXTURE,
    buildGoogleOauthIntegration,
    buildPostgresIntegration,
    buildServiceAccountIntegration
} from './federatedAuthTestHelpers';
import type { RunOAuthFlowParams } from './oauthLoopbackFlow.node';

suite('FederatedAuthCommandHandlerNode', () => {
    const NOTEBOOK_URI = Uri.file('/workspace/project.deepnote');
    const OTHER_NOTEBOOK_URI = Uri.file('/workspace/other/project.deepnote');
    const EXTERNAL_CALLBACK_URL = 'http://127.0.0.1:54321/auth/callback';

    let extensionContext: IExtensionContext;
    /** Merged (`.deepnote.env.yaml` over SecretStorage) configs keyed by the notebook they resolve for. */
    let mergedIntegrationConfigs: Map<string, DatabaseIntegrationConfig[]>;
    let sqlIntegrationEnvVars: ISqlIntegrationEnvVarsProvider;
    let tokenStorage: IFederatedAuthTokenStorage;
    let subscriptions: IDisposable[];
    let runOAuthFlowStub: sinon.SinonStub<[RunOAuthFlowParams], Promise<{ refreshToken: string }>>;
    let handler: FederatedAuthCommandHandlerNode;

    setup(() => {
        resetVSCodeMocks();
        subscriptions = [];
        mergedIntegrationConfigs = new Map();

        extensionContext = mock<IExtensionContext>();
        sqlIntegrationEnvVars = mock<ISqlIntegrationEnvVarsProvider>();
        tokenStorage = mock<IFederatedAuthTokenStorage>();
        when(extensionContext.subscriptions).thenReturn(subscriptions);
        // A single matcher that dispatches on the URI: a per-URI `when` would be shadowed by matcher ordering.
        when(sqlIntegrationEnvVars.getMergedIntegrationConfigs(anything())).thenCall(
            async (resource: Uri) => mergedIntegrationConfigs.get(resource.toString()) ?? []
        );

        runOAuthFlowStub = sinon.stub<[RunOAuthFlowParams], Promise<{ refreshToken: string }>>();
        runOAuthFlowStub.resolves({ refreshToken: FED_AUTH_FIXTURE.REFRESH_TOKEN });

        when(mockedVSCodeNamespaces.env.openExternal(anything())).thenReturn(Promise.resolve(true));

        handler = new FederatedAuthCommandHandlerNode(
            instance(extensionContext),
            instance(sqlIntegrationEnvVars),
            instance(tokenStorage),
            runOAuthFlowStub
        );
    });

    teardown(() => {
        sinon.restore();
    });

    /** Publishes `configs` as what `.deepnote.env.yaml` + SecretStorage merge to for `uri`. */
    function setMergedIntegrationConfigs(uri: Uri, ...configs: DatabaseIntegrationConfig[]) {
        mergedIntegrationConfigs.set(uri.toString(), configs);
    }

    /** Drives the stubbed flow through `onListening`, the callback that opens the browser at the start URL. */
    function driveOnListening() {
        runOAuthFlowStub.callsFake(async (params: RunOAuthFlowParams) => {
            await params.onListening(EXTERNAL_CALLBACK_URL);

            return { refreshToken: FED_AUTH_FIXTURE.REFRESH_TOKEN };
        });
    }

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
            setMergedIntegrationConfigs(NOTEBOOK_URI, ...(config ? [config] : []));

            await handler.authenticate(id, NOTEBOOK_URI);

            assert.strictEqual(runOAuthFlowStub.callCount, 0);
            verify(tokenStorage.save(anything())).never();
        });
    });

    test('happy path: saves the captured refresh token with a fresh fingerprint', async () => {
        // The config lives only in that notebook's `.deepnote.env.yaml`; SecretStorage has nothing for the id.
        setMergedIntegrationConfigs(NOTEBOOK_URI, buildGoogleOauthIntegration());

        await handler.authenticate(FED_AUTH_FIXTURE.INTEGRATION_ID, NOTEBOOK_URI);

        verify(sqlIntegrationEnvVars.getMergedIntegrationConfigs(NOTEBOOK_URI)).once();
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

    test('skips OAuth flow when the supplied notebook resolves no config for the id, even if another notebook does', async () => {
        // Catches: resolving against an ambient/active notebook instead of the one the request came from.
        setMergedIntegrationConfigs(NOTEBOOK_URI, buildGoogleOauthIntegration());

        await handler.authenticate(FED_AUTH_FIXTURE.INTEGRATION_ID, OTHER_NOTEBOOK_URI);

        verify(sqlIntegrationEnvVars.getMergedIntegrationConfigs(OTHER_NOTEBOOK_URI)).once();
        assert.strictEqual(runOAuthFlowStub.callCount, 0);
        verify(tokenStorage.save(anything())).never();
    });

    test('returns without a lookup when invoked without a resource', async () => {
        // `executeCommand` callers are untyped, so the guard has to hold at runtime.
        setMergedIntegrationConfigs(NOTEBOOK_URI, buildGoogleOauthIntegration());

        await handler.authenticate(FED_AUTH_FIXTURE.INTEGRATION_ID, undefined as unknown as Uri);

        verify(sqlIntegrationEnvVars.getMergedIntegrationConfigs(anything())).never();
        assert.strictEqual(runOAuthFlowStub.callCount, 0);
        verify(tokenStorage.save(anything())).never();
    });

    test('runOAuthFlow is called with clientId, clientSecret, state, codeVerifier, and the deepnote-callback redirectUri', async () => {
        setMergedIntegrationConfigs(NOTEBOOK_URI, buildGoogleOauthIntegration());

        await handler.authenticate(FED_AUTH_FIXTURE.INTEGRATION_ID, NOTEBOOK_URI);

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
        setMergedIntegrationConfigs(NOTEBOOK_URI, buildGoogleOauthIntegration());
        driveOnListening();

        await handler.authenticate(FED_AUTH_FIXTURE.INTEGRATION_ID, NOTEBOOK_URI);

        const [openedUri] = capture(mockedVSCodeNamespaces.env.openExternal).last();
        // Inspect the Uri directly — going through `Uri.parse(...).toString()` would mangle percent-encoded characters in the query (mock decodes during parse).
        const uri = openedUri as Uri;
        assert.strictEqual(uri.scheme, 'https');
        assert.strictEqual(uri.authority, 'deepnote.com');
        assert.strictEqual(uri.path, '/auth/bigquery/extension/start');

        const params = new URLSearchParams(uri.query);
        assert.strictEqual(params.get('client_id'), FED_AUTH_FIXTURE.CLIENT_ID);
        assert.strictEqual(params.get('final_redirect'), EXTERNAL_CALLBACK_URL);
        assert.isString(params.get('state'));
        assert.isString(params.get('code_challenge'));

        // The state in the URL must match the state passed to runOAuthFlow (browser → server → callback → loopback contract).
        const callArg = runOAuthFlowStub.firstCall.args[0];
        assert.strictEqual(params.get('state'), callArg.state);
    });

    test('scopes the deepnote.domain setting to the notebook the command was invoked for', async () => {
        // Catches a revert to an ambient `window.activeNotebookEditor` lookup: a folder-scoped override only
        // resolves if the setting is read against the supplied resource.
        when(mockedVSCodeNamespaces.workspace.getConfiguration('deepnote', uriEquals(NOTEBOOK_URI))).thenReturn({
            get: () => 'staging.deepnote.com'
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        setMergedIntegrationConfigs(NOTEBOOK_URI, buildGoogleOauthIntegration());
        driveOnListening();

        await handler.authenticate(FED_AUTH_FIXTURE.INTEGRATION_ID, NOTEBOOK_URI);

        const [openedUri] = capture(mockedVSCodeNamespaces.env.openExternal).last();
        assert.strictEqual((openedUri as Uri).authority, 'staging.deepnote.com');
        assert.strictEqual(
            runOAuthFlowStub.firstCall.args[0].redirectUri,
            'https://staging.deepnote.com/auth/bigquery/google-oauth-callback'
        );
    });

    test('silently returns when the user cancels the flow', async () => {
        setMergedIntegrationConfigs(NOTEBOOK_URI, buildGoogleOauthIntegration());
        runOAuthFlowStub.rejects(new CancellationError());

        await handler.authenticate(FED_AUTH_FIXTURE.INTEGRATION_ID, NOTEBOOK_URI);

        assert.strictEqual(runOAuthFlowStub.callCount, 1);
        verify(tokenStorage.save(anything())).never();
    });

    test('surfaces a generic OAuth error via the failure toast and does not save a token', async () => {
        setMergedIntegrationConfigs(NOTEBOOK_URI, buildGoogleOauthIntegration());
        runOAuthFlowStub.rejects(new Error('boom'));

        await handler.authenticate(FED_AUTH_FIXTURE.INTEGRATION_ID, NOTEBOOK_URI);

        assert.strictEqual(runOAuthFlowStub.callCount, 1);
        verify(tokenStorage.save(anything())).never();
    });

    test('the registered command forwards both the integration id and the resource', async () => {
        // Catches: dropping the second argument would silently fall back to no resource and fail the guard.
        when(mockedVSCodeNamespaces.commands.registerCommand(anyString(), anything())).thenReturn({
            dispose: () => undefined
        } as IDisposable);
        const authenticateStub = sinon.stub(handler, 'authenticate').resolves();

        handler.activate();

        assert.strictEqual(subscriptions.length, 1, 'one disposable subscription should be registered');

        const [commandId, callback] = capture(mockedVSCodeNamespaces.commands.registerCommand).last();
        assert.strictEqual(commandId, Commands.AuthenticateIntegration);

        await (callback as (integrationId: string, resource: Uri) => Promise<void>)(
            FED_AUTH_FIXTURE.INTEGRATION_ID,
            NOTEBOOK_URI
        );

        sinon.assert.calledOnceWithExactly(authenticateStub, FED_AUTH_FIXTURE.INTEGRATION_ID, NOTEBOOK_URI);
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
});
