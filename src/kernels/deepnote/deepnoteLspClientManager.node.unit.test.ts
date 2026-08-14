import { assert } from 'chai';
import { Uri } from 'vscode';
import { anything, instance, mock, when } from 'ts-mockito';
import * as sinon from 'sinon';

import { ConfigurableDatabaseIntegrationConfig } from '../../platform/notebooks/deepnote/integrationTypes';
import { DeepnoteLspClientManager } from './deepnoteLspClientManager.node';
import { IDisposableRegistry } from '../../platform/common/types';
import {
    IPlatformDeepnoteNotebookManager,
    IPlatformNotebookEditorProvider,
    ISqlIntegrationEnvVarsProvider
} from '../../platform/notebooks/deepnote/types';

/**
 * The shared client is module-global state reached only through private methods, so the branches under test have no
 * public entry point that isolates them.
 */
interface LspManagerInternals {
    applySqlConnections(client: unknown, connections: unknown[]): Promise<void>;
    ensureSharedSqlClient(notebookUri: Uri): Promise<void>;
    getSqlConnections(notebookUri: Uri): Promise<unknown[]>;
}

suite('DeepnoteLspClientManager shared SQL client', () => {
    const uriA = Uri.file('/ws/a.deepnote').with({ query: 'notebook=nb-a' });
    const uriB = Uri.file('/ws/b.deepnote').with({ query: 'notebook=nb-b' });

    let internals: LspManagerInternals;
    let manager: DeepnoteLspClientManager;
    /** Connection names pushed to the shared server, one entry per configuration push, oldest first. */
    let pushedConnectionNames: string[][];
    /** Held closed to keep a notebook parked in the "client is starting" branch. */
    let openCreationGate: () => void;
    let creationStarted: Promise<void>;

    function createFakeSqlClient() {
        return {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            sendNotification: async (method: string, params: any) => {
                if (method === 'workspace/didChangeConfiguration') {
                    pushedConnectionNames.push(
                        params.settings.sqlLanguageServer.connections.map((c: { name: string }) => c.name)
                    );
                }
            },
            sendRequest: async () => undefined,
            stop: async () => undefined,
            dispose: async () => undefined
        };
    }

    function postgresConfig(name: string): ConfigurableDatabaseIntegrationConfig {
        return {
            type: 'pgsql',
            name,
            metadata: { host: `${name}.example.com`, port: '5432', user: 'u', password: 'p', database: 'db' }
        } as ConfigurableDatabaseIntegrationConfig;
    }

    setup(() => {
        pushedConnectionNames = [];

        const notebookEditorProvider = mock<IPlatformNotebookEditorProvider>();
        when(notebookEditorProvider.findAssociatedNotebookDocument(anything())).thenReturn({
            metadata: { deepnoteProjectId: 'project', deepnoteNotebookId: 'notebook' }
        } as never);

        const notebookManager = mock<IPlatformDeepnoteNotebookManager>();
        when(notebookManager.getProjectForNotebook('project', 'notebook')).thenReturn({ project: {} } as never);

        const sqlIntegrationEnvVars = mock<ISqlIntegrationEnvVarsProvider>();
        when(sqlIntegrationEnvVars.getMergedIntegrationConfigs(uriA)).thenResolve([postgresConfig('warehouse-a')]);
        when(sqlIntegrationEnvVars.getMergedIntegrationConfigs(uriB)).thenResolve([postgresConfig('warehouse-b')]);

        manager = new DeepnoteLspClientManager(
            { push: () => 0 } as unknown as IDisposableRegistry,
            instance(notebookEditorProvider),
            instance(notebookManager),
            instance(sqlIntegrationEnvVars)
        );
        internals = manager as unknown as LspManagerInternals;

        let signalCreationStarted: () => void = () => undefined;
        creationStarted = new Promise<void>((resolve) => (signalCreationStarted = resolve));
        const creationGate = new Promise<void>((resolve) => (openCreationGate = resolve));

        const sqlClient = createFakeSqlClient();

        // Stands in for spawning the language server. It applies the starting notebook's connections once the
        // client is up, as the real one does, so the global stays truthful about what the server is pointed at.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sinon.stub(DeepnoteLspClientManager.prototype as any, 'createSqlLspClient').callsFake(async function (
            this: DeepnoteLspClientManager,
            notebookUri: Uri
        ) {
            signalCreationStarted();
            await creationGate;

            const self = this as unknown as LspManagerInternals;
            await self.applySqlConnections(sqlClient, await self.getSqlConnections(notebookUri));

            return sqlClient;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
    });

    teardown(async () => {
        // A gate left closed would strand the "starting" flag and leak into the next test.
        openCreationGate();
        await manager.stopAllClients();
        sinon.restore();
    });

    test('reconfigures a notebook that waited out another notebook’s client startup', async () => {
        const startingNotebook = internals.ensureSharedSqlClient(uriA);
        await creationStarted;

        // Both branch checks at the top of ensureSharedSqlClient are synchronous, so this call is parked in the
        // wait loop by the time it returns — the gate is still closed, so the reuse branch is unreachable.
        const waitingNotebook = internals.ensureSharedSqlClient(uriB);

        openCreationGate();
        await Promise.all([startingNotebook, waitingNotebook]);

        assert.deepStrictEqual(
            pushedConnectionNames,
            [['warehouse-a'], ['warehouse-b']],
            'the waiting notebook must be pushed its own connections, not the starting notebook’s'
        );
    });

    test('reconfigures a notebook that reuses an already running client', async () => {
        openCreationGate();

        await internals.ensureSharedSqlClient(uriA);
        await internals.ensureSharedSqlClient(uriB);

        assert.deepStrictEqual(pushedConnectionNames, [['warehouse-a'], ['warehouse-b']]);
    });
});
