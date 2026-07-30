import { assert } from 'chai';
import sinon from 'sinon';
import { EventEmitter, Uri } from 'vscode';
import { anyString, anything, instance, mock, reset, verify, when } from 'ts-mockito';

import { IExtensionContext, IDisposable, Resource } from '../../../platform/common/types';
import { Commands } from '../../../platform/common/constants';
import { ISqlIntegrationEnvVarsProvider } from '../../../platform/notebooks/deepnote/types';
import { IDeepnoteNotebookManager } from '../../types';
import { IntegrationWebviewProvider } from './integrationWebview';
import { FederatedAuthTokenEntry, IFederatedAuthTokenStorage, IIntegrationStorage } from './types';
import { computeMetadataFingerprint } from './federatedAuth/federatedAuthTokenStorage.node';
import {
    ConfigurableDatabaseIntegrationConfig,
    DetectedIntegration
} from '../../../platform/notebooks/deepnote/integrationTypes';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import {
    buildGoogleOauthIntegration,
    buildPostgresIntegration,
    buildServiceAccountIntegration
} from './federatedAuth/federatedAuthTestHelpers';

interface CapturedMessage {
    type: string;
    integrations?: Array<{ id: string; config?: unknown; tokenStatus?: string }>;
    [key: string]: unknown;
}

interface FakeWebviewPanel {
    panel: import('vscode').WebviewPanel;
    posted: CapturedMessage[];
    onDidReceiveMessage: (message: unknown) => Promise<void>;
    triggerDispose: () => void;
    setPostMessageImpl: (impl: (message: CapturedMessage) => Promise<boolean>) => void;
}

function createFakeWebviewPanel(): FakeWebviewPanel {
    const posted: CapturedMessage[] = [];
    let messageHandler: ((message: unknown) => Promise<void> | void) | undefined;
    let onDidDisposeCb: (() => void) | undefined;
    let postMessageImpl: (message: CapturedMessage) => Promise<boolean> = async (message) => {
        posted.push(message);
        return true;
    };
    const webview = {
        html: '',
        cspSource: 'mock-csp',
        asWebviewUri: (uri: unknown) => uri,
        postMessage: (message: CapturedMessage) => postMessageImpl(message),
        onDidReceiveMessage: (
            cb: (message: unknown) => Promise<void> | void,
            _thisArg?: unknown,
            disposables?: IDisposable[]
        ): IDisposable => {
            messageHandler = cb;
            const disposable: IDisposable = { dispose: () => undefined };
            disposables?.push(disposable);
            return disposable;
        }
    };
    const panel = {
        webview,
        reveal: () => undefined,
        dispose: () => undefined,
        onDidDispose: (cb: () => void, _thisArg?: unknown, disposables?: IDisposable[]): IDisposable => {
            onDidDisposeCb = cb;
            const disposable: IDisposable = { dispose: () => undefined };
            disposables?.push(disposable);
            return disposable;
        }
    };
    return {
        panel: panel as unknown as import('vscode').WebviewPanel,
        posted,
        onDidReceiveMessage: async (message: unknown) => {
            if (messageHandler) {
                await messageHandler(message);
            }
        },
        triggerDispose: () => {
            if (onDidDisposeCb) {
                onDidDisposeCb();
            }
        },
        setPostMessageImpl: (impl) => {
            postMessageImpl = impl;
        }
    };
}

suite('IntegrationWebviewProvider', () => {
    const ACTIVE_FILE_URI = Uri.file('/ws/active.deepnote');
    const PROJECT_ID = 'project-id-1';

    let extensionContext: IExtensionContext;
    let integrationStorage: IIntegrationStorage;
    let notebookManager: IDeepnoteNotebookManager;
    let federatedAuthCandidates: Set<string>;
    let candidatesSpy: sinon.SinonSpy<[Resource], Promise<ReadonlySet<string>>>;
    let onDidChangeEnvironmentVariables: EventEmitter<Resource>;
    let sqlIntegrationEnvVars: ISqlIntegrationEnvVarsProvider;
    let tokens: Map<string, FederatedAuthTokenEntry>;
    let onDidChangeTokens: EventEmitter<string>;
    let tokenSaveSpy: sinon.SinonSpy<[FederatedAuthTokenEntry, { silent?: boolean }?], Promise<void>>;
    let tokenDeleteSpy: sinon.SinonSpy<[string], Promise<void>>;
    let tokenStorage: IFederatedAuthTokenStorage;
    let extensionSubscriptions: IDisposable[];
    let fakePanel: FakeWebviewPanel;

    setup(() => {
        resetVSCodeMocks();
        extensionContext = mock<IExtensionContext>();
        integrationStorage = mock<IIntegrationStorage>();
        notebookManager = mock<IDeepnoteNotebookManager>();
        extensionSubscriptions = [];
        when(extensionContext.subscriptions).thenReturn(extensionSubscriptions);
        when(extensionContext.extensionUri).thenReturn(Uri.file('/ext'));

        // Federated-auth eligibility is derived state: the provider hands back ids only, never config.
        federatedAuthCandidates = new Set<string>();
        candidatesSpy = sinon.spy(async (_resource: Resource): Promise<ReadonlySet<string>> => federatedAuthCandidates);
        onDidChangeEnvironmentVariables = new EventEmitter<Resource>();
        sqlIntegrationEnvVars = {
            onDidChangeEnvironmentVariables: onDidChangeEnvironmentVariables.event,
            getEnvironmentVariables: async () => ({}),
            getFederatedAuthCandidates: candidatesSpy,
            getMergedIntegrationConfigs: async () => []
        };

        tokens = new Map();
        onDidChangeTokens = new EventEmitter<string>();
        tokenSaveSpy = sinon.spy(async (entry: FederatedAuthTokenEntry, options?: { silent?: boolean }) => {
            tokens.set(entry.integrationId, entry);
            if (!options?.silent) {
                onDidChangeTokens.fire(entry.integrationId);
            }
        });
        tokenDeleteSpy = sinon.spy(async (id: string) => {
            if (tokens.delete(id)) {
                onDidChangeTokens.fire(id);
            }
        });
        tokenStorage = {
            onDidChangeTokens: onDidChangeTokens.event,
            computeMetadataFingerprint: (m) => computeMetadataFingerprint(m),
            delete: tokenDeleteSpy,
            get: async (id) => tokens.get(id),
            has: async (id) => tokens.has(id),
            save: tokenSaveSpy
        };

        fakePanel = createFakeWebviewPanel();
        when(
            mockedVSCodeNamespaces.window.createWebviewPanel(anyString(), anyString(), anything(), anything())
        ).thenReturn(fakePanel.panel);
    });

    teardown(() => {
        reset(mockedVSCodeNamespaces.window);
        reset(mockedVSCodeNamespaces.commands);
        onDidChangeTokens.dispose();
        onDidChangeEnvironmentVariables.dispose();
    });

    function buildProvider(
        opts: {
            sqlIntegrationEnvVars?: ISqlIntegrationEnvVarsProvider;
            tokenStorage?: IFederatedAuthTokenStorage;
        } = {}
    ): IntegrationWebviewProvider {
        return new IntegrationWebviewProvider(
            instance(extensionContext),
            instance(integrationStorage),
            instance(notebookManager),
            extensionSubscriptions,
            opts.sqlIntegrationEnvVars ?? sqlIntegrationEnvVars,
            opts.tokenStorage
        );
    }

    function singleIntegrationMap(
        id: string,
        config: ConfigurableDatabaseIntegrationConfig
    ): Map<string, DetectedIntegration> {
        return new Map([[id, { config }]]);
    }

    async function show(provider: IntegrationWebviewProvider, integrations: Map<string, DetectedIntegration>) {
        await provider.show(PROJECT_ID, integrations, ACTIVE_FILE_URI);
    }

    function lastUpdate(): CapturedMessage {
        return fakePanel.posted.filter((m) => m.type === 'update').pop()!;
    }

    function preStoreToken(id: string, fingerprint = 'fp'): void {
        tokens.set(id, {
            integrationId: id,
            refreshToken: 'r',
            metadataFingerprint: fingerprint
        });
    }

    suite('updateWebview tokenStatus', () => {
        // Eligibility now comes entirely from the candidate set; `config` no longer gates the status.
        test('candidate but no tokenStorage → unsupported', async () => {
            const config = buildGoogleOauthIntegration({ id: 'bq-1' });
            federatedAuthCandidates.add(config.id);

            const provider = buildProvider();
            await show(provider, singleIntegrationMap(config.id, config));

            const item = (lastUpdate().integrations || []).find((i) => i.id === config.id);
            assert.strictEqual(item?.tokenStatus, 'unsupported');
        });

        test('candidate + stored token → authenticated', async () => {
            const config = buildGoogleOauthIntegration({ id: 'bq-2' });
            federatedAuthCandidates.add(config.id);
            preStoreToken(config.id);

            const provider = buildProvider({ tokenStorage });
            await show(provider, singleIntegrationMap(config.id, config));

            const item = (lastUpdate().integrations || []).find((i) => i.id === config.id);
            assert.strictEqual(item?.tokenStatus, 'authenticated');
        });

        test('a candidate with no SecretStorage config gets a status while `config` stays null', async () => {
            // A `.deepnote.env.yaml`-declared integration: authenticatable, but the panel holds no credentials
            // for it and must not receive any from the file layer.
            const integrationId = 'bq-file-only';
            federatedAuthCandidates.add(integrationId);

            const provider = buildProvider({ tokenStorage });
            await show(
                provider,
                new Map<string, DetectedIntegration>([
                    [integrationId, { config: null, integrationName: 'File BigQuery', integrationType: 'big-query' }]
                ])
            );

            const item = (lastUpdate().integrations || []).find((i) => i.id === integrationId);
            assert.strictEqual(item?.tokenStatus, 'disconnected');
            assert.isNull(item?.config, 'no `.deepnote.env.yaml` config may reach the webview payload');
            sinon.assert.calledWith(candidatesSpy, ACTIVE_FILE_URI);
        });

        test('a non-candidate reports unsupported even when a token exists', async () => {
            const config = buildGoogleOauthIntegration({ id: 'bq-not-a-candidate' });
            preStoreToken(config.id);

            const provider = buildProvider({ tokenStorage });
            await show(provider, singleIntegrationMap(config.id, config));

            const item = (lastUpdate().integrations || []).find((i) => i.id === config.id);
            assert.strictEqual(item?.tokenStatus, 'unsupported');
        });

        test('a rejected candidate lookup still renders the panel', async () => {
            const config = buildGoogleOauthIntegration({ id: 'bq-lookup-fails' });
            preStoreToken(config.id);

            const provider = buildProvider({
                sqlIntegrationEnvVars: {
                    ...sqlIntegrationEnvVars,
                    getFederatedAuthCandidates: async () => {
                        throw new Error('merge failed');
                    }
                },
                tokenStorage
            });
            await show(provider, singleIntegrationMap(config.id, config));

            const item = (lastUpdate().integrations || []).find((i) => i.id === config.id);
            assert.strictEqual(item?.tokenStatus, 'unsupported', 'a failed lookup degrades to "no candidates"');
        });
    });

    test('handleMessage: "authenticate" → executeCommand(AuthenticateIntegration, integrationId, activeFileUri)', async () => {
        const executeCommandStub = sinon.stub().resolves(undefined);
        when(mockedVSCodeNamespaces.commands.executeCommand(anyString(), anything(), anything())).thenCall(
            (command, integrationId, resource) => executeCommandStub(command, integrationId, resource)
        );

        const provider = buildProvider({ tokenStorage });
        const integrationId = 'bq-auth';
        federatedAuthCandidates.add(integrationId);
        await show(provider, singleIntegrationMap(integrationId, buildGoogleOauthIntegration({ id: integrationId })));

        await fakePanel.onDidReceiveMessage({ type: 'authenticate', integrationId });

        assert.isTrue(
            executeCommandStub.calledWith(Commands.AuthenticateIntegration, integrationId, ACTIVE_FILE_URI),
            'expected executeCommand to receive the id and the URI the candidate set was derived from'
        );
    });

    (['reset', 'delete'] as const).forEach((messageType) => {
        test(`${messageType}Configuration: deletes the federated token in addition to the integration config`, async () => {
            when(integrationStorage.delete(anyString())).thenResolve();

            const provider = buildProvider({ tokenStorage });
            const integrationId = `bq-${messageType}`;
            preStoreToken(integrationId);

            await show(
                provider,
                singleIntegrationMap(integrationId, buildGoogleOauthIntegration({ id: integrationId }))
            );
            await fakePanel.onDidReceiveMessage({ type: messageType, integrationId });

            sinon.assert.calledWith(tokenDeleteSpy, integrationId);
            verify(integrationStorage.delete(integrationId)).once();
        });
    });

    test('saveConfiguration: deletes the token BEFORE save when fingerprint changes', async () => {
        const integrationId = 'bq-save-fp';
        const integrationSaveSpy = sinon.spy();
        when(integrationStorage.save(anything())).thenCall(integrationSaveSpy);

        const provider = buildProvider({ tokenStorage });
        preStoreToken(integrationId, 'old-fingerprint');
        await show(provider, singleIntegrationMap(integrationId, buildGoogleOauthIntegration({ id: integrationId })));

        // Save a config that produces a DIFFERENT fingerprint than what's stored.
        const newConfig = buildGoogleOauthIntegration({
            id: integrationId,
            name: 'New name',
            metadata: {
                authMethod: 'google-oauth',
                project: 'new-proj',
                clientId: 'new-client',
                clientSecret: 'new-secret'
            }
        } as ConfigurableDatabaseIntegrationConfig);

        await fakePanel.onDidReceiveMessage({ type: 'save', integrationId, config: newConfig });

        sinon.assert.calledOnce(tokenDeleteSpy);
        sinon.assert.calledOnce(integrationSaveSpy);
        assert.isTrue(tokenDeleteSpy.calledBefore(integrationSaveSpy), 'token.delete must occur BEFORE storage.save');
    });

    test('saveConfiguration: deletes the token when authMethod switches away from google-oauth', async () => {
        const integrationId = 'bq-switch';
        when(integrationStorage.save(anything())).thenResolve();

        const provider = buildProvider({ tokenStorage });
        preStoreToken(integrationId, 'fp-1');
        await show(provider, singleIntegrationMap(integrationId, buildGoogleOauthIntegration({ id: integrationId })));

        const newConfig = buildServiceAccountIntegration({ id: integrationId });
        await fakePanel.onDidReceiveMessage({ type: 'save', integrationId, config: newConfig });

        sinon.assert.calledWith(tokenDeleteSpy, integrationId);
        assert.isFalse(tokens.has(integrationId));
    });

    test('saveConfiguration: leaves the token intact when fingerprint matches', async () => {
        const integrationId = 'bq-stable';
        when(integrationStorage.save(anything())).thenResolve();

        const provider = buildProvider({ tokenStorage });
        const sameConfig = buildGoogleOauthIntegration({ id: integrationId });
        const stableFingerprint = computeMetadataFingerprint({
            clientId: 'client-id-abc',
            clientSecret: 'client-secret-xyz',
            project: 'my-gcp-project'
        });
        preStoreToken(integrationId, stableFingerprint);
        await show(provider, singleIntegrationMap(integrationId, sameConfig));

        await fakePanel.onDidReceiveMessage({ type: 'save', integrationId, config: sameConfig });

        sinon.assert.neverCalledWith(tokenDeleteSpy, integrationId);
        assert.isTrue(tokens.has(integrationId));
    });

    test('onDidChangeTokens subscription survives panel close and reopen', async () => {
        const provider = buildProvider({ tokenStorage });
        const integrationId = 'bq-reopen';
        const integrations = singleIntegrationMap(integrationId, buildGoogleOauthIntegration({ id: integrationId }));

        // First open of the panel.
        await show(provider, integrations);
        assert.isAtLeast(fakePanel.posted.filter((m) => m.type === 'update').length, 1);

        // User closes panel: `onDidDispose` clears `this.disposables`; the token-change subscription must survive in a separate slot.
        fakePanel.triggerDispose();

        // Reopen with a brand-new fake panel; rebind the createWebviewPanel mock.
        fakePanel = createFakeWebviewPanel();
        when(
            mockedVSCodeNamespaces.window.createWebviewPanel(anyString(), anyString(), anything(), anything())
        ).thenReturn(fakePanel.panel);

        await show(provider, integrations);
        const updatesAfterReopen = fakePanel.posted.filter((m) => m.type === 'update').length;
        assert.isAtLeast(updatesAfterReopen, 1, 'reopened panel should receive an initial update');

        // Token change: if the subscription was lost on dispose, the webview wouldn't see an additional update.
        await tokenStorage.save({
            integrationId,
            refreshToken: 'r',
            metadataFingerprint: 'fp'
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const updatesAfterTokenChange = fakePanel.posted.filter((m) => m.type === 'update').length;
        assert.isAbove(
            updatesAfterTokenChange,
            updatesAfterReopen,
            'token-change after reopen should still trigger an update'
        );
    });

    test('updateWebview does not postMessage when panel is disposed during the tokenStorage.has() await', async () => {
        // `has()` returns a deferred so we can dispose the panel mid-update.
        let resolveHas: ((value: boolean) => void) | undefined;
        const deferredHasPromise = new Promise<boolean>((resolve) => {
            resolveHas = resolve;
        });
        const onDidChangeEmitter = new EventEmitter<string>();
        const slowTokenStorage: IFederatedAuthTokenStorage = {
            onDidChangeTokens: onDidChangeEmitter.event,
            async get() {
                return undefined;
            },
            has: () => deferredHasPromise,
            async save() {
                /* no-op */
            },
            async delete() {
                /* no-op */
            },
            computeMetadataFingerprint() {
                return 'fp';
            }
        };

        const provider = buildProvider({ tokenStorage: slowTokenStorage });
        const integrationId = 'bq-disposed-during-update';
        // Only candidates reach `deriveTokenStatus`, so the update parks on `has()` only if this id is one.
        federatedAuthCandidates.add(integrationId);
        const integrations = singleIntegrationMap(integrationId, buildGoogleOauthIntegration({ id: integrationId }));

        const allPostedMessages: CapturedMessage[] = [];
        fakePanel.setPostMessageImpl(async (message) => {
            allPostedMessages.push(message);
            return true;
        });

        // Fire `show()` without awaiting; it parks on `has()`.
        const showPromise = show(provider, integrations);

        // Yield so `show()` parks.
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Dispose mid-update — provider's onDidDispose sets `currentPanel = undefined`.
        fakePanel.triggerDispose();

        // Resolve `has()` so updateWebview finishes; the post-await guard must skip postMessage.
        resolveHas?.(false);
        await showPromise;
        onDidChangeEmitter.dispose();

        const updateMessages = allPostedMessages.filter((m) => m.type === 'update');
        assert.isEmpty(updateMessages, 'no `update` postMessage should be issued after the panel disposes mid-update');
    });

    suite('project integrations list update (via save message)', () => {
        async function callUpdateProjectIntegrationsList(provider: IntegrationWebviewProvider): Promise<void> {
            when(integrationStorage.save(anything())).thenResolve();

            const pgConfig = buildPostgresIntegration({ id: 'pg-1' });
            // `show()` seeds projectId + the integrations map; the `save` message drives the cache update through the real handler.
            await show(provider, singleIntegrationMap('pg-1', pgConfig));

            await fakePanel.onDidReceiveMessage({ type: 'save', integrationId: 'pg-1', config: pgConfig });
        }

        test('updates the cached project integrations via notebookManager.updateProjectIntegrations', async () => {
            const updateProjectIntegrationsSpy = sinon.spy((_projectId: string, _integrations: unknown[]) => true);
            when(notebookManager.updateProjectIntegrations(anyString(), anything())).thenCall(
                updateProjectIntegrationsSpy
            );

            const provider = buildProvider({ tokenStorage });
            await callUpdateProjectIntegrationsList(provider);

            sinon.assert.calledOnce(updateProjectIntegrationsSpy);
            sinon.assert.calledWith(updateProjectIntegrationsSpy, PROJECT_ID);
        });

        test('shows a "project not found" error when no cached entry was updated', async () => {
            const errors: string[] = [];
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall((msg: string) => {
                errors.push(msg);

                return Promise.resolve(undefined);
            });

            // updateProjectIntegrations returns false → no cached entry for the project → error.
            when(notebookManager.updateProjectIntegrations(anyString(), anything())).thenReturn(false);

            const provider = buildProvider({ tokenStorage });
            await callUpdateProjectIntegrationsList(provider);

            assert.strictEqual(
                errors.length,
                1,
                'project-not-found error should show when no cached entry was updated'
            );
        });
    });
});
