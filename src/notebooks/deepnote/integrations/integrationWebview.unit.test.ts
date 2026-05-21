import { assert } from 'chai';
import sinon from 'sinon';
import { EventEmitter, Uri } from 'vscode';
import { anyString, anything, capture, instance, mock, reset, verify, when } from 'ts-mockito';

import { IExtensionContext, IDisposable } from '../../../platform/common/types';
import { Commands } from '../../../platform/common/constants';
import { IDeepnoteNotebookManager } from '../../types';
import { IntegrationWebviewProvider } from './integrationWebview';
import { FederatedAuthTokenEntry, IFederatedAuthTokenStorage, IIntegrationStorage } from './types';
import {
    ConfigurableDatabaseIntegrationConfig,
    IntegrationStatus,
    IntegrationWithStatus
} from '../../../platform/notebooks/deepnote/integrationTypes';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';

// Minimal in-memory token-storage stub for tests. Mirrors the real
// FederatedAuthTokenStorage interface enough to drive
// IntegrationWebviewProvider's federated-auth code paths without pulling in
// the node-only implementation file.
function createFakeTokenStorage(): {
    storage: IFederatedAuthTokenStorage;
    tokens: Map<string, FederatedAuthTokenEntry>;
    fingerprintForTest: (metadata: { clientId: string; clientSecret: string; project: string }) => string;
    deletedIds: string[];
    onDidChangeEmitter: EventEmitter<string>;
} {
    const tokens = new Map<string, FederatedAuthTokenEntry>();
    const deletedIds: string[] = [];
    const onDidChangeEmitter = new EventEmitter<string>();
    const fingerprintForTest = (m: { clientId: string; clientSecret: string; project: string }): string =>
        `${m.clientId}|${m.clientSecret}|${m.project}`;
    const storage: IFederatedAuthTokenStorage = {
        onDidChangeTokens: onDidChangeEmitter.event,
        async get(integrationId: string) {
            return tokens.get(integrationId);
        },
        async has(integrationId: string) {
            return tokens.has(integrationId);
        },
        async save(entry: FederatedAuthTokenEntry) {
            tokens.set(entry.integrationId, entry);
            onDidChangeEmitter.fire(entry.integrationId);
        },
        async delete(integrationId: string) {
            const had = tokens.delete(integrationId);
            deletedIds.push(integrationId);
            if (had) {
                onDidChangeEmitter.fire(integrationId);
            }
        },
        computeMetadataFingerprint(metadata) {
            return fingerprintForTest(metadata);
        }
    };
    return { storage, tokens, fingerprintForTest, deletedIds, onDidChangeEmitter };
}

interface CapturedMessage {
    type: string;
    integrations?: Array<{ id: string; tokenStatus?: string }>;
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
    const PROJECT_ID = 'project-id-1';

    let extensionContext: IExtensionContext;
    let integrationStorage: IIntegrationStorage;
    let notebookManager: IDeepnoteNotebookManager;
    let fakeTokenStorage: ReturnType<typeof createFakeTokenStorage>;
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

        fakeTokenStorage = createFakeTokenStorage();
        fakePanel = createFakeWebviewPanel();

        when(
            mockedVSCodeNamespaces.window.createWebviewPanel(anyString(), anyString(), anything(), anything())
        ).thenReturn(fakePanel.panel);
    });

    teardown(() => {
        reset(mockedVSCodeNamespaces.window);
        reset(mockedVSCodeNamespaces.commands);
    });

    function makeBigQueryGoogleOauthConfig(id: string): ConfigurableDatabaseIntegrationConfig {
        return {
            id,
            name: 'My BQ',
            type: 'big-query',
            metadata: {
                authMethod: 'google-oauth',
                project: 'proj',
                clientId: 'client-id',
                clientSecret: 'client-secret'
            }
        } as ConfigurableDatabaseIntegrationConfig;
    }

    function makeBigQueryServiceAccountConfig(id: string): ConfigurableDatabaseIntegrationConfig {
        return {
            id,
            name: 'My SA BQ',
            type: 'big-query',
            metadata: { authMethod: 'service-account', service_account: '{}' }
        } as ConfigurableDatabaseIntegrationConfig;
    }

    function makePostgresConfig(id: string): ConfigurableDatabaseIntegrationConfig {
        return {
            id,
            name: 'My PG',
            type: 'pgsql',
            metadata: {
                host: 'localhost',
                port: '5432',
                database: 'db',
                user: 'u',
                password: 'p',
                sslEnabled: false
            }
        } as ConfigurableDatabaseIntegrationConfig;
    }

    async function show(provider: IntegrationWebviewProvider, integrations: Map<string, IntegrationWithStatus>) {
        await provider.show(PROJECT_ID, integrations);
    }

    test('updateWebview: tokenStatus is "unsupported" for every integration when tokenStorage is undefined', async () => {
        const provider = new IntegrationWebviewProvider(
            instance(extensionContext),
            instance(integrationStorage),
            instance(notebookManager)
        );

        const integrations: Map<string, IntegrationWithStatus> = new Map([
            ['bq-1', { config: makeBigQueryGoogleOauthConfig('bq-1'), status: IntegrationStatus.Connected }],
            ['pg-1', { config: makePostgresConfig('pg-1'), status: IntegrationStatus.Connected }]
        ]);

        await show(provider, integrations);

        const updates = fakePanel.posted.filter((m) => m.type === 'update');
        assert.isNotEmpty(updates);
        const last = updates[updates.length - 1];
        assert.lengthOf(last.integrations || [], 2);
        for (const integration of last.integrations || []) {
            assert.strictEqual(integration.tokenStatus, 'unsupported');
        }
    });

    test('updateWebview: tokenStatus is "unsupported" for service-account BigQuery and Postgres', async () => {
        const provider = new IntegrationWebviewProvider(
            instance(extensionContext),
            instance(integrationStorage),
            instance(notebookManager),
            fakeTokenStorage.storage
        );

        const integrations: Map<string, IntegrationWithStatus> = new Map([
            ['bq-sa', { config: makeBigQueryServiceAccountConfig('bq-sa'), status: IntegrationStatus.Connected }],
            ['pg-1', { config: makePostgresConfig('pg-1'), status: IntegrationStatus.Connected }]
        ]);

        await show(provider, integrations);

        const last = fakePanel.posted.filter((m) => m.type === 'update').pop()!;
        const byId = new Map((last.integrations || []).map((i) => [i.id, i.tokenStatus]));
        assert.strictEqual(byId.get('bq-sa'), 'unsupported');
        assert.strictEqual(byId.get('pg-1'), 'unsupported');
    });

    test('updateWebview: BigQuery + google-oauth + stored token -> tokenStatus "authenticated"', async () => {
        const integrationId = 'bq-1';
        fakeTokenStorage.tokens.set(integrationId, {
            integrationId,
            refreshToken: 'r',
            metadataFingerprint: 'whatever'
        });
        const provider = new IntegrationWebviewProvider(
            instance(extensionContext),
            instance(integrationStorage),
            instance(notebookManager),
            fakeTokenStorage.storage
        );

        const integrations: Map<string, IntegrationWithStatus> = new Map([
            [
                integrationId,
                { config: makeBigQueryGoogleOauthConfig(integrationId), status: IntegrationStatus.Connected }
            ]
        ]);

        await show(provider, integrations);

        const last = fakePanel.posted.filter((m) => m.type === 'update').pop()!;
        const item = (last.integrations || []).find((i) => i.id === integrationId);
        assert.strictEqual(item?.tokenStatus, 'authenticated');
    });

    test('updateWebview: BigQuery + google-oauth + no stored token -> tokenStatus "disconnected"', async () => {
        const integrationId = 'bq-2';
        const provider = new IntegrationWebviewProvider(
            instance(extensionContext),
            instance(integrationStorage),
            instance(notebookManager),
            fakeTokenStorage.storage
        );

        const integrations: Map<string, IntegrationWithStatus> = new Map([
            [
                integrationId,
                { config: makeBigQueryGoogleOauthConfig(integrationId), status: IntegrationStatus.Connected }
            ]
        ]);

        await show(provider, integrations);

        const last = fakePanel.posted.filter((m) => m.type === 'update').pop()!;
        const item = (last.integrations || []).find((i) => i.id === integrationId);
        assert.strictEqual(item?.tokenStatus, 'disconnected');
    });

    test('onDidChangeTokens fires -> updateWebview is invoked again', async () => {
        const provider = new IntegrationWebviewProvider(
            instance(extensionContext),
            instance(integrationStorage),
            instance(notebookManager),
            fakeTokenStorage.storage
        );

        const integrations: Map<string, IntegrationWithStatus> = new Map([
            ['bq-3', { config: makeBigQueryGoogleOauthConfig('bq-3'), status: IntegrationStatus.Connected }]
        ]);

        await show(provider, integrations);
        const updatesBefore = fakePanel.posted.filter((m) => m.type === 'update').length;
        assert.isAtLeast(updatesBefore, 1);

        // Simulate a save -> change event fires -> webview should refresh.
        await fakeTokenStorage.storage.save({
            integrationId: 'bq-3',
            refreshToken: 'r',
            metadataFingerprint: 'fp'
        });
        // Yield to the async update.
        await new Promise((resolve) => setTimeout(resolve, 0));

        const updatesAfter = fakePanel.posted.filter((m) => m.type === 'update').length;
        assert.isAbove(updatesAfter, updatesBefore);
    });

    test('handleMessage: "authenticate" -> commands.executeCommand(AuthenticateIntegration, integrationId)', async () => {
        const executeCommandStub = sinon.stub().resolves(undefined);
        when(mockedVSCodeNamespaces.commands.executeCommand(anyString(), anything())).thenCall((command, arg) =>
            executeCommandStub(command, arg)
        );
        when(mockedVSCodeNamespaces.commands.executeCommand(anyString())).thenCall((command) =>
            executeCommandStub(command)
        );

        const provider = new IntegrationWebviewProvider(
            instance(extensionContext),
            instance(integrationStorage),
            instance(notebookManager),
            fakeTokenStorage.storage
        );

        const integrationId = 'bq-auth';
        const integrations: Map<string, IntegrationWithStatus> = new Map([
            [
                integrationId,
                { config: makeBigQueryGoogleOauthConfig(integrationId), status: IntegrationStatus.Connected }
            ]
        ]);
        await show(provider, integrations);

        await fakePanel.onDidReceiveMessage({ type: 'authenticate', integrationId });

        assert.isTrue(
            executeCommandStub.calledWith(Commands.AuthenticateIntegration, integrationId),
            'expected executeCommand to be called with AuthenticateIntegration and the integration id'
        );
    });

    test('resetConfiguration: deletes the federated token in addition to the integration config', async () => {
        when(integrationStorage.delete(anyString())).thenResolve();

        const provider = new IntegrationWebviewProvider(
            instance(extensionContext),
            instance(integrationStorage),
            instance(notebookManager),
            fakeTokenStorage.storage
        );

        const integrationId = 'bq-reset';
        fakeTokenStorage.tokens.set(integrationId, {
            integrationId,
            refreshToken: 'r',
            metadataFingerprint: 'fp'
        });
        const integrations: Map<string, IntegrationWithStatus> = new Map([
            [
                integrationId,
                { config: makeBigQueryGoogleOauthConfig(integrationId), status: IntegrationStatus.Connected }
            ]
        ]);

        await show(provider, integrations);
        await fakePanel.onDidReceiveMessage({ type: 'reset', integrationId });

        assert.includeMembers(fakeTokenStorage.deletedIds, [integrationId]);
        verify(integrationStorage.delete(integrationId)).once();
    });

    test('deleteConfiguration: deletes the federated token in addition to the integration config', async () => {
        when(integrationStorage.delete(anyString())).thenResolve();

        const provider = new IntegrationWebviewProvider(
            instance(extensionContext),
            instance(integrationStorage),
            instance(notebookManager),
            fakeTokenStorage.storage
        );

        const integrationId = 'bq-del';
        fakeTokenStorage.tokens.set(integrationId, {
            integrationId,
            refreshToken: 'r',
            metadataFingerprint: 'fp'
        });
        const integrations: Map<string, IntegrationWithStatus> = new Map([
            [
                integrationId,
                { config: makeBigQueryGoogleOauthConfig(integrationId), status: IntegrationStatus.Connected }
            ]
        ]);

        await show(provider, integrations);
        await fakePanel.onDidReceiveMessage({ type: 'delete', integrationId });

        assert.includeMembers(fakeTokenStorage.deletedIds, [integrationId]);
        verify(integrationStorage.delete(integrationId)).once();
    });

    test('saveConfiguration: deletes the token BEFORE save when fingerprint changes', async () => {
        const integrationId = 'bq-save-fp';
        const saveOrder: string[] = [];
        when(integrationStorage.save(anything())).thenCall(async () => {
            saveOrder.push('storage.save');
        });
        // Re-bind the fake to capture delete order too.
        const originalDelete = fakeTokenStorage.storage.delete.bind(fakeTokenStorage.storage);
        fakeTokenStorage.storage.delete = async (id: string) => {
            saveOrder.push(`token.delete:${id}`);
            await originalDelete(id);
        };

        const provider = new IntegrationWebviewProvider(
            instance(extensionContext),
            instance(integrationStorage),
            instance(notebookManager),
            fakeTokenStorage.storage
        );

        // Existing token captured against the OLD fingerprint.
        fakeTokenStorage.tokens.set(integrationId, {
            integrationId,
            refreshToken: 'r',
            metadataFingerprint: 'old-fingerprint'
        });

        const integrations: Map<string, IntegrationWithStatus> = new Map([
            [
                integrationId,
                { config: makeBigQueryGoogleOauthConfig(integrationId), status: IntegrationStatus.Connected }
            ]
        ]);
        await show(provider, integrations);

        // Save a config that produces a DIFFERENT fingerprint than what's stored.
        const newConfig: ConfigurableDatabaseIntegrationConfig = {
            id: integrationId,
            name: 'New name',
            type: 'big-query',
            metadata: {
                authMethod: 'google-oauth',
                project: 'new-proj',
                clientId: 'new-client',
                clientSecret: 'new-secret'
            }
        } as ConfigurableDatabaseIntegrationConfig;

        await fakePanel.onDidReceiveMessage({ type: 'save', integrationId, config: newConfig });

        // Delete must happen BEFORE save.
        const deleteIdx = saveOrder.findIndex((o) => o.startsWith('token.delete'));
        const saveIdx = saveOrder.indexOf('storage.save');
        assert.notStrictEqual(deleteIdx, -1, 'token.delete should have been called');
        assert.notStrictEqual(saveIdx, -1, 'storage.save should have been called');
        assert.isBelow(deleteIdx, saveIdx, 'token.delete must occur BEFORE storage.save');
    });

    test('saveConfiguration: deletes the token when authMethod switches away from google-oauth', async () => {
        const integrationId = 'bq-switch';
        when(integrationStorage.save(anything())).thenResolve();

        const provider = new IntegrationWebviewProvider(
            instance(extensionContext),
            instance(integrationStorage),
            instance(notebookManager),
            fakeTokenStorage.storage
        );

        fakeTokenStorage.tokens.set(integrationId, {
            integrationId,
            refreshToken: 'r',
            metadataFingerprint: 'fp-1'
        });

        const integrations: Map<string, IntegrationWithStatus> = new Map([
            [
                integrationId,
                { config: makeBigQueryGoogleOauthConfig(integrationId), status: IntegrationStatus.Connected }
            ]
        ]);
        await show(provider, integrations);

        // Switch to service-account.
        const newConfig = makeBigQueryServiceAccountConfig(integrationId);
        await fakePanel.onDidReceiveMessage({ type: 'save', integrationId, config: newConfig });

        assert.includeMembers(fakeTokenStorage.deletedIds, [integrationId]);
        assert.isFalse(fakeTokenStorage.tokens.has(integrationId));
    });

    test('saveConfiguration: leaves the token intact when fingerprint matches', async () => {
        const integrationId = 'bq-stable';
        when(integrationStorage.save(anything())).thenResolve();

        const provider = new IntegrationWebviewProvider(
            instance(extensionContext),
            instance(integrationStorage),
            instance(notebookManager),
            fakeTokenStorage.storage
        );

        const sameConfig = makeBigQueryGoogleOauthConfig(integrationId);
        const stableFingerprint = fakeTokenStorage.fingerprintForTest({
            clientId: 'client-id',
            clientSecret: 'client-secret',
            project: 'proj'
        });
        fakeTokenStorage.tokens.set(integrationId, {
            integrationId,
            refreshToken: 'r',
            metadataFingerprint: stableFingerprint
        });

        const integrations: Map<string, IntegrationWithStatus> = new Map([
            [integrationId, { config: sameConfig, status: IntegrationStatus.Connected }]
        ]);
        await show(provider, integrations);

        await fakePanel.onDidReceiveMessage({ type: 'save', integrationId, config: sameConfig });

        // No delete should have happened.
        assert.notInclude(fakeTokenStorage.deletedIds, integrationId);
        assert.isTrue(fakeTokenStorage.tokens.has(integrationId));
    });

    test('onDidChangeTokens subscription survives panel close and reopen', async () => {
        const provider = new IntegrationWebviewProvider(
            instance(extensionContext),
            instance(integrationStorage),
            instance(notebookManager),
            fakeTokenStorage.storage
        );

        const integrationId = 'bq-reopen';
        const integrations: Map<string, IntegrationWithStatus> = new Map([
            [
                integrationId,
                { config: makeBigQueryGoogleOauthConfig(integrationId), status: IntegrationStatus.Connected }
            ]
        ]);

        // First open of the panel.
        await show(provider, integrations);
        assert.isAtLeast(fakePanel.posted.filter((m) => m.type === 'update').length, 1);

        // Simulate the user closing the panel: VS Code fires onDidDispose,
        // which clears `this.disposables`. The token-change subscription
        // MUST live in a separate slot and therefore survive.
        fakePanel.triggerDispose();

        // Open the panel a second time using a brand-new fake panel. We
        // rebind the createWebviewPanel mock so `show()` gets the new one.
        fakePanel = createFakeWebviewPanel();
        when(
            mockedVSCodeNamespaces.window.createWebviewPanel(anyString(), anyString(), anything(), anything())
        ).thenReturn(fakePanel.panel);

        await show(provider, integrations);
        const updatesAfterReopen = fakePanel.posted.filter((m) => m.type === 'update').length;
        assert.isAtLeast(updatesAfterReopen, 1, 'reopened panel should receive an initial update');

        // Fire a token change. If the subscription was lost on dispose, the
        // webview would NOT see an additional update message.
        await fakeTokenStorage.storage.save({
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
        // Build a token storage whose `has()` is a deferred promise so we
        // can dispose the panel mid-update.
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

        const provider = new IntegrationWebviewProvider(
            instance(extensionContext),
            instance(integrationStorage),
            instance(notebookManager),
            slowTokenStorage
        );

        const integrationId = 'bq-disposed-during-update';
        const integrations: Map<string, IntegrationWithStatus> = new Map([
            [
                integrationId,
                { config: makeBigQueryGoogleOauthConfig(integrationId), status: IntegrationStatus.Connected }
            ]
        ]);

        // Capture every postMessage call so we can assert no `update` is
        // posted after dispose.
        const allPostedMessages: CapturedMessage[] = [];
        fakePanel.setPostMessageImpl(async (message) => {
            allPostedMessages.push(message);
            return true;
        });

        // Fire `show()` but do NOT await: it will block on
        // Promise.all([slowTokenStorage.has(...)]) until we resolve.
        const showPromise = show(provider, integrations);

        // Yield once so `show()` starts the update and parks on `has()`.
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Simulate panel disposal mid-update. The provider's onDidDispose
        // sets `this.currentPanel = undefined`.
        fakePanel.triggerDispose();

        // Resolve the slow `has()` so updateWebview can finish. The
        // post-await guard MUST detect the panel is gone and skip
        // postMessage — otherwise we'd dereference undefined.
        resolveHas?.(false);
        await showPromise;
        onDidChangeEmitter.dispose();

        // Updates posted AFTER dispose should be zero. Updates BEFORE
        // dispose are fine (and there may be none because the panel was
        // disposed before the first await resolved).
        const updateMessages = allPostedMessages.filter((m) => m.type === 'update');
        // No throws (verified by showPromise resolving) and no postMessage
        // posted after the panel was disposed.
        assert.isEmpty(updateMessages, 'no `update` postMessage should be issued after the panel disposes mid-update');
    });

    test('handleMessage: "authenticate" logs and does not throw when commands.executeCommand rejects', async () => {
        const rejection = new Error('boom');
        const executeCommandStub = sinon.stub().rejects(rejection);
        when(mockedVSCodeNamespaces.commands.executeCommand(anyString(), anything())).thenCall((command, arg) =>
            executeCommandStub(command, arg)
        );
        when(mockedVSCodeNamespaces.commands.executeCommand(anyString())).thenCall((command) =>
            executeCommandStub(command)
        );

        const provider = new IntegrationWebviewProvider(
            instance(extensionContext),
            instance(integrationStorage),
            instance(notebookManager),
            fakeTokenStorage.storage
        );

        const integrationId = 'bq-auth-err';
        const integrations: Map<string, IntegrationWithStatus> = new Map([
            [
                integrationId,
                { config: makeBigQueryGoogleOauthConfig(integrationId), status: IntegrationStatus.Connected }
            ]
        ]);
        await show(provider, integrations);

        // Should not reject — the provider must swallow the failure so it
        // doesn't bubble out of the message handler as an unhandled-
        // rejection in the extension host.
        await fakePanel.onDidReceiveMessage({ type: 'authenticate', integrationId });

        assert.isTrue(
            executeCommandStub.calledWith(Commands.AuthenticateIntegration, integrationId),
            'expected executeCommand to be invoked'
        );
    });

    // Silence unused-warning compiler complaints from `capture` import in
    // case any future test wants to add capture-based assertions.
    void capture;
});
