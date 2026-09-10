import { deserializeDeepnoteFile, serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { assert } from 'chai';
import sinon from 'sinon';
import { anything, deepEqual, instance, mock, verify, when } from 'ts-mockito';
import { NotebookDocument, QuickPickItem, Uri, workspace } from 'vscode';

import { ITelemetryService } from '../../../platform/analytics/types';
import { IExtensionContext } from '../../../platform/common/types';
import { ConfigurableDatabaseIntegrationConfig } from '../../../platform/notebooks/deepnote/integrationTypes';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { IDeepnoteNotebookManager, ProjectIntegration } from '../../types';
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

const SHARED_CONFIG = buildPostgresIntegration({ id: 'pg-shared', name: 'Shared Postgres' });

function projectFile(projectId: string, notebookId: string, integrations: ProjectIntegration[]): DeepnoteFile {
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
    let currentProject: DeepnoteFile;
    let writes: Map<string, DeepnoteFile>;
    let cacheUpdates: ProjectIntegration[][];
    let refreshSpy: sinon.SinonSpy;
    let quickPickItems: QuickPickItem[] | undefined;

    let detector: IIntegrationDetector;
    let webviewProvider: IIntegrationWebviewProvider;
    let notebookManager: IDeepnoteNotebookManager;
    let telemetry: ITelemetryService;
    let storedConfigs: ConfigurableDatabaseIntegrationConfig[];
    let onDiskOther: DeepnoteFile | undefined;

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
        storedConfigs = [SHARED_CONFIG];
        writes = new Map();
        cacheUpdates = [];
        quickPickItems = undefined;

        when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([createWorkspaceFolder(Uri.file('/ws'))]);
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([currentNotebook, otherNotebook]);
        when(mockedVSCodeNamespaces.workspace.findFiles(anything())).thenCall(() =>
            Promise.resolve(onDiskOther ? [CURRENT_URI, OTHER_URI] : [CURRENT_URI])
        );

        const mockFs = mock<typeof workspace.fs>();
        when(mockFs.readFile(anything())).thenCall((uri: Uri) => {
            const file = uri.fsPath === CURRENT_URI.fsPath ? currentProject : onDiskOther;

            return file
                ? Promise.resolve(new TextEncoder().encode(serializeDeepnoteFile(file)))
                : Promise.reject(new Error(`no readFile stub for ${uri.fsPath}`));
        });
        when(mockFs.writeFile(anything(), anything())).thenCall((uri: Uri, bytes: Uint8Array) => {
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
        when(mockManager.updateProjectIntegrations(anything(), anything())).thenCall(
            (_projectId: string, integrations: ProjectIntegration[]) => {
                cacheUpdates.push(integrations);

                return true;
            }
        );
        notebookManager = mockManager;

        telemetry = mock<ITelemetryService>();
        refreshSpy = sinon.spy(async () => undefined);
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

    test("links the picked integration into the roster, refreshes only this project's kernels and re-shows the panel", async () => {
        const outcome = await buildManager().addExistingIntegration(CURRENT_URI.toString());

        assert.strictEqual(outcome, 'completed');

        const expectedRoster: ProjectIntegration[] = [{ id: 'pg-shared', name: 'Shared Postgres', type: 'pgsql' }];
        assert.deepStrictEqual(writes.get(CURRENT_URI.fsPath)?.project.integrations, expectedRoster);
        assert.deepStrictEqual(cacheUpdates, [expectedRoster]);
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
        verify(mockedVSCodeNamespaces.window.showWarningMessage(anything())).once();
        verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).never();
    });

    test('returns cancelled and writes nothing when the picker is dismissed', async () => {
        when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenResolve(undefined);

        const outcome = await buildManager().addExistingIntegration(CURRENT_URI.toString());

        assert.strictEqual(outcome, 'cancelled');
        assert.strictEqual(writes.size, 0);
        assert.isTrue(refreshSpy.notCalled);
        verify(telemetry.trackEvent(anything())).never();
    });

    test('fails without a Deepnote notebook to act on', async () => {
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([]);

        const outcome = await buildManager().addExistingIntegration(Uri.file('/ws/missing.deepnote').toString());

        assert.strictEqual(outcome, 'failed');
        verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
    });
});
