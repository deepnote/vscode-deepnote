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

    test('returns undefined for SQL cells without integration ID', async () => {
        const cell = createMockCell('sql', {});

        const result = await provider.provideCellStatusBarItems(cell, cancellationToken);

        assert.isUndefined(result);
    });

    test('returns undefined for SQL cells with dataframe integration ID', async () => {
        const cell = createMockCell('sql', {
            sql_integration_id: DATAFRAME_SQL_INTEGRATION_ID
        });

        const result = await provider.provideCellStatusBarItems(cell, cancellationToken);

        assert.isUndefined(result);
    });

    test('returns status bar item for SQL cell with integration ID', async () => {
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
        assert.strictEqual((result as any).text, '$(database) My Postgres DB');
        assert.strictEqual((result as any).alignment, 1); // NotebookCellStatusBarAlignment.Left
        assert.isDefined((result as any).command);
        assert.strictEqual((result as any).command.command, 'deepnote.manageIntegrations');
        assert.deepStrictEqual((result as any).command.arguments, [integrationId]);
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
        assert.strictEqual((result as any).text, '$(database) Unknown integration (configure)');
    });

    test('returns undefined when notebook has no project ID', async () => {
        const integrationId = 'postgres-123';
        const cell = createMockCell('sql', {
            sql_integration_id: integrationId
        });

        const result = await provider.provideCellStatusBarItems(cell, cancellationToken);

        assert.isUndefined(result);
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
