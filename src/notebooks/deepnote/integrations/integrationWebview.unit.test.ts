import { assert } from 'chai';
import sinon from 'sinon';
import { EventEmitter, Uri } from 'vscode';
import { anyString, anything, deepEqual, instance, mock, reset, resetCalls, verify, when } from 'ts-mockito';

import { ITelemetryService } from '../../../platform/analytics/types';
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
    integrations?: Array<{ id: string; config?: unknown; isFileConfigured?: boolean; tokenStatus?: string }>;
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
        options: {},
        asWebviewUri: (uri: Uri) => uri,
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
    const panel: import('vscode').WebviewPanel = {
        webview,
        viewType: '',
        title: '',
        options: {},
        viewColumn: 1,
        active: true,
        visible: true,
        onDidChangeViewState: function () {
            return this;
        },
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
        panel,
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
    let fileConfiguredIds: Set<string>;
    let onDidChangeEnvironmentVariables: EventEmitter<Resource>;
    let sqlIntegrationEnvVars: ISqlIntegrationEnvVarsProvider;
    let mockTelemetryService: ITelemetryService;
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
        mockTelemetryService = mock<ITelemetryService>();
        extensionSubscriptions = [];
        when(extensionContext.subscriptions).thenReturn(extensionSubscriptions);
        when(extensionContext.extensionUri).thenReturn(Uri.file('/ext'));

        // Federated-auth eligibility is derived state: the provider hands back ids only, never config.
        federatedAuthCandidates = new Set<string>();
        candidatesSpy = sinon.spy(async (_resource: Resource): Promise<ReadonlySet<string>> => federatedAuthCandidates);
        // Same shape for the `.deepnote.env.yaml` ids: read-only rows are derived from ids alone.
        fileConfiguredIds = new Set<string>();
        onDidChangeEnvironmentVariables = new EventEmitter<Resource>();
        sqlIntegrationEnvVars = {
            onDidChangeEnvironmentVariables: onDidChangeEnvironmentVariables.event,
            getEnvironmentVariables: async () => ({}),
            getFederatedAuthCandidates: candidatesSpy,
            getFileConfiguredIntegrationIds: async () => fileConfiguredIds,
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
            instance(mockTelemetryService),
            extensionSubscriptions,
            opts.sqlIntegrationEnvVars ?? sqlIntegrationEnvVars,
            opts.tokenStorage
        );
    }

    function singleIntegrationMap(
        id: string,
        config: ConfigurableDatabaseIntegrationConfig
    ): Map<string, DetectedIntegration> {
        return new Map([[id, { config, integrationName: config.name, integrationType: config.type }]]);
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

        test('a file-configured candidate keeps a real tokenStatus: read-only must not disable Authenticate', async () => {
            // BigQuery + `google-oauth` declared in `.deepnote.env.yaml`: the config is read-only, but the OAuth
            // token lives in SecretStorage, so authenticating is the one action the panel can still perform.
            // Deriving federated-auth visibility from `isFileConfigured` would break exactly this row.
            const integrationId = 'bq-file-configured-candidate';
            federatedAuthCandidates.add(integrationId);
            fileConfiguredIds.add(integrationId);

            const provider = buildProvider({ tokenStorage });
            await show(
                provider,
                new Map<string, DetectedIntegration>([
                    [integrationId, { config: null, integrationName: 'File BigQuery', integrationType: 'big-query' }]
                ])
            );

            const item = (lastUpdate().integrations || []).find((i) => i.id === integrationId);
            assert.isTrue(item?.isFileConfigured, 'the row is file-configured, hence read-only');
            assert.strictEqual(
                item?.tokenStatus,
                'disconnected',
                'a live token status must survive alongside `isFileConfigured`, or the Authenticate button disappears'
            );
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

    suite('configure_integration telemetry', () => {
        test('tracks when the form is opened directly via show() (SQL status bar entry point)', async () => {
            const provider = buildProvider({ tokenStorage });
            const id = 'pg-preselected';

            await provider.show(
                PROJECT_ID,
                singleIntegrationMap(id, buildPostgresIntegration({ id })),
                ACTIVE_FILE_URI,
                id
            );

            verify(
                mockTelemetryService.trackEvent(
                    deepEqual({ eventName: 'configure_integration', properties: { integrationType: 'pgsql' } })
                )
            ).once();
        });

        test('tracks the webview configure message exactly once, and not for an unknown id', async () => {
            const provider = buildProvider({ tokenStorage });
            const id = 'pg-configure';
            await show(provider, singleIntegrationMap(id, buildPostgresIntegration({ id })));
            resetCalls(mockTelemetryService);

            await fakePanel.onDidReceiveMessage({ type: 'configure', integrationId: id });
            await fakePanel.onDidReceiveMessage({ type: 'configure', integrationId: 'does-not-exist' });

            verify(
                mockTelemetryService.trackEvent(
                    deepEqual({ eventName: 'configure_integration', properties: { integrationType: 'pgsql' } })
                )
            ).once();
            verify(mockTelemetryService.trackEvent(anything())).once();
        });
    });

    test('updateWebview flags `.deepnote.env.yaml`-configured ids as read-only, others not', async () => {
        const fileConfig = buildPostgresIntegration({ id: 'pg-from-file' });
        const secretConfig = buildPostgresIntegration({ id: 'pg-from-secret-storage' });
        fileConfiguredIds.add(fileConfig.id);

        const provider = buildProvider({ tokenStorage });
        await show(
            provider,
            new Map<string, DetectedIntegration>([
                [fileConfig.id, { config: null, integrationName: fileConfig.name, integrationType: 'pgsql' }],
                [secretConfig.id, { config: secretConfig }]
            ])
        );

        const items = lastUpdate().integrations || [];
        assert.isTrue(
            items.find((i) => i.id === fileConfig.id)?.isFileConfigured,
            'a file-configured id must be marked read-only'
        );
        assert.isFalse(
            items.find((i) => i.id === secretConfig.id)?.isFileConfigured,
            'a SecretStorage-only id stays editable'
        );
    });

    test('a save for a file-configured id never reaches SecretStorage, whatever the webview sent', async () => {
        // Read-only is enforced here, not just rendered: the SQL status bar's "Configure current integration"
        // reaches `showConfigurationForm` directly, so a save can arrive for a row that has no Configure button.
        // Letting it through would report success and change nothing, since the file wins the merge.
        const integrationSaveSpy = sinon.spy();
        when(integrationStorage.save(anything())).thenCall(integrationSaveSpy);

        const config = buildPostgresIntegration({ id: 'pg-managed-by-file' });
        fileConfiguredIds.add(config.id);

        const provider = buildProvider({ tokenStorage });
        await show(provider, singleIntegrationMap(config.id, config));

        await fakePanel.onDidReceiveMessage({ type: 'save', integrationId: config.id, config });

        sinon.assert.notCalled(integrationSaveSpy);
        assert.isFalse(
            fakePanel.posted.some((message) => message.type === 'success'),
            'a refused edit must not be reported as saved'
        );
    });

    test('show() with a file-configured selectedIntegrationId opens no configuration form', async () => {
        // The SQL status bar's "Configure current integration" routes through `Commands.ManageIntegrations` and
        // lands on `showConfigurationForm` directly, so the panel's hidden Configure button never gets a say.
        const config = buildPostgresIntegration({ id: 'pg-file-form' });
        fileConfiguredIds.add(config.id);

        const provider = buildProvider({ tokenStorage });
        await provider.show(PROJECT_ID, singleIntegrationMap(config.id, config), ACTIVE_FILE_URI, config.id);

        assert.isFalse(
            fakePanel.posted.some((message) => message.type === 'showForm'),
            'an editable form must not open for an integration `.deepnote.env.yaml` owns'
        );
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

    suite('handleMessage: "authenticate" telemetry outcome', () => {
        async function authenticate(commandResult: Promise<unknown>): Promise<void> {
            when(mockedVSCodeNamespaces.commands.executeCommand(anyString(), anything(), anything())).thenReturn(
                commandResult
            );

            const provider = buildProvider({ tokenStorage });
            const integrationId = 'bq-auth-outcome';
            await show(
                provider,
                singleIntegrationMap(integrationId, buildGoogleOauthIntegration({ id: integrationId }))
            );
            resetCalls(mockTelemetryService);

            await fakePanel.onDidReceiveMessage({ type: 'authenticate', integrationId });
        }

        test('reports the outcome returned by the command, after it settles', async () => {
            await authenticate(Promise.resolve('cancelled'));

            verify(
                mockTelemetryService.trackEvent(
                    deepEqual({
                        eventName: 'authenticate_integration',
                        properties: { integrationType: 'big-query', outcome: 'cancelled' }
                    })
                )
            ).once();
            verify(mockTelemetryService.trackEvent(anything())).once();
        });

        test('reports failed when the command returns nothing (web stub / unexpected undefined)', async () => {
            await authenticate(Promise.resolve(undefined));

            verify(
                mockTelemetryService.trackEvent(
                    deepEqual({
                        eventName: 'authenticate_integration',
                        properties: { integrationType: 'big-query', outcome: 'failed' }
                    })
                )
            ).once();
            verify(mockTelemetryService.trackEvent(anything())).once();
        });

        test('reports failed when the command rejects', async () => {
            const rejection = Promise.reject(new Error('boom'));
            rejection.catch(() => undefined); // avoid an unhandled-rejection warning before the handler awaits it

            await authenticate(rejection);

            verify(
                mockTelemetryService.trackEvent(
                    deepEqual({
                        eventName: 'authenticate_integration',
                        properties: { integrationType: 'big-query', outcome: 'failed' }
                    })
                )
            ).once();
            verify(mockTelemetryService.trackEvent(anything())).once();
        });
    });

    suite('handleMessage: "save" telemetry authMethod', () => {
        async function save(config: ConfigurableDatabaseIntegrationConfig): Promise<void> {
            when(integrationStorage.save(anything())).thenResolve();

            const provider = buildProvider({ tokenStorage });
            await show(provider, singleIntegrationMap(config.id, config));
            resetCalls(mockTelemetryService);

            await fakePanel.onDidReceiveMessage({ type: 'save', integrationId: config.id, config });
        }

        test('reports authMethod google-oauth for an OAuth BigQuery config', async () => {
            await save(buildGoogleOauthIntegration({ id: 'bq-save-oauth' }));

            verify(
                mockTelemetryService.trackEvent(
                    deepEqual({
                        eventName: 'save_integration',
                        properties: { integrationType: 'big-query', authMethod: 'google-oauth' }
                    })
                )
            ).once();
            verify(mockTelemetryService.trackEvent(anything())).once();
        });

        test('reports authMethod service-account for a legacy BigQuery config that omits authMethod', async () => {
            const config = buildServiceAccountIntegration({ id: 'bq-save-legacy' });
            delete (config.metadata as { authMethod?: string }).authMethod;

            await save(config);

            verify(
                mockTelemetryService.trackEvent(
                    deepEqual({
                        eventName: 'save_integration',
                        properties: { integrationType: 'big-query', authMethod: 'service-account' }
                    })
                )
            ).once();
            verify(mockTelemetryService.trackEvent(anything())).once();
        });

        test('omits authMethod for non-BigQuery configs', async () => {
            await save(buildPostgresIntegration({ id: 'pg-save' }));

            verify(
                mockTelemetryService.trackEvent(
                    deepEqual({ eventName: 'save_integration', properties: { integrationType: 'pgsql' } })
                )
            ).once();
            verify(mockTelemetryService.trackEvent(anything())).once();
        });
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

        test(`${messageType}Configuration: a failed token delete aborts before the config is removed`, async () => {
            when(integrationStorage.delete(anyString())).thenResolve();

            const provider = buildProvider({
                tokenStorage: {
                    ...tokenStorage,
                    delete: async () => {
                        throw new Error('keychain unavailable');
                    }
                }
            });
            const integrationId = `bq-${messageType}-fails`;
            preStoreToken(integrationId);

            await show(
                provider,
                singleIntegrationMap(integrationId, buildGoogleOauthIntegration({ id: integrationId }))
            );
            await fakePanel.onDidReceiveMessage({ type: messageType, integrationId });

            // Nothing is committed, so the integration stays in the panel for the user to retry from.
            verify(integrationStorage.delete(integrationId)).never();
            assert.isTrue(
                fakePanel.posted.some((message) => message.type === 'error'),
                'the failure must reach the panel'
            );
            assert.isFalse(
                fakePanel.posted.some((message) => message.type === 'success'),
                'a partial failure must not be reported as success'
            );
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
        });

        await fakePanel.onDidReceiveMessage({ type: 'save', integrationId, config: newConfig });

        sinon.assert.calledOnce(tokenDeleteSpy);
        sinon.assert.calledOnce(integrationSaveSpy);
        assert.isTrue(tokenDeleteSpy.calledBefore(integrationSaveSpy), 'token.delete must occur BEFORE storage.save');
    });

    test('saveConfiguration: a failed token invalidation aborts the save', async () => {
        const integrationId = 'bq-save-fails';
        const integrationSaveSpy = sinon.spy();
        when(integrationStorage.save(anything())).thenCall(integrationSaveSpy);

        const provider = buildProvider({
            tokenStorage: {
                ...tokenStorage,
                delete: async () => {
                    throw new Error('keychain unavailable');
                }
            }
        });
        preStoreToken(integrationId, 'old-fingerprint');
        await show(provider, singleIntegrationMap(integrationId, buildGoogleOauthIntegration({ id: integrationId })));

        const newConfig = buildGoogleOauthIntegration({
            id: integrationId,
            name: 'New name',
            metadata: {
                authMethod: 'google-oauth',
                project: 'new-proj',
                clientId: 'new-client',
                clientSecret: 'new-secret'
            }
        });

        await fakePanel.onDidReceiveMessage({ type: 'save', integrationId, config: newConfig });

        // Saving anyway would pair the new client's config with a token issued against the old one.
        sinon.assert.notCalled(integrationSaveSpy);
        assert.isTrue(
            fakePanel.posted.some((message) => message.type === 'error'),
            'the failure must reach the panel'
        );
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
