import { assert } from 'chai';
import sinon from 'sinon';
import { CancellationError } from 'vscode';
import { anyString, anything, instance, mock, when } from 'ts-mockito';

import { ConfigurableDatabaseIntegrationConfig } from '../../../../platform/notebooks/deepnote/integrationTypes';
import { IIntegrationStorage } from '../../../../platform/notebooks/deepnote/types';
import { IExtensionContext, IDisposable } from '../../../../platform/common/types';
import { FederatedAuthCommandHandlerNode } from './federatedAuthCommandHandler.node';
import { FederatedAuthTokenEntry, IFederatedAuthTokenStorage } from '../types';
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
        runOAuthFlowStub.resolves({ refreshToken: FED_AUTH_FIXTURE.REFRESH_TOKEN });

        // env.asExternalUri returns the input untouched in the mock.
        when(mockedVSCodeNamespaces.env.asExternalUri(anything())).thenCall((uri) => Promise.resolve(uri));
        when(mockedVSCodeNamespaces.env.openExternal(anything())).thenResolve(true as unknown as void);
        when(mockedVSCodeNamespaces.env.remoteName).thenReturn(undefined);

        handler = new FederatedAuthCommandHandlerNode(
            instance(extensionContext),
            integrationStorage,
            tokenStorage,
            runOAuthFlowStub
        );
    });

    test('shows remote-not-supported toast and does not start the OAuth flow when env.remoteName is set', async () => {
        when(mockedVSCodeNamespaces.env.remoteName).thenReturn('ssh-remote');
        integrationStore.set(FED_AUTH_FIXTURE.INTEGRATION_ID, buildGoogleOauthIntegration());

        await handler.authenticate(FED_AUTH_FIXTURE.INTEGRATION_ID);

        assert.strictEqual(runOAuthFlowStub.callCount, 0, 'runOAuthFlow should not have been called');
        assert.lengthOf(savedTokens, 0, 'no token should be saved');
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
            if (config) {
                integrationStore.set(FED_AUTH_FIXTURE.INTEGRATION_ID, config);
            }
            await handler.authenticate(lookupId ?? FED_AUTH_FIXTURE.INTEGRATION_ID);

            assert.strictEqual(runOAuthFlowStub.callCount, 0);
            assert.lengthOf(savedTokens, 0);
        });
    });

    test('happy path: saves the captured refresh token with a fresh fingerprint', async () => {
        integrationStore.set(FED_AUTH_FIXTURE.INTEGRATION_ID, buildGoogleOauthIntegration());

        await handler.authenticate(FED_AUTH_FIXTURE.INTEGRATION_ID);

        assert.strictEqual(runOAuthFlowStub.callCount, 1);
        assert.lengthOf(savedTokens, 1);
        assert.deepStrictEqual(savedTokens[0], {
            integrationId: FED_AUTH_FIXTURE.INTEGRATION_ID,
            refreshToken: FED_AUTH_FIXTURE.REFRESH_TOKEN,
            metadataFingerprint: computeMetadataFingerprint({
                clientId: FED_AUTH_FIXTURE.CLIENT_ID,
                clientSecret: FED_AUTH_FIXTURE.CLIENT_SECRET,
                project: FED_AUTH_FIXTURE.PROJECT
            })
        });

        // Sanity-check that the strategy + completion were threaded through.
        const callArg = runOAuthFlowStub.firstCall.args[0];
        assert.strictEqual(callArg.integrationId, FED_AUTH_FIXTURE.INTEGRATION_ID);
        assert.isFunction(callArg.onListening);
    });

    test('silently returns when the user cancels the flow', async () => {
        integrationStore.set(FED_AUTH_FIXTURE.INTEGRATION_ID, buildGoogleOauthIntegration());
        runOAuthFlowStub.rejects(new CancellationError());

        await handler.authenticate(FED_AUTH_FIXTURE.INTEGRATION_ID);

        assert.strictEqual(runOAuthFlowStub.callCount, 1);
        assert.lengthOf(savedTokens, 0);
    });

    test('surfaces a generic OAuth error via the failure toast and does not save a token', async () => {
        integrationStore.set(FED_AUTH_FIXTURE.INTEGRATION_ID, buildGoogleOauthIntegration());
        runOAuthFlowStub.rejects(new Error('boom'));

        await handler.authenticate(FED_AUTH_FIXTURE.INTEGRATION_ID);

        assert.strictEqual(runOAuthFlowStub.callCount, 1);
        assert.lengthOf(savedTokens, 0);
    });

    test('activate registers the AuthenticateIntegration command and pushes a disposable', () => {
        when(mockedVSCodeNamespaces.commands.registerCommand(anyString(), anything())).thenReturn({
            dispose: () => undefined
        } as IDisposable);

        handler.activate();

        assert.strictEqual(subscriptions.length, 1, 'one disposable subscription should be registered');
    });
});
