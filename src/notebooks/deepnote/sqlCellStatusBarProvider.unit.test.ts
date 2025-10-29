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
import { IDeepnoteNotebookManager } from '../types';

suite('SqlCellStatusBarProvider', () => {
    let provider: SqlCellStatusBarProvider;
    let disposables: IDisposableRegistry;
    let integrationStorage: IIntegrationStorage;
    let notebookManager: IDeepnoteNotebookManager;
    let cancellationToken: CancellationToken;

    setup(() => {
        disposables = [];
        integrationStorage = mock<IIntegrationStorage>();
        notebookManager = mock<IDeepnoteNotebookManager>();
        provider = new SqlCellStatusBarProvider(disposables, instance(integrationStorage), instance(notebookManager));

        const tokenSource = new CancellationTokenSource();
        cancellationToken = tokenSource.token;
    });

    test('returns undefined when cancellation token is requested', async () => {
        const cell = createMockCell('sql', {});
        const tokenSource = new CancellationTokenSource();
        tokenSource.cancel();

        const result = await provider.provideCellStatusBarItems(cell, tokenSource.token);

        assert.isUndefined(result);
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
        assert.deepStrictEqual(integrationItem.command.arguments, [cell]);
        assert.strictEqual(integrationItem.priority, 100);

        // Check variable status bar item
        const variableItem = items[1];
        assert.strictEqual(variableItem.text, 'Variable: df');
        assert.strictEqual(variableItem.alignment, 1);
        assert.isDefined(variableItem.command);
        assert.strictEqual(variableItem.command.command, 'deepnote.updateSqlVariableName');
        assert.deepStrictEqual(variableItem.command.arguments, [cell]);
        assert.strictEqual(variableItem.priority, 90);
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
        assert.deepStrictEqual(integrationItem.command.arguments, [cell]);
        assert.strictEqual(integrationItem.priority, 100);

        // Check variable status bar item
        const variableItem = items[1];
        assert.strictEqual(variableItem.text, 'Variable: df');
        assert.strictEqual(variableItem.alignment, 1);
        assert.isDefined(variableItem.command);
        assert.strictEqual(variableItem.command.command, 'deepnote.updateSqlVariableName');
        assert.deepStrictEqual(variableItem.command.arguments, [cell]);
        assert.strictEqual(variableItem.priority, 90);
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
        assert.strictEqual(integrationItem.priority, 100);

        // Check variable status bar item
        const variableItem = items[1];
        assert.strictEqual(variableItem.text, 'Variable: df');
        assert.strictEqual(variableItem.alignment, 1);
        assert.isDefined(variableItem.command);
        assert.strictEqual(variableItem.command.command, 'deepnote.updateSqlVariableName');
        assert.deepStrictEqual(variableItem.command.arguments, [cell]);
        assert.strictEqual(variableItem.priority, 90);
    });

    test('shows "Unknown integration (configure)" when config not found and not in project list', async () => {
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
        when(notebookManager.getOriginalProject('project-1')).thenReturn({
            project: {
                integrations: []
            }
        } as any);

        const result = await provider.provideCellStatusBarItems(cell, cancellationToken);

        assert.isDefined(result);
        assert.isArray(result);
        const items = result as any[];
        assert.strictEqual(items.length, 2);
        assert.strictEqual(items[0].text, '$(database) Unknown integration (configure)');
        assert.strictEqual(items[0].alignment, 1);
        assert.strictEqual(items[0].command.command, 'deepnote.switchSqlIntegration');
        assert.deepStrictEqual(items[0].command.arguments, [cell]);
        assert.strictEqual(items[1].text, 'Variable: df');
        assert.strictEqual(items[1].alignment, 1);
        assert.strictEqual(items[1].command.command, 'deepnote.updateSqlVariableName');
        assert.strictEqual(items[1].priority, 90);
    });

    test('shows integration name from project list with (configure) suffix when config not found but integration is in project', async () => {
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
        when(notebookManager.getOriginalProject('project-1')).thenReturn({
            project: {
                integrations: [
                    {
                        id: integrationId,
                        name: 'Production Database',
                        type: 'pgsql'
                    }
                ]
            }
        } as any);

        const result = await provider.provideCellStatusBarItems(cell, cancellationToken);

        assert.isDefined(result);
        assert.isArray(result);
        const items = result as any[];
        assert.strictEqual(items.length, 2);
        assert.strictEqual(items[0].text, '$(database) Production Database (configure)');
        assert.strictEqual(items[0].alignment, 1);
        assert.strictEqual(items[0].command.command, 'deepnote.switchSqlIntegration');
        assert.deepStrictEqual(items[0].command.arguments, [cell]);
        assert.strictEqual(items[1].text, 'Variable: df');
        assert.strictEqual(items[1].alignment, 1);
        assert.strictEqual(items[1].command.command, 'deepnote.updateSqlVariableName');
        assert.strictEqual(items[1].priority, 90);
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
        assert.strictEqual(variableItem.command.command, 'deepnote.updateSqlVariableName');
        assert.deepStrictEqual(variableItem.command.arguments, [cell]);
        assert.strictEqual(variableItem.priority, 90);
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
        assert.strictEqual(variableItem.alignment, 1);
        assert.strictEqual(variableItem.command.command, 'deepnote.updateSqlVariableName');
    });

    suite('activate', () => {
        let activateDisposables: IDisposableRegistry;
        let activateProvider: SqlCellStatusBarProvider;
        let activateIntegrationStorage: IIntegrationStorage;
        let activateNotebookManager: IDeepnoteNotebookManager;

        setup(() => {
            resetVSCodeMocks();
            activateDisposables = [];
            activateIntegrationStorage = mock<IIntegrationStorage>();
            activateNotebookManager = mock<IDeepnoteNotebookManager>();
            activateProvider = new SqlCellStatusBarProvider(
                activateDisposables,
                instance(activateIntegrationStorage),
                instance(activateNotebookManager)
            );
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

        test('listens to integration storage changes', () => {
            const onDidChangeIntegrations = new EventEmitter<void>();
            when(activateIntegrationStorage.onDidChangeIntegrations).thenReturn(onDidChangeIntegrations.event);

            activateProvider.activate();

            // Verify the listener was registered by checking disposables
            assert.isTrue(activateDisposables.length > 0);
        });

        test('registers workspace.onDidChangeNotebookDocument listener', () => {
            const onDidChangeIntegrations = new EventEmitter<void>();
            when(activateIntegrationStorage.onDidChangeIntegrations).thenReturn(onDidChangeIntegrations.event);

            activateProvider.activate();

            verify(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument(anything())).once();
        });

        test('disposes the event emitter', () => {
            const onDidChangeIntegrations = new EventEmitter<void>();
            when(activateIntegrationStorage.onDidChangeIntegrations).thenReturn(onDidChangeIntegrations.event);

            activateProvider.activate();

            // Verify the emitter is added to disposables
            assert.isTrue(activateDisposables.length > 0);
        });
    });

    suite('event listeners', () => {
        let eventDisposables: IDisposableRegistry;
        let eventProvider: SqlCellStatusBarProvider;
        let eventIntegrationStorage: IIntegrationStorage;
        let eventNotebookManager: IDeepnoteNotebookManager;

        setup(() => {
            eventDisposables = [];
            eventIntegrationStorage = mock<IIntegrationStorage>();
            eventNotebookManager = mock<IDeepnoteNotebookManager>();
            eventProvider = new SqlCellStatusBarProvider(
                eventDisposables,
                instance(eventIntegrationStorage),
                instance(eventNotebookManager)
            );
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

        test('fires onDidChangeCellStatusBarItems when deepnote notebook changes', () => {
            const onDidChangeIntegrations = new EventEmitter<void>();
            const onDidChangeNotebookDocument = new EventEmitter<any>();
            when(eventIntegrationStorage.onDidChangeIntegrations).thenReturn(onDidChangeIntegrations.event);
            when(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument(anything())).thenCall((handler) => {
                onDidChangeNotebookDocument.event(handler);
                return {
                    dispose: () => {
                        return;
                    }
                };
            });

            eventProvider.activate();

            const statusBarChangeHandler = createEventHandler(
                eventProvider,
                'onDidChangeCellStatusBarItems',
                eventDisposables
            );

            // Fire notebook document change event for deepnote notebook
            onDidChangeNotebookDocument.fire({
                notebook: {
                    notebookType: 'deepnote'
                }
            });

            assert.strictEqual(statusBarChangeHandler.count, 1, 'onDidChangeCellStatusBarItems should fire once');
        });

        test('does not fire onDidChangeCellStatusBarItems when non-deepnote notebook changes', () => {
            const onDidChangeIntegrations = new EventEmitter<void>();
            const onDidChangeNotebookDocument = new EventEmitter<any>();
            when(eventIntegrationStorage.onDidChangeIntegrations).thenReturn(onDidChangeIntegrations.event);
            when(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument(anything())).thenCall((handler) => {
                onDidChangeNotebookDocument.event(handler);
                return {
                    dispose: () => {
                        return;
                    }
                };
            });

            eventProvider.activate();

            const statusBarChangeHandler = createEventHandler(
                eventProvider,
                'onDidChangeCellStatusBarItems',
                eventDisposables
            );

            // Fire notebook document change event for non-deepnote notebook
            onDidChangeNotebookDocument.fire({
                notebook: {
                    notebookType: 'jupyter-notebook'
                }
            });

            assert.strictEqual(
                statusBarChangeHandler.count,
                0,
                'onDidChangeCellStatusBarItems should not fire for non-deepnote notebooks'
            );
        });
    });

    suite('updateSqlVariableName command handler', () => {
        let commandDisposables: IDisposableRegistry;
        let commandProvider: SqlCellStatusBarProvider;
        let commandIntegrationStorage: IIntegrationStorage;
        let commandNotebookManager: IDeepnoteNotebookManager;
        let updateVariableNameHandler: Function;

        setup(() => {
            resetVSCodeMocks();
            commandDisposables = [];
            commandIntegrationStorage = mock<IIntegrationStorage>();
            commandNotebookManager = mock<IDeepnoteNotebookManager>();
            commandProvider = new SqlCellStatusBarProvider(
                commandDisposables,
                instance(commandIntegrationStorage),
                instance(commandNotebookManager)
            );

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

        test('validates input - accepts valid Python identifier', async () => {
            const cell = createMockCell('sql', {});

            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenCall((options) => {
                const validationResult = options.validateInput('valid_name');
                assert.isUndefined(validationResult, 'Valid input should return undefined');
                return Promise.resolve('valid_name');
            });
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

            await updateVariableNameHandler(cell);
        });

        test('falls back to active cell when no cell is provided', async () => {
            const cell = createMockCell('sql', { deepnote_variable_name: 'old_name' });
            const newVariableName = 'new_name';

            // Mock active notebook editor
            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn({
                selection: { start: 0 },
                notebook: {
                    cellAt: (_index: number) => cell
                }
            } as any);

            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(newVariableName));
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

            // Call without providing a cell
            await updateVariableNameHandler();

            verify(mockedVSCodeNamespaces.window.showInputBox(anything())).once();
            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
        });

        test('shows error when no cell is provided and no active editor', async () => {
            // Mock no active notebook editor
            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);

            // Call without providing a cell
            await updateVariableNameHandler();

            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
            verify(mockedVSCodeNamespaces.window.showInputBox(anything())).never();
        });

        test('shows error when no cell is provided and active editor has no selection', async () => {
            // Mock active notebook editor without selection
            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn({
                selection: undefined
            } as any);

            // Call without providing a cell
            await updateVariableNameHandler();

            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
            verify(mockedVSCodeNamespaces.window.showInputBox(anything())).never();
        });
    });

    suite('switchSqlIntegration command handler', () => {
        let commandDisposables: IDisposableRegistry;
        let commandProvider: SqlCellStatusBarProvider;
        let commandIntegrationStorage: IIntegrationStorage;
        let commandNotebookManager: IDeepnoteNotebookManager;
        let switchIntegrationHandler: Function;

        setup(() => {
            resetVSCodeMocks();
            commandDisposables = [];
            commandIntegrationStorage = mock<IIntegrationStorage>();
            commandNotebookManager = mock<IDeepnoteNotebookManager>();
            commandProvider = new SqlCellStatusBarProvider(
                commandDisposables,
                instance(commandIntegrationStorage),
                instance(commandNotebookManager)
            );

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
            const notebookMetadata = { deepnoteProjectId: 'project-1' };
            const cell = createMockCell('sql', { sql_integration_id: 'old-integration' }, notebookMetadata);
            const newIntegrationId = 'new-integration';

            when(commandNotebookManager.getOriginalProject('project-1')).thenReturn({
                project: {
                    integrations: [
                        {
                            id: newIntegrationId,
                            name: 'New Integration',
                            type: 'pgsql'
                        }
                    ]
                }
            } as any);

            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ id: newIntegrationId, label: 'New Integration' } as any)
            );
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

            await switchIntegrationHandler(cell);

            verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).once();
            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
        });

        test('does not update if user cancels quick pick', async () => {
            const notebookMetadata = { deepnoteProjectId: 'project-1' };
            const cell = createMockCell('sql', { sql_integration_id: 'old-integration' }, notebookMetadata);

            when(commandNotebookManager.getOriginalProject('project-1')).thenReturn({
                project: {
                    integrations: []
                }
            } as any);
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve(undefined)
            );

            await switchIntegrationHandler(cell);

            verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).once();
            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
        });

        test('shows error message if workspace edit fails', async () => {
            const notebookMetadata = { deepnoteProjectId: 'project-1' };
            const cell = createMockCell('sql', { sql_integration_id: 'old-integration' }, notebookMetadata);
            const newIntegrationId = 'new-integration';

            when(commandNotebookManager.getOriginalProject('project-1')).thenReturn({
                project: {
                    integrations: []
                }
            } as any);
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ id: newIntegrationId, label: 'New Integration' } as any)
            );
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(false));

            await switchIntegrationHandler(cell);

            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
        });

        test('fires onDidChangeCellStatusBarItems after successful update', async () => {
            const notebookMetadata = { deepnoteProjectId: 'project-1' };
            const cell = createMockCell('sql', { sql_integration_id: 'old-integration' }, notebookMetadata);
            const newIntegrationId = 'new-integration';

            when(commandNotebookManager.getOriginalProject('project-1')).thenReturn({
                project: {
                    integrations: []
                }
            } as any);
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));
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
            const notebookMetadata = { deepnoteProjectId: 'project-1' };
            const cell = createMockCell('sql', { sql_integration_id: 'current-integration' }, notebookMetadata);

            when(commandNotebookManager.getOriginalProject('project-1')).thenReturn({
                project: {
                    integrations: []
                }
            } as any);
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));
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
            const notebookMetadata = { deepnoteProjectId: 'project-1' };
            const cell = createMockCell('sql', {}, notebookMetadata);
            let quickPickItems: any[] = [];

            when(commandNotebookManager.getOriginalProject('project-1')).thenReturn({
                project: {
                    integrations: []
                }
            } as any);
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenCall((items) => {
                quickPickItems = items;
                return Promise.resolve(undefined);
            });

            await switchIntegrationHandler(cell);

            const duckDbItem = quickPickItems.find((item) => item.id === DATAFRAME_SQL_INTEGRATION_ID);
            assert.isDefined(duckDbItem, 'DuckDB integration should be in quick pick items');
            assert.strictEqual(duckDbItem.label, 'DataFrame SQL (DuckDB)');
        });

        test('shows BigQuery type label for BigQuery integrations', async () => {
            const notebookMetadata = { deepnoteProjectId: 'project-1' };
            const cell = createMockCell('sql', {}, notebookMetadata);
            let quickPickItems: any[] = [];

            when(commandNotebookManager.getOriginalProject('project-1')).thenReturn({
                project: {
                    integrations: [
                        {
                            id: 'bigquery-integration',
                            name: 'My BigQuery',
                            type: 'big-query'
                        }
                    ]
                }
            } as any);
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenCall((items) => {
                quickPickItems = items;
                return Promise.resolve(undefined);
            });

            await switchIntegrationHandler(cell);

            const bigQueryItem = quickPickItems.find((item) => item.id === 'bigquery-integration');
            assert.isDefined(bigQueryItem, 'BigQuery integration should be in quick pick items');
            assert.strictEqual(bigQueryItem.description, 'BigQuery');
        });

        test('shows raw type for unknown integration types', async () => {
            const notebookMetadata = { deepnoteProjectId: 'project-1' };
            const cell = createMockCell('sql', {}, notebookMetadata);
            let quickPickItems: any[] = [];

            when(commandNotebookManager.getOriginalProject('project-1')).thenReturn({
                project: {
                    integrations: [
                        {
                            id: 'unknown-integration',
                            name: 'Unknown DB',
                            type: 'unknown_type'
                        }
                    ]
                }
            } as any);
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenCall((items) => {
                quickPickItems = items;
                return Promise.resolve(undefined);
            });

            await switchIntegrationHandler(cell);

            const unknownItem = quickPickItems.find((item) => item.id === 'unknown-integration');
            assert.isDefined(unknownItem, 'Unknown integration should be in quick pick items');
            assert.strictEqual(unknownItem.description, 'unknown_type');
        });

        test('marks current integration as selected in quick pick', async () => {
            const currentIntegrationId = 'current-integration';
            const notebookMetadata = { deepnoteProjectId: 'project-1' };
            const cell = createMockCell('sql', { sql_integration_id: currentIntegrationId }, notebookMetadata);
            let quickPickItems: any[] = [];

            when(commandNotebookManager.getOriginalProject('project-1')).thenReturn({
                project: {
                    integrations: [
                        {
                            id: currentIntegrationId,
                            name: 'Current Integration',
                            type: 'pgsql'
                        }
                    ]
                }
            } as any);
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenCall((items) => {
                quickPickItems = items;
                return Promise.resolve(undefined);
            });

            await switchIntegrationHandler(cell);

            const currentItem = quickPickItems.find((item) => item.id === currentIntegrationId);
            assert.isDefined(currentItem, 'Current integration should be in quick pick items');
            assert.strictEqual(currentItem.detail, 'Currently selected');
        });

        test('shows error message when project ID is missing', async () => {
            const cell = createMockCell('sql', {}, {}); // No notebook metadata

            await switchIntegrationHandler(cell);

            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
            verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).never();
        });

        test('shows error message when project is not found', async () => {
            const notebookMetadata = { deepnoteProjectId: 'missing-project' };
            const cell = createMockCell('sql', {}, notebookMetadata);

            when(commandNotebookManager.getOriginalProject('missing-project')).thenReturn(undefined);

            await switchIntegrationHandler(cell);

            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
            verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).never();
        });

        test('skips DATAFRAME_SQL_INTEGRATION_ID from project integrations list', async () => {
            const notebookMetadata = { deepnoteProjectId: 'project-1' };
            const cell = createMockCell('sql', {}, notebookMetadata);
            let quickPickItems: any[] = [];

            when(commandNotebookManager.getOriginalProject('project-1')).thenReturn({
                project: {
                    integrations: [
                        {
                            id: DATAFRAME_SQL_INTEGRATION_ID,
                            name: 'Should be skipped',
                            type: 'duckdb'
                        },
                        {
                            id: 'postgres-integration',
                            name: 'PostgreSQL',
                            type: 'pgsql'
                        }
                    ]
                }
            } as any);
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenCall((items) => {
                quickPickItems = items;
                return Promise.resolve(undefined);
            });

            await switchIntegrationHandler(cell);

            // Should have 2 items: postgres-integration and DuckDB (added separately)
            const projectIntegrationItems = quickPickItems.filter(
                (item) => item.id && item.id !== DATAFRAME_SQL_INTEGRATION_ID
            );
            assert.strictEqual(
                projectIntegrationItems.length,
                1,
                'Should have only 1 project integration (DATAFRAME_SQL_INTEGRATION_ID should be skipped)'
            );
            assert.strictEqual(projectIntegrationItems[0].id, 'postgres-integration');

            // DuckDB should still be in the list (added separately)
            const duckDbItem = quickPickItems.find((item) => item.id === DATAFRAME_SQL_INTEGRATION_ID);
            assert.isDefined(duckDbItem, 'DuckDB should still be in the list');
        });

        test('falls back to active cell when no cell is provided', async () => {
            const notebookMetadata = { deepnoteProjectId: 'project-1' };
            const cell = createMockCell('sql', { sql_integration_id: 'old-integration' }, notebookMetadata);
            const newIntegrationId = 'new-integration';

            // Mock active notebook editor
            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn({
                selection: { start: 0 },
                notebook: {
                    cellAt: (_index: number) => cell
                }
            } as any);

            when(commandNotebookManager.getOriginalProject('project-1')).thenReturn({
                project: {
                    integrations: [
                        {
                            id: newIntegrationId,
                            name: 'New Integration',
                            type: 'pgsql'
                        }
                    ]
                }
            } as any);

            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ id: newIntegrationId, label: 'New Integration' } as any)
            );
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

            // Call without providing a cell
            await switchIntegrationHandler();

            verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).once();
            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
        });

        test('shows error when no cell is provided and no active editor', async () => {
            // Mock no active notebook editor
            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);

            // Call without providing a cell
            await switchIntegrationHandler();

            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
            verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).never();
        });

        test('shows error when no cell is provided and active editor has no selection', async () => {
            // Mock active notebook editor without selection
            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn({
                selection: undefined
            } as any);

            // Call without providing a cell
            await switchIntegrationHandler();

            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
            verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).never();
        });

        test('does not update when selected integration is same as current', async () => {
            const currentIntegrationId = 'current-integration';
            const notebookMetadata = { deepnoteProjectId: 'project-1' };
            const cell = createMockCell('sql', { sql_integration_id: currentIntegrationId }, notebookMetadata);

            when(commandNotebookManager.getOriginalProject('project-1')).thenReturn({
                project: {
                    integrations: [
                        {
                            id: currentIntegrationId,
                            name: 'Current Integration',
                            type: 'pgsql'
                        }
                    ]
                }
            } as any);
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ id: currentIntegrationId, label: 'Current Integration' } as any)
            );

            await switchIntegrationHandler(cell);

            verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).once();
            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
        });

        test('does not update when selected item has no id property', async () => {
            const notebookMetadata = { deepnoteProjectId: 'project-1' };
            const cell = createMockCell('sql', { sql_integration_id: 'current-integration' }, notebookMetadata);

            when(commandNotebookManager.getOriginalProject('project-1')).thenReturn({
                project: {
                    integrations: []
                }
            } as any);
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenReturn(Promise.resolve(undefined));
            // Return an item without an id property (e.g., a separator)
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve({ kind: -1 } as any)
            );

            await switchIntegrationHandler(cell);

            verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).once();
            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
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
