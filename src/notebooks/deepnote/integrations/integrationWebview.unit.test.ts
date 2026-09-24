import { deserializeDeepnoteFile, serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { assert } from 'chai';
import sinon from 'sinon';
import { EventEmitter, Uri, workspace } from 'vscode';
import { anyString, anything, deepEqual, instance, mock, reset, resetCalls, verify, when } from 'ts-mockito';

import { ITelemetryService } from '../../../platform/analytics/types';
import { IExtensionContext, IDisposable, Resource } from '../../../platform/common/types';
import { Commands } from '../../../platform/common/constants';
import { Integrations } from '../../../platform/common/utils/localize';
import { ISqlIntegrationEnvVarsProvider } from '../../../platform/notebooks/deepnote/types';
import { IDeepnoteNotebookManager, RawProjectIntegration } from '../../types';
import {
    createDeepnoteFile,
    createDeepnoteProject,
    createMockNotebook,
    createWorkspaceFolder
} from '../deepnoteTestHelpers';
import { IntegrationWebviewProvider } from './integrationWebview';
import {
    FederatedAuthTokenEntry,
    IFederatedAuthTokenStorage,
    IIntegrationEnvLiveRefresher,
    IIntegrationStorage
} from './types';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';
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

type RefreshFn = IIntegrationEnvLiveRefresher['refresh'];

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
    /** Merged configs the panel reads to fingerprint OAuth metadata; empty unless a test opts in. */
    let mergedIntegrationConfigs: DatabaseIntegrationConfig[];
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
            getMergedIntegrationConfigs: async () => mergedIntegrationConfigs
        };
        mergedIntegrationConfigs = [];

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
            liveRefresher?: IIntegrationEnvLiveRefresher;
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
            opts.tokenStorage,
            opts.liveRefresher
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

    function projectFile(projectId: string, name: string, integrations: RawProjectIntegration[]): DeepnoteFile {
        return createDeepnoteFile({ project: createDeepnoteProject({ id: projectId, name, integrations }) });
    }

    /** Serves `files` through `workspace.fs` and `/ws` file discovery; returns what the panel writes, by path. */
    function stubProjectFiles(files: Array<{ file: DeepnoteFile; uri: Uri }>): Map<string, DeepnoteFile> {
        const onDisk = new Map(files.map(({ file, uri }) => [uri.fsPath, file] as const));
        const discovered = files.map(({ uri }) => uri);
        const writes = new Map<string, DeepnoteFile>();

        when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([createWorkspaceFolder(Uri.file('/ws'))]);
        when(mockedVSCodeNamespaces.workspace.findFiles(anything(), anything(), anything(), anything())).thenReturn(
            Promise.resolve(discovered)
        );
        // The writer enumerates without a token; the scan passes one.
        when(mockedVSCodeNamespaces.workspace.findFiles(anything())).thenReturn(Promise.resolve(discovered));

        const mockFs = mock<typeof workspace.fs>();

        when(mockFs.readFile(anything())).thenCall((uri: Uri) => {
            const file = onDisk.get(uri.fsPath);

            return file
                ? Promise.resolve(new TextEncoder().encode(serializeDeepnoteFile(file)))
                : Promise.reject(new Error(`no readFile stub for ${uri.fsPath}`));
        });
        when(mockFs.writeFile(anything(), anything())).thenCall((uri: Uri, bytes: Uint8Array) => {
            writes.set(uri.fsPath, deserializeDeepnoteFile(new TextDecoder().decode(bytes)));

            return Promise.resolve();
        });
        when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

        return writes;
    }

    function successMessages(): CapturedMessage[] {
        return fakePanel.posted.filter((message) => message.type === 'success');
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

        test('a candidate whose stored fingerprint no longer matches the current metadata reports disconnected', async () => {
            // The user edited clientId in `.deepnote.env.yaml`. The stored token was issued against the old
            // client, so generated code will reject it on the next run — the panel must not claim "Authenticated".
            const config = buildGoogleOauthIntegration({ id: 'bq-rotated-client' });
            federatedAuthCandidates.add(config.id);
            mergedIntegrationConfigs = [config as DatabaseIntegrationConfig];
            preStoreToken(config.id, 'fingerprint-of-the-previous-oauth-client');

            const provider = buildProvider({ tokenStorage });
            await show(provider, singleIntegrationMap(config.id, config));

            const item = (lastUpdate().integrations || []).find((i) => i.id === config.id);
            assert.strictEqual(item?.tokenStatus, 'disconnected');
        });

        test('a candidate whose stored fingerprint matches the current metadata reports authenticated', async () => {
            const config = buildGoogleOauthIntegration({ id: 'bq-current-client' });
            federatedAuthCandidates.add(config.id);
            mergedIntegrationConfigs = [config as DatabaseIntegrationConfig];
            const { clientId, clientSecret, project } = config.metadata as {
                clientId: string;
                clientSecret: string;
                project: string;
            };
            preStoreToken(config.id, computeMetadataFingerprint({ clientId, clientSecret, project }));

            const provider = buildProvider({ tokenStorage });
            await show(provider, singleIntegrationMap(config.id, config));

            const item = (lastUpdate().integrations || []).find((i) => i.id === config.id);
            assert.strictEqual(item?.tokenStatus, 'authenticated');
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

    test('handleMessage: "signOut" clears the token even for a file-configured integration', async () => {
        // reset/delete are refused for file rows because the panel writes SecretStorage and the file wins the
        // merge. The token store has no file layer, so signing out must still work — otherwise a refresh token
        // minted for a `.deepnote.env.yaml` integration can never be removed.
        const integrationSaveSpy = sinon.spy();
        when(integrationStorage.save(anything())).thenCall(integrationSaveSpy);
        when(integrationStorage.delete(anyString())).thenResolve();

        const config = buildGoogleOauthIntegration({ id: 'bq-file-only' });
        fileConfiguredIds.add(config.id);
        federatedAuthCandidates.add(config.id);

        const provider = buildProvider({ tokenStorage });
        preStoreToken(config.id);
        await show(provider, singleIntegrationMap(config.id, config));

        await fakePanel.onDidReceiveMessage({ type: 'signOut', integrationId: config.id });

        sinon.assert.calledWith(tokenDeleteSpy, config.id);
        verify(integrationStorage.delete(config.id)).never();
        sinon.assert.notCalled(integrationSaveSpy);
    });

    (['reset', 'delete'] as const).forEach((messageType) => {
        test(`handleMessage: "${messageType}" for a file-configured id touches neither storage`, async () => {
            when(integrationStorage.delete(anyString())).thenResolve();

            const config = buildGoogleOauthIntegration({ id: `bq-file-${messageType}` });
            fileConfiguredIds.add(config.id);

            const provider = buildProvider({ tokenStorage });
            preStoreToken(config.id);
            await show(provider, singleIntegrationMap(config.id, config));

            await fakePanel.onDidReceiveMessage({ type: messageType, integrationId: config.id });

            verify(integrationStorage.delete(config.id)).never();
            sinon.assert.notCalled(tokenDeleteSpy);
        });
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

    test('handleMessage: "addExisting" → executeCommand(AddExistingIntegration, { notebookUri }) for the active file', async () => {
        const executeCommandStub = sinon.stub().resolves(undefined);
        when(mockedVSCodeNamespaces.commands.executeCommand(anyString(), anything())).thenCall((command, arg) =>
            executeCommandStub(command, arg)
        );

        const provider = buildProvider();
        await show(provider, new Map());

        await fakePanel.onDidReceiveMessage({ type: 'addExisting' });

        assert.isTrue(
            executeCommandStub.calledOnceWithExactly(Commands.AddExistingIntegration, {
                notebookUri: ACTIVE_FILE_URI.toString()
            }),
            "expected the command to receive the panel's active notebook so the picker targets the same project"
        );
    });

    suite('refresh', () => {
        const PG_CONFIG = buildPostgresIntegration({ id: 'pg-1', name: 'Team Postgres' });
        const LINKED_CONFIG = buildPostgresIntegration({ id: 'pg-linked', name: 'Linked Postgres' });

        function linkedMap(): Map<string, DetectedIntegration> {
            return new Map([
                ...singleIntegrationMap(PG_CONFIG.id, PG_CONFIG),
                ...singleIntegrationMap(LINKED_CONFIG.id, LINKED_CONFIG)
            ]);
        }

        test('opens no panel when none is open', async () => {
            // Catches: a refresh after a command-palette run opening the panel and taking focus from the notebook.
            await buildProvider().refresh(PROJECT_ID, linkedMap());

            verify(
                mockedVSCodeNamespaces.window.createWebviewPanel(anything(), anything(), anything(), anything())
            ).never();
        });

        test('re-renders an open panel of the project with the new list, without revealing it', async () => {
            const provider = buildProvider();
            await show(provider, singleIntegrationMap(PG_CONFIG.id, PG_CONFIG));
            const reveal = sinon.spy();
            fakePanel.panel.reveal = reveal;

            await provider.refresh(PROJECT_ID, linkedMap());

            assert.deepStrictEqual(lastUpdate().integrations?.map((integration) => integration.id), [
                'pg-1',
                'pg-linked'
            ]);
            sinon.assert.notCalled(reveal);
        });

        test('leaves a panel that shows another project alone', async () => {
            const provider = buildProvider();
            await show(provider, singleIntegrationMap(PG_CONFIG.id, PG_CONFIG));
            const postedBefore = fakePanel.posted.length;

            await provider.refresh('project-other', linkedMap());

            assert.strictEqual(fakePanel.posted.length, postedBefore);
        });
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

    suite('deleteConfiguration', () => {
        const ALPHA_URI = Uri.file('/ws/alpha.deepnote');
        const SHARED_CONFIG = buildPostgresIntegration({ id: 'pg-shared', name: 'Shared Postgres' });
        const SHARED_ENTRY: RawProjectIntegration = {
            id: SHARED_CONFIG.id,
            name: SHARED_CONFIG.name,
            type: SHARED_CONFIG.type
        };

        let refreshSpy: sinon.SinonSpy<Parameters<RefreshFn>, ReturnType<RefreshFn>>;
        let writes: Map<string, DeepnoteFile>;

        setup(() => {
            refreshSpy = sinon.spy<RefreshFn>(async () => undefined);
            when(integrationStorage.delete(anyString())).thenResolve();
            preStoreToken(SHARED_CONFIG.id);
        });

        /** This project's active file declares `pg-shared`; `/ws/alpha.deepnote` holds project-alpha ("Alpha"). */
        function stubActiveAndAlphaFiles(alphaIntegrations: RawProjectIntegration[]): void {
            writes = stubProjectFiles([
                { file: projectFile(PROJECT_ID, 'Active', [SHARED_ENTRY]), uri: ACTIVE_FILE_URI },
                { file: projectFile('project-alpha', 'Alpha', alphaIntegrations), uri: ALPHA_URI }
            ]);
        }

        async function deleteSharedIntegration(): Promise<void> {
            const provider = buildProvider({ liveRefresher: { refresh: refreshSpy }, tokenStorage });

            await show(provider, singleIntegrationMap(SHARED_CONFIG.id, SHARED_CONFIG));

            await fakePanel.onDidReceiveMessage({ type: 'delete', integrationId: SHARED_CONFIG.id });
        }

        test('takes an integration another project declares off this project and keeps its credentials', async () => {
            // Catches: deleting a linked integration wipes the credentials another project still uses.
            stubActiveAndAlphaFiles([SHARED_ENTRY]);

            await deleteSharedIntegration();

            verify(integrationStorage.delete(anything())).never();
            sinon.assert.notCalled(tokenDeleteSpy);
            assert.deepStrictEqual(writes.get(ACTIVE_FILE_URI.fsPath)?.project.integrations, []);
            assert.isFalse(writes.has(ALPHA_URI.fsPath), "Alpha's file must not be rewritten");
            assert.deepStrictEqual(successMessages(), [
                { message: Integrations.integrationUnlinked('Alpha'), type: 'success' }
            ]);
        });

        test("refreshes only this project's kernels after taking a shared integration off it", async () => {
            // Catches: an unlink fires no storage event, so this project's running kernels keep the removed
            // integration's env.
            stubActiveAndAlphaFiles([SHARED_ENTRY]);
            const activeNotebook = createMockNotebook({
                uri: ACTIVE_FILE_URI,
                metadata: { deepnoteProjectId: PROJECT_ID }
            });
            const alphaNotebook = createMockNotebook({
                uri: ALPHA_URI,
                metadata: { deepnoteProjectId: 'project-alpha' }
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([activeNotebook, alphaNotebook]);

            await deleteSharedIntegration();

            sinon.assert.calledOnceWithExactly(refreshSpy, [activeNotebook], 'integration_config');
        });

        test('deletes the credentials of an integration no other project declares', async () => {
            // Catches: an over-broad guard never deletes credentials, so they leak.
            stubActiveAndAlphaFiles([{ id: 'pg-other', name: 'Other Postgres', type: 'pgsql' }]);

            await deleteSharedIntegration();

            verify(integrationStorage.delete(SHARED_CONFIG.id)).once();
            sinon.assert.calledOnceWithExactly(tokenDeleteSpy, SHARED_CONFIG.id);
            assert.deepStrictEqual(successMessages(), [
                { message: 'Integration deleted successfully', type: 'success' }
            ]);
            sinon.assert.notCalled(refreshSpy);
        });
    });

    suite('project file edits', () => {
        const PG_CONFIG = buildPostgresIntegration({ id: 'pg-1', name: 'Team Postgres' });
        const PG_ENTRY: RawProjectIntegration = { id: PG_CONFIG.id, name: PG_CONFIG.name, type: PG_CONFIG.type };
        // The panel lists none of these: one was linked after it opened, and it cannot configure the other types.
        const UNLISTED: RawProjectIntegration[] = [
            { id: 'pg-linked', name: 'Linked Postgres', type: 'pgsql' },
            { id: 'duckdb', name: 'DuckDB', type: 'pandas-dataframe' },
            { id: 'future', name: 'Unknown to this build', type: 'some-future-type' }
        ];

        let refreshSpy: sinon.SinonSpy<Parameters<RefreshFn>, ReturnType<RefreshFn>>;
        let writes: Map<string, DeepnoteFile>;

        setup(() => {
            refreshSpy = sinon.spy<RefreshFn>(async () => undefined);
            when(integrationStorage.save(anything())).thenResolve();
            when(integrationStorage.delete(anyString())).thenResolve();
            writes = stubProjectFiles([
                { file: projectFile(PROJECT_ID, 'Active', [PG_ENTRY, ...UNLISTED]), uri: ACTIVE_FILE_URI }
            ]);
        });

        async function showPanelListingOnly(config: ConfigurableDatabaseIntegrationConfig): Promise<void> {
            const provider = buildProvider({ liveRefresher: { refresh: refreshSpy }, tokenStorage });

            await show(provider, singleIntegrationMap(config.id, config));
        }

        test('a save rewrites the saved entry in place and keeps every entry the panel does not list', async () => {
            // Catches: the panel's own list stamped over the file, deleting what it never listed.
            await showPanelListingOnly(PG_CONFIG);
            const renamed = { ...PG_CONFIG, name: 'Renamed Postgres' };

            await fakePanel.onDidReceiveMessage({ type: 'save', integrationId: renamed.id, config: renamed });

            assert.deepStrictEqual(writes.get(ACTIVE_FILE_URI.fsPath)?.project.integrations, [
                { id: 'pg-1', name: 'Renamed Postgres', type: 'pgsql' },
                ...UNLISTED
            ]);
        });

        test('a delete takes only the deleted entry off the file', async () => {
            await showPanelListingOnly(PG_CONFIG);

            await fakePanel.onDidReceiveMessage({ type: 'delete', integrationId: PG_CONFIG.id });

            assert.deepStrictEqual(writes.get(ACTIVE_FILE_URI.fsPath)?.project.integrations, UNLISTED);
        });

        test('a reset clears the credentials and leaves the project file alone', async () => {
            await showPanelListingOnly(PG_CONFIG);

            await fakePanel.onDidReceiveMessage({ type: 'reset', integrationId: PG_CONFIG.id });

            verify(integrationStorage.delete(PG_CONFIG.id)).once();
            assert.strictEqual(writes.size, 0);
            assert.deepStrictEqual(successMessages(), [
                { message: 'Configuration reset successfully', type: 'success' }
            ]);
        });

        test("a save refreshes this project's kernels once the file declares the saved integration", async () => {
            // Catches: the refresh the credential save triggers reading the list before it holds a new integration,
            // with nothing refreshing the kernels again once it does.
            const activeNotebook = createMockNotebook({
                metadata: { deepnoteProjectId: PROJECT_ID },
                uri: ACTIVE_FILE_URI
            });
            const added = buildPostgresIntegration({ id: 'pg-new', name: 'New Postgres' });
            let declaredAtRefresh: RawProjectIntegration[] | undefined;

            refreshSpy = sinon.spy<RefreshFn>(async () => {
                declaredAtRefresh = writes.get(ACTIVE_FILE_URI.fsPath)?.project.integrations;
            });
            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([activeNotebook]);
            await showPanelListingOnly(PG_CONFIG);

            await fakePanel.onDidReceiveMessage({ type: 'save', integrationId: added.id, config: added });

            sinon.assert.calledOnceWithExactly(refreshSpy, [activeNotebook], 'integration_config');
            assert.deepStrictEqual(declaredAtRefresh, [
                PG_ENTRY,
                ...UNLISTED,
                { id: 'pg-new', name: 'New Postgres', type: 'pgsql' }
            ]);
        });
    });

    suite('credentials another project shares', () => {
        const ALPHA_URI = Uri.file('/ws/alpha.deepnote');
        const SHARED_CONFIG = buildGoogleOauthIntegration({ id: 'bq-shared', name: 'Shared BigQuery' });
        const SHARED_ENTRY: RawProjectIntegration = {
            id: SHARED_CONFIG.id,
            name: SHARED_CONFIG.name,
            type: SHARED_CONFIG.type
        };

        setup(() => {
            when(integrationStorage.save(anything())).thenResolve();
            when(integrationStorage.delete(anyString())).thenResolve();
            preStoreToken(SHARED_CONFIG.id);
        });

        /** This project's active file declares `bq-shared`; `/ws/alpha.deepnote` holds project-alpha ("Alpha"). */
        async function showSharedIntegration(alphaIntegrations: RawProjectIntegration[]): Promise<void> {
            stubProjectFiles([
                { file: projectFile(PROJECT_ID, 'Active', [SHARED_ENTRY]), uri: ACTIVE_FILE_URI },
                { file: projectFile('project-alpha', 'Alpha', alphaIntegrations), uri: ALPHA_URI }
            ]);

            await show(buildProvider({ tokenStorage }), singleIntegrationMap(SHARED_CONFIG.id, SHARED_CONFIG));
        }

        test('a reset still clears shared credentials, and names the projects that lose them', async () => {
            await showSharedIntegration([SHARED_ENTRY]);

            await fakePanel.onDidReceiveMessage({ type: 'reset', integrationId: SHARED_CONFIG.id });

            verify(integrationStorage.delete(SHARED_CONFIG.id)).once();
            sinon.assert.calledOnceWithExactly(tokenDeleteSpy, SHARED_CONFIG.id);
            assert.deepStrictEqual(successMessages(), [
                { message: Integrations.integrationResetShared('Alpha'), type: 'success' }
            ]);
        });

        test('a sign-out names the projects signed out along with this one', async () => {
            await showSharedIntegration([SHARED_ENTRY]);

            await fakePanel.onDidReceiveMessage({ type: 'signOut', integrationId: SHARED_CONFIG.id });

            sinon.assert.calledOnceWithExactly(tokenDeleteSpy, SHARED_CONFIG.id);
            assert.deepStrictEqual(successMessages(), [
                { message: Integrations.integrationSignedOutShared('Alpha'), type: 'success' }
            ]);
        });

        test('a sign-out no other project shares posts no message', async () => {
            await showSharedIntegration([]);

            await fakePanel.onDidReceiveMessage({ type: 'signOut', integrationId: SHARED_CONFIG.id });

            sinon.assert.calledOnceWithExactly(tokenDeleteSpy, SHARED_CONFIG.id);
            assert.deepStrictEqual(successMessages(), []);
        });

        test('a save of shared credentials names the projects it also changes them for', async () => {
            await showSharedIntegration([SHARED_ENTRY]);
            const changed = { ...SHARED_CONFIG, name: 'Renamed BigQuery' };

            await fakePanel.onDidReceiveMessage({ type: 'save', integrationId: changed.id, config: changed });

            assert.deepStrictEqual(successMessages(), [
                { message: Integrations.integrationSavedShared('Alpha'), type: 'success' }
            ]);
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

    test('updateWebview does not postMessage when panel is disposed during the token lookup await', async () => {
        // `get()` returns a deferred so we can dispose the panel mid-update.
        let resolveGet: ((value: FederatedAuthTokenEntry | undefined) => void) | undefined;
        const deferredGetPromise = new Promise<FederatedAuthTokenEntry | undefined>((resolve) => {
            resolveGet = resolve;
        });
        const onDidChangeEmitter = new EventEmitter<string>();
        const slowTokenStorage: IFederatedAuthTokenStorage = {
            onDidChangeTokens: onDidChangeEmitter.event,
            get: () => deferredGetPromise,
            async has() {
                return false;
            },
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
        // Only candidates reach `deriveTokenStatus`, so the update parks on `get()` only if this id is one.
        federatedAuthCandidates.add(integrationId);
        const integrations = singleIntegrationMap(integrationId, buildGoogleOauthIntegration({ id: integrationId }));

        const allPostedMessages: CapturedMessage[] = [];
        fakePanel.setPostMessageImpl(async (message) => {
            allPostedMessages.push(message);
            return true;
        });

        // Fire `show()` without awaiting; it parks on `get()`.
        const showPromise = show(provider, integrations);

        // Yield so `show()` parks.
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Dispose mid-update — provider's onDidDispose sets `currentPanel = undefined`.
        fakePanel.triggerDispose();

        // Resolve `get()` so updateWebview finishes; the post-await guard must skip postMessage.
        resolveGet?.(undefined);
        await showPromise;
        onDidChangeEmitter.dispose();

        const updateMessages = allPostedMessages.filter((m) => m.type === 'update');
        assert.isEmpty(updateMessages, 'no `update` postMessage should be issued after the panel disposes mid-update');
    });

    test('a save that cannot update the notebook file says so instead of reporting success', async () => {
        const errors: string[] = [];
        when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall((msg: string) => {
            errors.push(msg);

            return Promise.resolve(undefined);
        });
        when(integrationStorage.save(anything())).thenResolve();
        // No file is served, so the active one cannot be read, let alone rewritten.
        stubProjectFiles([]);

        const provider = buildProvider({ tokenStorage });
        const pgConfig = buildPostgresIntegration({ id: 'pg-1' });
        await show(provider, singleIntegrationMap('pg-1', pgConfig));

        await fakePanel.onDidReceiveMessage({ type: 'save', integrationId: 'pg-1', config: pgConfig });

        assert.deepStrictEqual(errors, ['Failed to save integrations to the notebook file. Please try again.']);
        assert.deepStrictEqual(successMessages(), []);
    });
});
