import { deserializeDeepnoteFile, serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { assert } from 'chai';
import sinon from 'sinon';
import { anything, deepEqual, instance, mock, verify, when } from 'ts-mockito';
import {
    CancellationToken,
    CancellationTokenSource,
    NotebookDocument,
    NotebookEditor,
    QuickPickItem,
    Uri,
    workspace
} from 'vscode';

import { ITelemetryService } from '../../../platform/analytics/types';
import { IExtensionContext } from '../../../platform/common/types';
import { createDeferred } from '../../../platform/common/utils/async';
import { Integrations } from '../../../platform/common/utils/localize';
import { ConfigurableDatabaseIntegrationConfig } from '../../../platform/notebooks/deepnote/integrationTypes';
import { waitForCondition } from '../../../test/common';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { IDeepnoteNotebookManager, ProjectIntegration, RawProjectIntegration } from '../../types';
import {
    createDeepnoteFile,
    createDeepnoteProject,
    createMockNotebook,
    createWorkspaceFolder
} from '../deepnoteTestHelpers';
import { buildPostgresIntegration } from './federatedAuth/federatedAuthTestHelpers';
import { IntegrationManager } from './integrationManager';
import {
    IIntegrationDetector,
    IIntegrationEnvLiveRefresher,
    IIntegrationStorage,
    IIntegrationWebviewProvider
} from './types';

const CURRENT_PROJECT_ID = 'project-current';
const CURRENT_NOTEBOOK_ID = 'notebook-current';
const OTHER_PROJECT_ID = 'project-other';
const CURRENT_URI = Uri.file('/ws/current.deepnote');
const OTHER_URI = Uri.file('/ws/other.deepnote');
/** A second file of the CURRENT project, so the sibling-write branch has something to fail on. */
const SIBLING_URI = Uri.file('/ws/sibling.deepnote');
const SNAPSHOT_URI = Uri.file('/ws/snapshots/current_project-current_latest.snapshot.deepnote');

const SHARED_CONFIG = buildPostgresIntegration({ id: 'pg-shared', name: 'Shared Postgres' });
/** Below mocha's 2s test timeout, so a refresh that never starts fails with its own message. */
const REFRESH_START_TIMEOUT_MS = 1_000;

type RefreshFn = IIntegrationEnvLiveRefresher['refresh'];
// `thenCall` checks no signature, so doubles take their parameter types from here; annotating them by hand undoes it.
type UpdateProjectIntegrationsFn = IDeepnoteNotebookManager['updateProjectIntegrationsForNotebook'];

function projectFile(projectId: string, notebookId: string, integrations: RawProjectIntegration[]): DeepnoteFile {
    return createDeepnoteFile({
        project: createDeepnoteProject({
            id: projectId,
            name: projectId,
            notebooks: [{ id: notebookId, name: 'Notebook', blocks: [] }],
            integrations
        })
    });
}

suite('IntegrationManager.addExistingIntegration', () => {
    let currentNotebook: NotebookDocument;
    let otherNotebook: NotebookDocument;
    let currentProject: DeepnoteFile | undefined;
    let writes: Map<string, DeepnoteFile>;
    let cacheUpdates: Parameters<UpdateProjectIntegrationsFn>[];
    // Typed off the interface so a signature change fails the compile, not just the `firstCall.args` assertion.
    let refreshSpy: sinon.SinonSpy<Parameters<RefreshFn>, ReturnType<RefreshFn>>;
    let quickPickItems: QuickPickItem[] | undefined;
    let scanProgress: CancellationTokenSource;
    let writeFailures: Set<string>;

    let detector: IIntegrationDetector;
    let webviewProvider: IIntegrationWebviewProvider;
    let notebookManager: IDeepnoteNotebookManager;
    let telemetry: ITelemetryService;
    let cacheUpdateError: Error | undefined;
    let storedConfigs: ConfigurableDatabaseIntegrationConfig[];
    let onDiskOther: DeepnoteFile | undefined;
    let onDiskSibling: DeepnoteFile | undefined;
    let onDiskCurrent: DeepnoteFile | undefined;

    setup(() => {
        resetVSCodeMocks();

        currentNotebook = createMockNotebook({
            uri: CURRENT_URI,
            metadata: { deepnoteProjectId: CURRENT_PROJECT_ID, deepnoteNotebookId: CURRENT_NOTEBOOK_ID }
        });
        otherNotebook = createMockNotebook({
            uri: OTHER_URI,
            metadata: { deepnoteProjectId: OTHER_PROJECT_ID, deepnoteNotebookId: 'notebook-other' }
        });
        currentProject = projectFile(CURRENT_PROJECT_ID, CURRENT_NOTEBOOK_ID, []);
        onDiskOther = projectFile(OTHER_PROJECT_ID, 'notebook-other', [
            { id: SHARED_CONFIG.id, name: SHARED_CONFIG.name, type: SHARED_CONFIG.type }
        ]);
        onDiskSibling = undefined;
        onDiskCurrent = undefined;
        cacheUpdateError = undefined;
        storedConfigs = [SHARED_CONFIG];
        writes = new Map();
        cacheUpdates = [];
        quickPickItems = undefined;
        scanProgress = new CancellationTokenSource();
        writeFailures = new Set();

        when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([createWorkspaceFolder(Uri.file('/ws'))]);
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([currentNotebook, otherNotebook]);
        const discovered = () =>
            Promise.resolve([
                CURRENT_URI,
                ...(onDiskOther ? [OTHER_URI] : []),
                ...(onDiskSibling ? [SIBLING_URI] : [])
            ]);

        // The writer enumerates without a token; the scan passes one.
        when(mockedVSCodeNamespaces.workspace.findFiles(anything())).thenCall(discovered);
        when(mockedVSCodeNamespaces.workspace.findFiles(anything(), anything(), anything(), anything())).thenCall(
            discovered
        );

        when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall(
            (_options: unknown, task: (progress: unknown, token: CancellationToken) => unknown) =>
                task({ report: () => undefined }, scanProgress.token)
        );

        const mockFs = mock<typeof workspace.fs>();
        when(mockFs.readFile(anything())).thenCall((uri: Uri) => {
            const file = new Map([
                [CURRENT_URI.fsPath, onDiskCurrent ?? currentProject],
                [OTHER_URI.fsPath, onDiskOther],
                [SIBLING_URI.fsPath, onDiskSibling]
            ]).get(uri.fsPath);

            return file
                ? Promise.resolve(new TextEncoder().encode(serializeDeepnoteFile(file)))
                : Promise.reject(new Error(`no readFile stub for ${uri.fsPath}`));
        });
        when(mockFs.writeFile(anything(), anything())).thenCall((uri: Uri, bytes: Uint8Array) => {
            if (writeFailures.has(uri.fsPath)) {
                return Promise.reject(new Error(`write blocked for ${uri.fsPath}`));
            }

            writes.set(uri.fsPath, deserializeDeepnoteFile(new TextDecoder().decode(bytes)));

            return Promise.resolve();
        });
        when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

        // Picks the first offered item; tests that want a cancel override this.
        when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenCall((items: QuickPickItem[]) => {
            quickPickItems = items;

            return Promise.resolve(items[0]);
        });

        const mockDetector = mock<IIntegrationDetector>();
        when(mockDetector.detectIntegrations(anything())).thenResolve(new Map());
        detector = mockDetector;

        webviewProvider = mock<IIntegrationWebviewProvider>();
        when(webviewProvider.show(anything(), anything(), anything(), anything(), anything())).thenResolve();

        const mockManager = mock<IDeepnoteNotebookManager>();
        when(mockManager.getProjectForNotebook(CURRENT_PROJECT_ID, CURRENT_NOTEBOOK_ID)).thenCall(() => currentProject);
        const recordCacheUpdate: UpdateProjectIntegrationsFn = (projectId, notebookId, integrations) => {
            if (cacheUpdateError) {
                throw cacheUpdateError;
            }

            cacheUpdates.push([projectId, notebookId, integrations]);
        };
        when(mockManager.updateProjectIntegrationsForNotebook(anything(), anything(), anything())).thenCall(
            recordCacheUpdate
        );
        notebookManager = mockManager;

        telemetry = mock<ITelemetryService>();
        refreshSpy = sinon.spy<RefreshFn>(async () => undefined);
    });

    teardown(() => {
        scanProgress.dispose();
    });

    function buildManager(): IntegrationManager {
        const extensionContext = mock<IExtensionContext>();
        when(extensionContext.subscriptions).thenReturn([]);

        const storage = mock<IIntegrationStorage>();
        when(storage.getIntegrationConfig(anything())).thenCall((id: string) =>
            Promise.resolve(storedConfigs.find((config) => config.id === id))
        );

        const liveRefresher: IIntegrationEnvLiveRefresher = { refresh: refreshSpy };

        return new IntegrationManager(
            instance(extensionContext),
            instance(detector),
            instance(storage),
            instance(webviewProvider),
            instance(notebookManager),
            instance(telemetry),
            liveRefresher
        );
    }

    test("links the picked integration, refreshes only this project's kernels and re-shows the panel", async () => {
        const outcome = await buildManager().addExistingIntegration(CURRENT_URI.toString());

        assert.strictEqual(outcome, 'completed');

        const expectedIntegrations: ProjectIntegration[] = [
            { id: 'pg-shared', name: 'Shared Postgres', type: 'pgsql' }
        ];
        assert.deepStrictEqual(writes.get(CURRENT_URI.fsPath)?.project.integrations, expectedIntegrations);
        assert.deepStrictEqual(cacheUpdates, [[CURRENT_PROJECT_ID, CURRENT_NOTEBOOK_ID, expectedIntegrations]]);
        assert.isUndefined(writes.get(OTHER_URI.fsPath), 'the other project must not be rewritten');

        assert.isTrue(refreshSpy.calledOnce);
        assert.deepStrictEqual(refreshSpy.firstCall.args, [[currentNotebook], 'integration_config']);

        verify(webviewProvider.show(CURRENT_PROJECT_ID, anything(), anything(), anything(), anything())).once();

        verify(
            telemetry.trackEvent(
                deepEqual({
                    eventName: 'add_existing_integration',
                    properties: { integrationType: 'pgsql', outcome: 'completed' }
                })
            )
        ).once();

        assert.strictEqual(quickPickItems?.length, 1);
        assert.strictEqual(quickPickItems?.[0].label, 'Shared Postgres');
        assert.strictEqual(quickPickItems?.[0].description, 'PostgreSQL');
        assert.strictEqual(quickPickItems?.[0].detail, `Used in: ${OTHER_PROJECT_ID}`);
    });

    test('re-shows the panel before the kernel env refresh settles', async () => {
        // Catches: a busy kernel leaving the panel on the pre-link list until its running cell finishes.
        const refreshGate = createDeferred<void>();

        refreshSpy = sinon.spy<RefreshFn>(() => refreshGate.promise);

        const command = buildManager().addExistingIntegration(CURRENT_URI.toString());

        try {
            await waitForCondition(() => refreshSpy.calledOnce, REFRESH_START_TIMEOUT_MS, 'the refresh never started');

            verify(webviewProvider.show(CURRENT_PROJECT_ID, anything(), anything(), anything(), anything())).once();
        } finally {
            refreshGate.resolve();
        }

        assert.strictEqual(await command, 'completed');
    });

    test('still refreshes the kernels when re-showing the panel fails', async () => {
        // Catches: the kernel env refresh depending on the panel re-show succeeding.
        when(webviewProvider.show(anything(), anything(), anything(), anything(), anything())).thenReject(
            new Error('panel could not be shown')
        );

        const outcome = await buildManager().addExistingIntegration(CURRENT_URI.toString());

        assert.strictEqual(outcome, 'completed');
        assert.deepStrictEqual(refreshSpy.args, [[[currentNotebook], 'integration_config']]);
    });

    test('shows an information message and writes nothing when no other project has a reusable integration', async () => {
        onDiskOther = undefined;

        const outcome = await buildManager().addExistingIntegration(CURRENT_URI.toString());

        assert.strictEqual(outcome, 'completed');
        assert.strictEqual(writes.size, 0);
        assert.deepStrictEqual(cacheUpdates, []);
        assert.isTrue(refreshSpy.notCalled);
        verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).never();
        verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
    });

    test('does not offer an integration the current project already has', async () => {
        currentProject = projectFile(CURRENT_PROJECT_ID, CURRENT_NOTEBOOK_ID, [
            { id: SHARED_CONFIG.id, name: SHARED_CONFIG.name, type: SHARED_CONFIG.type }
        ]);

        await buildManager().addExistingIntegration(CURRENT_URI.toString());

        assert.strictEqual(writes.size, 0);
        verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).never();
    });

    test('warns and offers nothing when the only candidate is declared with a type the stored config does not match', async () => {
        onDiskOther = projectFile(OTHER_PROJECT_ID, 'notebook-other', [
            { id: SHARED_CONFIG.id, name: SHARED_CONFIG.name, type: 'mysql' }
        ]);

        await buildManager().addExistingIntegration(CURRENT_URI.toString());

        assert.strictEqual(writes.size, 0);
        verify(
            mockedVSCodeNamespaces.window.showWarningMessage(Integrations.addExistingIntegrationConflictsSkipped(1))
        ).once();
        verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).never();
    });

    test('returns cancelled and writes nothing when the picker is dismissed', async () => {
        // Catches: drop-off in the picker never reaching analytics, being sent under another outcome, or being sent
        // along with a stray second event.
        when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenResolve(undefined);

        const outcome = await buildManager().addExistingIntegration(CURRENT_URI.toString());

        assert.strictEqual(outcome, 'cancelled');
        assert.strictEqual(writes.size, 0);
        assert.isTrue(refreshSpy.notCalled);
        verify(telemetry.trackEvent(anything())).once();
        verify(
            telemetry.trackEvent(
                deepEqual({
                    eventName: 'add_existing_integration',
                    properties: { integrationType: 'unknown', outcome: 'cancelled' }
                })
            )
        ).once();
    });

    // Every branch below reports trouble to the user; without cover they can each regress into silent success,
    // or into the wrong diagnosis: the message is what tells the user which one they hit.
    const earlyFailures: { arrange: () => string; expectedMessage: string; name: string }[] = [
        {
            arrange: () => {
                when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([]);

                return Uri.file('/ws/missing.deepnote').toString();
            },
            expectedMessage: 'No active Deepnote notebook',
            name: 'no Deepnote notebook is open'
        },
        {
            arrange: () => {
                // The panel stayed open for the other project after its notebook closed; only this editor is left.
                const editor = mock<NotebookEditor>();

                when(editor.notebook).thenReturn(currentNotebook);
                when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([currentNotebook]);
                when(mockedVSCodeNamespaces.window.visibleNotebookEditors).thenReturn([instance(editor)]);

                return OTHER_URI.toString();
            },
            expectedMessage: Integrations.addExistingIntegrationNotebookClosed,
            name: 'the panel names a notebook that is no longer open'
        },
        {
            arrange: () => {
                when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([
                    createMockNotebook({ uri: CURRENT_URI, metadata: {} })
                ]);

                return CURRENT_URI.toString();
            },
            expectedMessage: 'Cannot determine project or notebook ID',
            name: 'the notebook declares no project or notebook id'
        },
        {
            arrange: () => {
                when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([
                    createMockNotebook({
                        uri: SNAPSHOT_URI,
                        metadata: {
                            deepnoteProjectId: CURRENT_PROJECT_ID,
                            deepnoteNotebookId: CURRENT_NOTEBOOK_ID
                        }
                    })
                ]);

                return SNAPSHOT_URI.toString();
            },
            expectedMessage: Integrations.addExistingIntegrationSnapshotUnsupported,
            name: 'the active file is a snapshot'
        },
        {
            arrange: () => {
                currentProject = undefined;

                return CURRENT_URI.toString();
            },
            expectedMessage: Integrations.addExistingIntegrationFailed,
            name: 'the project is not in the cache'
        }
    ];

    for (const { arrange, expectedMessage, name } of earlyFailures) {
        test(`fails without reading or writing any file when ${name}`, async () => {
            const uri = arrange();

            const outcome = await buildManager().addExistingIntegration(uri);

            assert.strictEqual(outcome, 'failed');
            assert.strictEqual(writes.size, 0);
            assert.deepStrictEqual(cacheUpdates, [], 'the cache must not move before the file does');
            verify(mockedVSCodeNamespaces.window.showErrorMessage(expectedMessage)).once();
            verify(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).never();
            verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).never();
            verify(telemetry.trackEvent(anything())).never();
        });
    }

    const lateFailures: { arrange: () => void; checksCache?: boolean; name: string }[] = [
        {
            arrange: () => writeFailures.add(CURRENT_URI.fsPath),
            checksCache: true,
            name: 'the active file cannot be written'
        },
        // The cache double throws before recording, so `cacheUpdates` stays empty whatever the manager does.
        { arrange: () => (cacheUpdateError = new Error('cache rejected the update')), name: 'the writer throws' }
    ];

    for (const { arrange, checksCache, name } of lateFailures) {
        test(`reports failure and records the outcome in telemetry when ${name}`, async () => {
            arrange();

            const outcome = await buildManager().addExistingIntegration(CURRENT_URI.toString());

            assert.strictEqual(outcome, 'failed');

            if (checksCache) {
                assert.deepStrictEqual(cacheUpdates, [], 'no failure path leaves the link in the cache');
            }

            assert.isTrue(refreshSpy.notCalled, 'the refresh reserved for a successful link never runs');
            verify(mockedVSCodeNamespaces.window.showErrorMessage(Integrations.addExistingIntegrationFailed)).once();
            verify(
                telemetry.trackEvent(
                    deepEqual({
                        eventName: 'add_existing_integration',
                        properties: { integrationType: 'pgsql', outcome: 'failed' }
                    })
                )
            ).once();
        });
    }

    test('completes with a warning when a sibling file of the same project cannot be updated', async () => {
        onDiskSibling = projectFile(CURRENT_PROJECT_ID, 'notebook-sibling', []);
        writeFailures.add(SIBLING_URI.fsPath);

        const outcome = await buildManager().addExistingIntegration(CURRENT_URI.toString());

        assert.strictEqual(outcome, 'completed');
        assert.isDefined(writes.get(CURRENT_URI.fsPath), 'the active file is still persisted');
        verify(mockedVSCodeNamespaces.window.showWarningMessage(anything())).once();
    });

    test('keeps an entry the file gained while the picker was open, though the cache never saw it', async () => {
        when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenCall((items: QuickPickItem[]) => {
            // Only disk moves: the cached project stays on the roster the command read before the scan.
            onDiskCurrent = projectFile(CURRENT_PROJECT_ID, CURRENT_NOTEBOOK_ID, [
                { id: 'added-meanwhile', name: 'Added meanwhile', type: 'mysql' }
            ]);

            return Promise.resolve(items[0]);
        });

        const outcome = await buildManager().addExistingIntegration(CURRENT_URI.toString());

        assert.strictEqual(outcome, 'completed');
        assert.deepStrictEqual(writes.get(CURRENT_URI.fsPath)?.project.integrations, [
            { id: 'added-meanwhile', name: 'Added meanwhile', type: 'mysql' },
            { id: 'pg-shared', name: 'Shared Postgres', type: 'pgsql' }
        ]);
    });

    test('returns cancelled and writes nothing when the scan is cancelled', async () => {
        // Catches: a cancelled scan counted as neither drop-off nor failure, or reported as 'failed'.
        scanProgress.cancel();

        const outcome = await buildManager().addExistingIntegration(CURRENT_URI.toString());

        assert.strictEqual(outcome, 'cancelled');
        assert.strictEqual(writes.size, 0);
        verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).never();
        verify(telemetry.trackEvent(anything())).once();
        verify(
            telemetry.trackEvent(
                deepEqual({
                    eventName: 'add_existing_integration',
                    properties: { integrationType: 'unknown', outcome: 'cancelled' }
                })
            )
        ).once();
    });
});
