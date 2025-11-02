import { inject, injectable } from 'inversify';
import { CancellationToken, Event, EventEmitter } from 'vscode';

import { IDisposableRegistry, Resource } from '../../common/types';
import { EnvironmentVariables } from '../../common/variables/types';
import { logger } from '../../logging';
import {
    IIntegrationStorage,
    ISqlIntegrationEnvVarsProvider,
    IPlatformNotebookEditorProvider,
    IPlatformDeepnoteNotebookManager
} from './types';
import { DATAFRAME_SQL_INTEGRATION_ID } from './integrationTypes';
import { getEnvironmentVariablesForIntegrations } from '@deepnote/database-integrations';

/**
 * Provides environment variables for SQL integrations.
 * This service provides credentials for all configured integrations in the project
 * as environment variables so they can be used during SQL block execution.
 */
@injectable()
export class SqlIntegrationEnvironmentVariablesProvider implements ISqlIntegrationEnvVarsProvider {
    private readonly _onDidChangeEnvironmentVariables = new EventEmitter<Resource>();

    public readonly onDidChangeEnvironmentVariables: Event<Resource> = this._onDidChangeEnvironmentVariables.event;

    constructor(
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage,
        @inject(IPlatformNotebookEditorProvider)
        private readonly notebookEditorProvider: IPlatformNotebookEditorProvider,
        @inject(IPlatformDeepnoteNotebookManager) private readonly notebookManager: IPlatformDeepnoteNotebookManager,
        @inject(IDisposableRegistry) disposables: IDisposableRegistry
    ) {
        logger.info('SqlIntegrationEnvironmentVariablesProvider: Constructor called - provider is being instantiated');
        // Dispose emitter when extension deactivates
        disposables.push(this._onDidChangeEnvironmentVariables);
        // Listen for changes to integration storage and fire change event
        disposables.push(
            this.integrationStorage.onDidChangeIntegrations(() => {
                // Fire change event for all notebooks
                this._onDidChangeEnvironmentVariables.fire(undefined);
            })
        );
    }

    /**
     * Get environment variables for SQL integrations.
     * Provides credentials for all integrations in the Deepnote project.
     * The internal DuckDB integration is always included.
     */
    public async getEnvironmentVariables(resource: Resource, token?: CancellationToken): Promise<EnvironmentVariables> {
        if (!resource) {
            return {};
        }

        if (token?.isCancellationRequested) {
            return {};
        }

        logger.trace(`SqlIntegrationEnvironmentVariablesProvider: Getting env vars for resource`);

        // Get the notebook document from the resource
        const notebook = this.notebookEditorProvider.findAssociatedNotebookDocument(resource);
        if (!notebook) {
            logger.trace(`SqlIntegrationEnvironmentVariablesProvider: No notebook found for resource`);
            return {};
        }

        // Get the project ID from the notebook metadata
        const projectId = notebook.metadata?.deepnoteProjectId as string | undefined;
        if (!projectId) {
            logger.trace(`SqlIntegrationEnvironmentVariablesProvider: No project ID found in notebook metadata`);
            return {};
        }

        logger.trace(`SqlIntegrationEnvironmentVariablesProvider: Project ID: ${projectId}`);

        // Get the project from the notebook manager
        const project = this.notebookManager.getOriginalProject(projectId);
        if (!project) {
            logger.trace(`SqlIntegrationEnvironmentVariablesProvider: No project found for ID: ${projectId}`);
            return {};
        }

        // Get the list of integrations from the project
        const projectIntegrations = project.project.integrations?.slice() ?? [];
        logger.trace(
            `SqlIntegrationEnvironmentVariablesProvider: Found ${projectIntegrations.length} integrations in project`
        );

        const projectIntegrationConfigs = (
            await Promise.all(
                projectIntegrations.map((integration) => {
                    return this.integrationStorage.getIntegrationConfig(integration.id);
                })
            )
        ).filter((config) => config != null);

        // Always add the internal DuckDB integration
        projectIntegrationConfigs.push({
            id: DATAFRAME_SQL_INTEGRATION_ID,
            name: 'Dataframe SQL (DuckDB)',
            type: 'pandas-dataframe',
            metadata: {}
        });

        const { envVars: envVarList, errors } = getEnvironmentVariablesForIntegrations(projectIntegrationConfigs, {
            projectRootDirectory: ''
        });

        errors.forEach((error) => {
            logger.error(`SqlIntegrationEnvironmentVariablesProvider: ${error.message}`);
        });

        const envVars: EnvironmentVariables = Object.fromEntries(envVarList.map(({ name, value }) => [name, value]));
        logger.trace(`SqlIntegrationEnvironmentVariablesProvider: Returning ${Object.keys(envVars).length} env vars`);

        return envVars;
    }
}
