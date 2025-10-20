import {
    CancellationToken,
    EventEmitter,
    NotebookCell,
    NotebookCellStatusBarItem,
    NotebookCellStatusBarItemProvider,
    NotebookEdit,
    ProviderResult,
    QuickPickItem,
    QuickPickItemKind,
    WorkspaceEdit,
    commands,
    l10n,
    notebooks,
    window,
    workspace
} from 'vscode';
import { inject, injectable } from 'inversify';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { IIntegrationStorage } from './integrations/types';
import { Commands } from '../../platform/common/constants';
import { DATAFRAME_SQL_INTEGRATION_ID, IntegrationType } from '../../platform/notebooks/deepnote/integrationTypes';

/**
 * Provides status bar items for SQL cells showing the integration name and variable name
 */
@injectable()
export class SqlCellStatusBarProvider implements NotebookCellStatusBarItemProvider, IExtensionSyncActivationService {
    private readonly _onDidChangeCellStatusBarItems = new EventEmitter<void>();

    public readonly onDidChangeCellStatusBarItems = this._onDidChangeCellStatusBarItems.event;

    constructor(
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry,
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage
    ) {}

    public activate(): void {
        // Register the status bar provider for Deepnote notebooks
        this.disposables.push(notebooks.registerNotebookCellStatusBarItemProvider('deepnote', this));

        // Listen for integration configuration changes to update status bar
        this.disposables.push(
            this.integrationStorage.onDidChangeIntegrations(() => {
                this._onDidChangeCellStatusBarItems.fire();
            })
        );

        // Register command to update SQL variable name
        this.disposables.push(
            commands.registerCommand('deepnote.updateSqlVariableName', async (cell: NotebookCell) => {
                await this.updateVariableName(cell);
            })
        );

        // Register command to switch SQL integration
        this.disposables.push(
            commands.registerCommand('deepnote.switchSqlIntegration', async (cell: NotebookCell) => {
                await this.switchIntegration(cell);
            })
        );

        // Dispose our emitter with the extension
        this.disposables.push(this._onDidChangeCellStatusBarItems);
    }

    public provideCellStatusBarItems(
        cell: NotebookCell,
        token: CancellationToken
    ): ProviderResult<NotebookCellStatusBarItem | NotebookCellStatusBarItem[]> {
        if (token?.isCancellationRequested) {
            return undefined;
        }

        // Only show status bar for SQL cells
        if (cell.document.languageId !== 'sql') {
            return undefined;
        }

        return this.createStatusBarItems(cell);
    }

    private getIntegrationId(cell: NotebookCell): string | undefined {
        // Check cell metadata for sql_integration_id
        const metadata = cell.metadata;
        if (metadata && typeof metadata === 'object') {
            const integrationId = (metadata as Record<string, unknown>).sql_integration_id;
            if (typeof integrationId === 'string') {
                return integrationId;
            }
        }

        return undefined;
    }

    private async createStatusBarItems(cell: NotebookCell): Promise<NotebookCellStatusBarItem[]> {
        const items: NotebookCellStatusBarItem[] = [];

        // Add integration status bar item if integration ID is present
        const integrationId = this.getIntegrationId(cell);
        if (integrationId) {
            const integrationItem = await this.createIntegrationStatusBarItem(cell, integrationId);
            if (integrationItem) {
                items.push(integrationItem);
            }
        }

        // Always add variable status bar item for SQL cells
        items.push(this.createVariableStatusBarItem(cell));

        return items;
    }

    private async createIntegrationStatusBarItem(
        cell: NotebookCell,
        integrationId: string
    ): Promise<NotebookCellStatusBarItem | undefined> {
        // Handle internal DuckDB integration specially
        if (integrationId === DATAFRAME_SQL_INTEGRATION_ID) {
            return {
                text: `$(database) ${l10n.t('DataFrame SQL (DuckDB)')}`,
                alignment: 1, // NotebookCellStatusBarAlignment.Left
                tooltip: l10n.t('Internal DuckDB integration for querying DataFrames\nClick to switch'),
                command: {
                    title: l10n.t('Switch Integration'),
                    command: 'deepnote.switchSqlIntegration',
                    arguments: [cell]
                }
            };
        }

        const projectId = cell.notebook.metadata?.deepnoteProjectId;
        if (!projectId) {
            return undefined;
        }

        // Get integration configuration to display the name
        const config = await this.integrationStorage.getProjectIntegrationConfig(projectId, integrationId);
        const displayName = config?.name || l10n.t('Unknown integration (configure)');

        // Create a status bar item that opens the integration picker
        return {
            text: `$(database) ${displayName}`,
            alignment: 1, // NotebookCellStatusBarAlignment.Left
            tooltip: l10n.t('SQL Integration: {0}\nClick to switch or configure', displayName),
            command: {
                title: l10n.t('Switch Integration'),
                command: 'deepnote.switchSqlIntegration',
                arguments: [cell]
            }
        };
    }

    private createVariableStatusBarItem(cell: NotebookCell): NotebookCellStatusBarItem {
        const variableName = this.getVariableName(cell);

        return {
            text: `Variable: ${variableName}`,
            alignment: 1, // NotebookCellStatusBarAlignment.Left
            tooltip: l10n.t('Variable name for SQL query result\nClick to change'),
            command: {
                title: l10n.t('Change Variable Name'),
                command: 'deepnote.updateSqlVariableName',
                arguments: [cell]
            }
        };
    }

    private getVariableName(cell: NotebookCell): string {
        const metadata = cell.metadata;
        if (metadata && typeof metadata === 'object') {
            const variableName = (metadata as Record<string, unknown>).deepnote_variable_name;
            if (typeof variableName === 'string' && variableName) {
                return variableName;
            }
        }

        return 'df';
    }

    private async updateVariableName(cell: NotebookCell): Promise<void> {
        const currentVariableName = this.getVariableName(cell);

        const newVariableName = await window.showInputBox({
            prompt: l10n.t('Enter variable name for SQL query result'),
            value: currentVariableName,
            validateInput: (value) => {
                if (!value) {
                    return l10n.t('Variable name cannot be empty');
                }
                if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
                    return l10n.t('Variable name must be a valid Python identifier');
                }
                return undefined;
            }
        });

        if (newVariableName === undefined || newVariableName === currentVariableName) {
            return;
        }

        // Update cell metadata
        const edit = new WorkspaceEdit();
        const updatedMetadata = {
            ...cell.metadata,
            deepnote_variable_name: newVariableName
        };

        edit.set(cell.notebook.uri, [NotebookEdit.updateCellMetadata(cell.index, updatedMetadata)]);

        await workspace.applyEdit(edit);

        // Trigger status bar update
        this._onDidChangeCellStatusBarItems.fire();
    }

    private async switchIntegration(cell: NotebookCell): Promise<void> {
        const currentIntegrationId = this.getIntegrationId(cell);

        // Get all available integrations
        const allIntegrations = await this.integrationStorage.getAll();

        // Build quick pick items
        const items: QuickPickItem[] = [];

        // Check if current integration is unknown (not in the list)
        const isCurrentIntegrationUnknown =
            currentIntegrationId &&
            currentIntegrationId !== DATAFRAME_SQL_INTEGRATION_ID &&
            !allIntegrations.some((i) => i.id === currentIntegrationId);

        // Add current unknown integration first if it exists
        if (isCurrentIntegrationUnknown && currentIntegrationId) {
            items.push({
                label: l10n.t('Unknown integration (configure)'),
                description: currentIntegrationId,
                detail: l10n.t('Currently selected'),
                id: currentIntegrationId
            } as QuickPickItem & { id: string });
        }

        // Add all configured integrations
        for (const integration of allIntegrations) {
            const typeLabel = this.getIntegrationTypeLabel(integration.type);
            items.push({
                label: integration.name || integration.id,
                description: typeLabel,
                detail: integration.id === currentIntegrationId ? l10n.t('Currently selected') : undefined,
                // Store the integration ID in a custom property
                id: integration.id
            } as QuickPickItem & { id: string });
        }

        // Add DuckDB integration
        items.push({
            label: l10n.t('DataFrame SQL (DuckDB)'),
            description: l10n.t('DuckDB'),
            detail: currentIntegrationId === DATAFRAME_SQL_INTEGRATION_ID ? l10n.t('Currently selected') : undefined,
            id: DATAFRAME_SQL_INTEGRATION_ID
        } as QuickPickItem & { id: string });

        // Add separator
        items.push({
            label: '',
            kind: QuickPickItemKind.Separator
        });

        // Add "Configure current integration" option
        if (currentIntegrationId && currentIntegrationId !== DATAFRAME_SQL_INTEGRATION_ID) {
            items.push({
                label: l10n.t('Configure current integration'),
                id: '__configure__'
            } as QuickPickItem & { id: string });
        }

        const selected = await window.showQuickPick(items, {
            placeHolder: l10n.t('Select SQL integration'),
            matchOnDescription: true
        });

        if (!selected) {
            return;
        }

        const selectedId = (selected as QuickPickItem & { id: string }).id;

        // Handle "Configure current integration" option
        if (selectedId === '__configure__' && currentIntegrationId) {
            await commands.executeCommand(Commands.ManageIntegrations, currentIntegrationId);
            return;
        }

        // Update cell metadata with new integration ID
        const edit = new WorkspaceEdit();
        const updatedMetadata = {
            ...cell.metadata,
            sql_integration_id: selectedId
        };

        edit.set(cell.notebook.uri, [NotebookEdit.updateCellMetadata(cell.index, updatedMetadata)]);

        await workspace.applyEdit(edit);

        // Trigger status bar update
        this._onDidChangeCellStatusBarItems.fire();
    }

    private getIntegrationTypeLabel(type: IntegrationType): string {
        switch (type) {
            case IntegrationType.Postgres:
                return l10n.t('PostgreSQL');
            case IntegrationType.BigQuery:
                return l10n.t('BigQuery');
            default:
                return type;
        }
    }
}
