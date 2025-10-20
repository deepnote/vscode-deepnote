import {
    CancellationToken,
    EventEmitter,
    NotebookCell,
    NotebookCellStatusBarItem,
    NotebookCellStatusBarItemProvider,
    NotebookDocument,
    ProviderResult,
    l10n,
    notebooks
} from 'vscode';
import { inject, injectable } from 'inversify';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { Commands } from '../../platform/common/constants';
import { IIntegrationStorage } from './integrations/types';
import { DATAFRAME_SQL_INTEGRATION_ID } from './integrations/integrationTypes';

/**
 * Provides status bar items for SQL cells showing the integration name
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

        // Get the integration ID from cell metadata
        const integrationId = this.getIntegrationId(cell);
        if (!integrationId) {
            return undefined;
        }

        // Don't show status bar for the internal DuckDB integration
        if (integrationId === DATAFRAME_SQL_INTEGRATION_ID) {
            return undefined;
        }

        return this.createStatusBarItem(cell.notebook, integrationId);
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

    private async createStatusBarItem(
        notebook: NotebookDocument,
        integrationId: string
    ): Promise<NotebookCellStatusBarItem | undefined> {
        const projectId = notebook.metadata?.deepnoteProjectId;
        if (!projectId) {
            return undefined;
        }

        // Get integration configuration to display the name
        const config = await this.integrationStorage.getIntegrationConfig(projectId, integrationId);
        const displayName = config?.name || l10n.t('Unknown integration (configure)');

        // Create a status bar item that opens the integration management UI
        return {
            text: `$(database) ${displayName}`,
            alignment: 1, // NotebookCellStatusBarAlignment.Left
            tooltip: l10n.t('SQL Integration: {0}\nClick to configure', displayName),
            command: {
                title: l10n.t('Configure Integration'),
                command: Commands.ManageIntegrations,
                arguments: [integrationId]
            }
        };
    }
}
