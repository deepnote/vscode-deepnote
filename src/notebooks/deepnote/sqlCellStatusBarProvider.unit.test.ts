import { assert } from 'chai';
import { anything, instance, mock, verify, when } from 'ts-mockito';
import {
    CancellationToken,
    CancellationTokenSource,
    EventEmitter,
    NotebookCell,
    NotebookCellKind,
    NotebookDocument,
    TextDocument,
    Uri
} from 'vscode';

import { IDisposableRegistry } from '../../platform/common/types';
import { IIntegrationStorage } from './integrations/types';
import { SqlCellStatusBarProvider } from './sqlCellStatusBarProvider';
import { DATAFRAME_SQL_INTEGRATION_ID, IntegrationType } from '../../platform/notebooks/deepnote/integrationTypes';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { createEventHandler } from '../../test/common';
import { Commands } from '../../platform/common/constants';

suite('SqlCellStatusBarProvider', () => {
    let provider: SqlCellStatusBarProvider;
    let disposables: IDisposableRegistry;
    let integrationStorage: IIntegrationStorage;
    let cancellationToken: CancellationToken;

    setup(() => {
        disposables = [];
        integrationStorage = mock<IIntegrationStorage>();
        provider = new SqlCellStatusBarProvider(disposables, instance(integrationStorage));

        const tokenSource = new CancellationTokenSource();
        cancellationToken = tokenSource.token;
    });

    test('returns undefined for non-SQL cells', async () => {
        const cell = createMockCell('python', {});

        const result = await provider.provideCellStatusBarItems(cell, cancellationToken);

        assert.isUndefined(result);
    });

    test('returns status bar items for SQL cells without integration ID', async () => {
        const cell = createMockCell('sql', {});

        const result = await provider.provideCellStatusBarItems(cell, cancellationToken);

        assert.isDefined(result);
        assert.isArray(result);
        const items = result as any[];
        assert.strictEqual(items.length, 2);

        // Check "No integration connected" status bar item
        const integrationItem = items[0];
        assert.strictEqual(integrationItem.text, '$(database) No integration connected');
        assert.strictEqual(integrationItem.alignment, 1);
        assert.isDefined(integrationItem.command);
        assert.strictEqual(integrationItem.command.command, 'deepnote.switchSqlIntegration');

        // Check variable status bar item
        const variableItem = items[1];
        assert.strictEqual(variableItem.text, 'Variable: df');
        assert.strictEqual(variableItem.alignment, 1);
        assert.isDefined(variableItem.command);
        assert.strictEqual(variableItem.command.command, 'deepnote.updateSqlVariableName');
    });

    test('returns status bar items for SQL cells with dataframe integration ID', async () => {
        const cell = createMockCell('sql', {
            sql_integration_id: DATAFRAME_SQL_INTEGRATION_ID
        });

        const result = await provider.provideCellStatusBarItems(cell, cancellationToken);

        assert.isDefined(result);
        assert.isArray(result);
        const items = result as any[];
        assert.strictEqual(items.length, 2);

        // Check integration status bar item
        const integrationItem = items[0];
        assert.strictEqual(integrationItem.text, '$(database) DataFrame SQL (DuckDB)');
        assert.strictEqual(integrationItem.alignment, 1);
        assert.strictEqual(
            integrationItem.tooltip,
            'Internal DuckDB integration for querying DataFrames\nClick to switch'
        );
        assert.isDefined(integrationItem.command);
        assert.strictEqual(integrationItem.command.command, 'deepnote.switchSqlIntegration');

        // Check variable status bar item
        const variableItem = items[1];
        assert.strictEqual(variableItem.text, 'Variable: df');
        assert.strictEqual(variableItem.alignment, 1);
        assert.isDefined(variableItem.command);
        assert.strictEqual(variableItem.command.command, 'deepnote.updateSqlVariableName');
    });

    test('returns status bar items for SQL cell with integration ID', async () => {
        const integrationId = 'postgres-123';
        const cell = createMockCell(
            'sql',
            {
                sql_integration_id: integrationId
            },
            {
                deepnoteProjectId: 'project-1'
            }
        );

        when(integrationStorage.getProjectIntegrationConfig(anything(), anything())).thenResolve({
            id: integrationId,
            name: 'My Postgres DB',
            type: IntegrationType.Postgres,
            host: 'localhost',
            port: 5432,
            database: 'test',
            username: 'user',
            password: 'pass'
        });

        const result = await provider.provideCellStatusBarItems(cell, cancellationToken);

        assert.isDefined(result);
        assert.isArray(result);
        const items = result as any[];
        assert.strictEqual(items.length, 2);

        // Check integration status bar item
        const integrationItem = items[0];
        assert.strictEqual(integrationItem.text, '$(database) My Postgres DB');
        assert.strictEqual(integrationItem.alignment, 1);
        assert.isDefined(integrationItem.command);
        assert.strictEqual(integrationItem.command.command, 'deepnote.switchSqlIntegration');
        assert.deepStrictEqual(integrationItem.command.arguments, [cell]);

        // Check variable status bar item
        const variableItem = items[1];
        assert.strictEqual(variableItem.text, 'Variable: df');
        assert.strictEqual(variableItem.alignment, 1);
        assert.isDefined(variableItem.command);
        assert.strictEqual(variableItem.command.command, 'deepnote.updateSqlVariableName');
    });

    test('shows "Unknown integration (configure)" when config not found', async () => {
        const integrationId = 'postgres-123';
        const cell = createMockCell(
            'sql',
            {
                sql_integration_id: integrationId
            },
            {
                deepnoteProjectId: 'project-1'
            }
        );

        when(integrationStorage.getProjectIntegrationConfig(anything(), anything())).thenResolve(undefined);

        const result = await provider.provideCellStatusBarItems(cell, cancellationToken);

        assert.isDefined(result);
        assert.isArray(result);
        const items = result as any[];
        assert.strictEqual(items.length, 2);
        assert.strictEqual(items[0].text, '$(database) Unknown integration (configure)');
        assert.strictEqual(items[1].text, 'Variable: df');
    });

    test('returns only variable item when notebook has no project ID', async () => {
        const integrationId = 'postgres-123';
        const cell = createMockCell('sql', {
            sql_integration_id: integrationId
        });

        const result = await provider.provideCellStatusBarItems(cell, cancellationToken);

        assert.isDefined(result);
        assert.isArray(result);
        const items = result as any[];
        assert.strictEqual(items.length, 1);

        // Check variable status bar item is still shown
        const variableItem = items[0];
        assert.strictEqual(variableItem.text, 'Variable: df');
        assert.strictEqual(variableItem.alignment, 1);
    });

    test('shows custom variable name when set in metadata', async () => {
        const integrationId = 'postgres-123';
        const cell = createMockCell(
            'sql',
            {
                sql_integration_id: integrationId,
                deepnote_variable_name: 'my_results'
            },
            {
                deepnoteProjectId: 'project-1'
            }
        );

        when(integrationStorage.getProjectIntegrationConfig(anything(), anything())).thenResolve({
            id: integrationId,
            name: 'My Postgres DB',
            type: IntegrationType.Postgres,
            host: 'localhost',
            port: 5432,
            database: 'test',
            username: 'user',
            password: 'pass'
        });

        const result = await provider.provideCellStatusBarItems(cell, cancellationToken);

        assert.isDefined(result);
        assert.isArray(result);
        const items = result as any[];
        assert.strictEqual(items.length, 2);

        // Check variable status bar item shows custom name
        const variableItem = items[1];
        assert.strictEqual(variableItem.text, 'Variable: my_results');
    });

    suite('activate', () => {
        let activateDisposables: IDisposableRegistry;
        let activateProvider: SqlCellStatusBarProvider;
        let activateIntegrationStorage: IIntegrationStorage;

        setup(() => {
            resetVSCodeMocks();
            activateDisposables = [];
            activateIntegrationStorage = mock<IIntegrationStorage>();
            activateProvider = new SqlCellStatusBarProvider(activateDisposables, instance(activateIntegrationStorage));
        });

        teardown(() => {
            resetVSCodeMocks();
        });

        test('registers notebook cell status bar provider for deepnote notebooks', () => {
            activateProvider.activate();

            verify(
                mockedVSCodeNamespaces.notebooks.registerNotebookCellStatusBarItemProvider('deepnote', activateProvider)
            ).once();
        });

        test('registers deepnote.updateSqlVariableName command', () => {
            activateProvider.activate();

            verify(
                mockedVSCodeNamespaces.commands.registerCommand('deepnote.updateSqlVariableName', anything())
            ).once();
        });

        test('registers deepnote.switchSqlIntegration command', () => {
            activateProvider.activate();

            verify(mockedVSCodeNamespaces.commands.registerCommand('deepnote.switchSqlIntegration', anything())).once();
        });

        test('adds all registrations to disposables', () => {
            activateProvider.activate();

            // Should have 5 disposables:
            // 1. notebook cell status bar provider
            // 2. integration storage change listener
            // 3. updateSqlVariableName command
            // 4. switchSqlIntegration command
            // 5. event emitter
            assert.strictEqual(activateDisposables.length, 5);
        });

        test('listens to integration storage changes', () => {
            const onDidChangeIntegrations = new EventEmitter<void>();
            when(activateIntegrationStorage.onDidChangeIntegrations).thenReturn(onDidChangeIntegrations.event);

            activateProvider.activate();

            // Verify the listener was registered by checking disposables
            assert.isTrue(activateDisposables.length > 0);
        });
    });

    suite('event listeners', () => {
        let eventDisposables: IDisposableRegistry;
        let eventProvider: SqlCellStatusBarProvider;
        let eventIntegrationStorage: IIntegrationStorage;

        setup(() => {
            eventDisposables = [];
            eventIntegrationStorage = mock<IIntegrationStorage>();
            eventProvider = new SqlCellStatusBarProvider(eventDisposables, instance(eventIntegrationStorage));
        });

        test('fires onDidChangeCellStatusBarItems when integration storage changes', () => {
            const onDidChangeIntegrations = new EventEmitter<void>();
            when(eventIntegrationStorage.onDidChangeIntegrations).thenReturn(onDidChangeIntegrations.event);

            eventProvider.activate();

            const statusBarChangeHandler = createEventHandler(
                eventProvider,
                'onDidChangeCellStatusBarItems',
                eventDisposables
            );

            // Fire integration storage change event
            onDidChangeIntegrations.fire();

            assert.strictEqual(statusBarChangeHandler.count, 1, 'onDidChangeCellStatusBarItems should fire once');
        });

        test('fires onDidChangeCellStatusBarItems multiple times for multiple integration changes', () => {
            const onDidChangeIntegrations = new EventEmitter<void>();
            when(eventIntegrationStorage.onDidChangeIntegrations).thenReturn(onDidChangeIntegrations.event);

            eventProvider.activate();

            const statusBarChangeHandler = createEventHandler(
                eventProvider,
                'onDidChangeCellStatusBarItems',
                eventDisposables
            );

            // Fire integration storage change event multiple times
            onDidChangeIntegrations.fire();
            onDidChangeIntegrations.fire();
            onDidChangeIntegrations.fire();

            assert.strictEqual(
                statusBarChangeHandler.count,
                3,
                'onDidChangeCellStatusBarItems should fire three times'
            );
        });
    });

    suite('updateSqlVariableName command handler', () => {
        let commandDisposables: IDisposableRegistry;
        let commandProvider: SqlCellStatusBarProvider;
        let commandIntegrationStorage: IIntegrationStorage;
        let updateVariableNameHandler: Function;

        setup(() => {
            resetVSCodeMocks();
            commandDisposables = [];
            commandIntegrationStorage = mock<IIntegrationStorage>();
            commandProvider = new SqlCellStatusBarProvider(commandDisposables, instance(commandIntegrationStorage));

            // Capture the command handler
            when(
                mockedVSCodeNamespaces.commands.registerCommand('deepnote.updateSqlVariableName', anything())
            ).thenCall((_, handler) => {
                updateVariableNameHandler = handler;
                return {
                    dispose: () => {
                        return;
                    }
                };
            });

            commandProvider.activate();
        });

        teardown(() => {
            resetVSCodeMocks();
        });

        test('updates cell metadata with new variable name', async () => {
            const cell = createMockCell('sql', { deepnote_variable_name: 'old_name' });
            const newVariableName = 'new_name';

            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(newVariableName));
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

            await updateVariableNameHandler(cell);

            verify(mockedVSCodeNamespaces.window.showInputBox(anything())).once();
            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
        });

        test('does not update if user cancels input box', async () => {
            const cell = createMockCell('sql', { deepnote_variable_name: 'old_name' });

            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

            await updateVariableNameHandler(cell);

            verify(mockedVSCodeNamespaces.window.showInputBox(anything())).once();
            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
        });

        test('does not update if new name is same as current name', async () => {
            const cell = createMockCell('sql', { deepnote_variable_name: 'same_name' });

            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('same_name'));

            await updateVariableNameHandler(cell);

            verify(mockedVSCodeNamespaces.window.showInputBox(anything())).once();
            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
        });

        test('shows error message if workspace edit fails', async () => {
            const cell = createMockCell('sql', { deepnote_variable_name: 'old_name' });
            const newVariableName = 'new_name';

            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(newVariableName));
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(false));

            await updateVariableNameHandler(cell);

            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
        });

        test('fires onDidChangeCellStatusBarItems after successful update', async () => {
            const cell = createMockCell('sql', { deepnote_variable_name: 'old_name' });
            const newVariableName = 'new_name';

            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(newVariableName));
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

            const statusBarChangeHandler = createEventHandler(
                commandProvider,
                'onDidChangeCellStatusBarItems',
                commandDisposables
            );

            await updateVariableNameHandler(cell);

            assert.strictEqual(statusBarChangeHandler.count, 1, 'onDidChangeCellStatusBarItems should fire once');
        });

        test('validates input - rejects empty variable name', async () => {
            const cell = createMockCell('sql', {});

            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenCall((options) => {
                const validationResult = options.validateInput('');
                assert.strictEqual(validationResult, 'Variable name cannot be empty');
                return Promise.resolve(undefined);
            });

            await updateVariableNameHandler(cell);
        });

        test('validates input - rejects invalid Python identifier', async () => {
            const cell = createMockCell('sql', {});

            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenCall((options) => {
                const validationResult = options.validateInput('123invalid');
                assert.strictEqual(validationResult, 'Variable name must be a valid Python identifier');
                return Promise.resolve(undefined);
            });

            await updateVariableNameHandler(cell);
        });
    });

    suite('switchSqlIntegration command handler', () => {
        let commandDisposables: IDisposableRegistry;
        let commandProvider: SqlCellStatusBarProvider;
        let commandIntegrationStorage: IIntegrationStorage;
        let switchIntegrationHandler: Function;

        setup(() => {
            resetVSCodeMocks();
            commandDisposables = [];
            commandIntegrationStorage = mock<IIntegrationStorage>();
            commandProvider = new SqlCellStatusBarProvider(commandDisposables, instance(commandIntegrationStorage));

            // Capture the command handler
            when(mockedVSCodeNamespaces.commands.registerCommand('deepnote.switchSqlIntegration', anything())).thenCall(
                (_, handler) => {
                    switchIntegrationHandler = handler;
                    return {
                        dispose: () => {
                            return;
                        }
                    };
                }
            );

            commandProvider.activate();
        });

        teardown(() => {
            resetVSCodeMocks();
        });

        test('updates cell metadata with selected integration', async () => {
            const cell = createMockCell('sql', { sql_integration_id: 'old-integration' });
            const newIntegrationId = 'new-integration';

            when(commandIntegrationStorage.getAll()).thenReturn(
                Promise.resolve([
                    {
                        id: newIntegrationId,
                        name: 'New Integration',
                        type: IntegrationType.Postgres,
                        host: 'localhost',
                        port: 5432,
                        database: 'test',
                        username: 'user',
                        password: 'pass'
                    }
                ])
            );

            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ id: newIntegrationId, label: 'New Integration' } as any)
            );
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

            await switchIntegrationHandler(cell);

            verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).once();
            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
        });

        test('does not update if user cancels quick pick', async () => {
            const cell = createMockCell('sql', { sql_integration_id: 'old-integration' });

            when(commandIntegrationStorage.getAll()).thenReturn(Promise.resolve([]));
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve(undefined)
            );

            await switchIntegrationHandler(cell);

            verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).once();
            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
        });

        test('shows error message if workspace edit fails', async () => {
            const cell = createMockCell('sql', { sql_integration_id: 'old-integration' });
            const newIntegrationId = 'new-integration';

            when(commandIntegrationStorage.getAll()).thenReturn(Promise.resolve([]));
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ id: newIntegrationId, label: 'New Integration' } as any)
            );
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(false));

            await switchIntegrationHandler(cell);

            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
        });

        test('fires onDidChangeCellStatusBarItems after successful update', async () => {
            const cell = createMockCell('sql', { sql_integration_id: 'old-integration' });
            const newIntegrationId = 'new-integration';

            when(commandIntegrationStorage.getAll()).thenReturn(Promise.resolve([]));
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ id: newIntegrationId, label: 'New Integration' } as any)
            );
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

            const statusBarChangeHandler = createEventHandler(
                commandProvider,
                'onDidChangeCellStatusBarItems',
                commandDisposables
            );

            await switchIntegrationHandler(cell);

            assert.strictEqual(statusBarChangeHandler.count, 1, 'onDidChangeCellStatusBarItems should fire once');
        });

        test('executes manage integrations command when configure option is selected', async () => {
            const cell = createMockCell('sql', { sql_integration_id: 'current-integration' });

            when(commandIntegrationStorage.getAll()).thenReturn(Promise.resolve([]));
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ id: '__configure__', label: 'Configure current integration' } as any)
            );
            when(mockedVSCodeNamespaces.commands.executeCommand(anything(), anything())).thenReturn(
                Promise.resolve(undefined)
            );

            await switchIntegrationHandler(cell);

            verify(
                mockedVSCodeNamespaces.commands.executeCommand(Commands.ManageIntegrations, 'current-integration')
            ).once();
            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
        });

        test('includes DuckDB integration in quick pick items', async () => {
            const cell = createMockCell('sql', {});
            let quickPickItems: any[] = [];

            when(commandIntegrationStorage.getAll()).thenReturn(Promise.resolve([]));
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenCall((items) => {
                quickPickItems = items;
                return Promise.resolve(undefined);
            });

            await switchIntegrationHandler(cell);

            const duckDbItem = quickPickItems.find((item) => item.id === DATAFRAME_SQL_INTEGRATION_ID);
            assert.isDefined(duckDbItem, 'DuckDB integration should be in quick pick items');
            assert.strictEqual(duckDbItem.label, 'DataFrame SQL (DuckDB)');
        });

        test('marks current integration as selected in quick pick', async () => {
            const currentIntegrationId = 'current-integration';
            const cell = createMockCell('sql', { sql_integration_id: currentIntegrationId });
            let quickPickItems: any[] = [];

            when(commandIntegrationStorage.getAll()).thenReturn(
                Promise.resolve([
                    {
                        id: currentIntegrationId,
                        name: 'Current Integration',
                        type: IntegrationType.Postgres,
                        host: 'localhost',
                        port: 5432,
                        database: 'test',
                        username: 'user',
                        password: 'pass'
                    }
                ])
            );
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenCall((items) => {
                quickPickItems = items;
                return Promise.resolve(undefined);
            });

            await switchIntegrationHandler(cell);

            const currentItem = quickPickItems.find((item) => item.id === currentIntegrationId);
            assert.isDefined(currentItem, 'Current integration should be in quick pick items');
            assert.strictEqual(currentItem.detail, 'Currently selected');
        });
    });

    function createMockCell(
        languageId: string,
        cellMetadata: Record<string, unknown>,
        notebookMetadata: Record<string, unknown> = {}
    ): NotebookCell {
        const document = {
            languageId
        } as TextDocument;

        const notebook = {
            metadata: notebookMetadata,
            uri: Uri.file('/test/notebook.deepnote')
        } as NotebookDocument;

        const cell = {
            document,
            notebook,
            kind: NotebookCellKind.Code,
            metadata: cellMetadata,
            index: 0
        } as NotebookCell;

        return cell;
    }
});
