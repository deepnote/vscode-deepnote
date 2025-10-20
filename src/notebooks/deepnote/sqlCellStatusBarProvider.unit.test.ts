import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';
import {
    CancellationToken,
    CancellationTokenSource,
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
