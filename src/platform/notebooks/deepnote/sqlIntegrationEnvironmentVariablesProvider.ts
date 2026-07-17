import { inject, injectable, optional } from 'inversify';
import { CancellationToken, Event, EventEmitter, Uri } from 'vscode';

import { DeepnoteFile } from '@deepnote/blocks';
import {
    DatabaseIntegrationConfig,
    FederatedAuthMethod,
    getEnvironmentVariablesForIntegrations,
    isFederatedAuthMethod
} from '@deepnote/database-integrations';

import { IDisposableRegistry, Resource } from '../../common/types';
import { EnvironmentVariables } from '../../common/variables/types';
import { notebookPathToDeepnoteProjectFilePath } from '../../deepnote/deepnoteProjectUtils';
import { logger } from '../../logging';
import {
    IIntegrationsFileConfigProvider,
    IIntegrationStorage,
    ISqlIntegrationEnvVarsProvider,
    IPlatformNotebookEditorProvider,
    IPlatformDeepnoteNotebookManager
} from './types';
import { DATAFRAME_SQL_INTEGRATION_ID } from './integrationTypes';

/** One entry of a Deepnote project's `integrations` list. */
type ProjectIntegration = NonNullable<DeepnoteFile['project']['integrations']>[number];

/** Narrows metadata to the federated-auth variant; upstream `isFederatedAuthMetadata` can't be reused because its generic doesn't unify with our union. Delegates to upstream `isFederatedAuthMethod` at runtime. */
function isFederatedAuthMetadata(
    metadata: DatabaseIntegrationConfig['metadata']
): metadata is Extract<DatabaseIntegrationConfig['metadata'], { authMethod: FederatedAuthMethod }> {
    if (typeof metadata !== 'object' || metadata === null) {
        return false;
    }
    if (!('authMethod' in metadata)) {
        return false;
    }
    const authMethod = metadata.authMethod;
    return typeof authMethod === 'string' && isFederatedAuthMethod(authMethod);
}

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
        @inject(IDisposableRegistry) disposables: IDisposableRegistry,
        @inject(IIntegrationsFileConfigProvider)
        @optional()
        private readonly fileConfigProvider?: IIntegrationsFileConfigProvider
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
        const notebookId = notebook.metadata?.deepnoteNotebookId as string | undefined;
        if (!projectId || !notebookId) {
            logger.trace(
                `SqlIntegrationEnvironmentVariablesProvider: No project/notebook ID found in notebook metadata`
            );
            return {};
        }

        logger.trace(`SqlIntegrationEnvironmentVariablesProvider: Project ID: ${projectId}`);

        // Get the project from the notebook manager
        const project = this.notebookManager.getProjectForNotebook(projectId, notebookId);
        if (!project) {
            logger.trace(`SqlIntegrationEnvironmentVariablesProvider: No project found for ID: ${projectId}`);
            return {};
        }

        // Get the list of integrations from the project
        const projectIntegrations = project.project.integrations?.slice() ?? [];
        logger.trace(
            `SqlIntegrationEnvironmentVariablesProvider: Found ${projectIntegrations.length} integrations in project`
        );

        const fileConfigs = await this.loadFileConfigs(notebook.uri);
        const allConfigs = await this.mergeIntegrationConfigs(projectIntegrations, fileConfigs);

        // Skip federated-auth integrations: tokens are fetched per-cell via per-cell codegen in `FederatedAuthSqlBlockCodeGenerator`, not baked into kernel env.
        const projectIntegrationConfigs: Array<DatabaseIntegrationConfig> = [];
        for (const config of allConfigs) {
            if (isFederatedAuthMetadata(config.metadata)) {
                logger.debug(
                    `SqlIntegrationEnvironmentVariablesProvider: Skipping federated integration ${config.id} (${config.type}); per-cell codegen in FederatedAuthSqlBlockCodeGenerator handles its token.`
                );
                continue;
            }
            projectIntegrationConfigs.push(config);
        }

        // Always add the internal DuckDB integration
        projectIntegrationConfigs.push({
            id: DATAFRAME_SQL_INTEGRATION_ID,
            name: 'Dataframe SQL (DuckDB)',
            type: 'pandas-dataframe',
            metadata: {}
        });

        const { envVars: envVarList, errors } = getEnvironmentVariablesForIntegrations(projectIntegrationConfigs, {
            projectRootDirectory: '',
            snowflakePartnerIdentifier: 'Deepnote_Workspaces'
        });

        errors.forEach((error) => {
            logger.error(`SqlIntegrationEnvironmentVariablesProvider: ${error.message}`);
        });

        const envVars: EnvironmentVariables = Object.fromEntries(envVarList.map(({ name, value }) => [name, value]));
        logger.trace(`SqlIntegrationEnvironmentVariablesProvider: Returning ${Object.keys(envVars).length} env vars`);

        return envVars;
    }

    /** Loads `.deepnote.env.yaml` configs (CLI parity) when a file source is present; failures — or no provider, e.g. web — degrade to []. */
    private async loadFileConfigs(notebookUri: Uri): Promise<DatabaseIntegrationConfig[]> {
        if (!this.fileConfigProvider) {
            return [];
        }

        try {
            const result = await this.fileConfigProvider.getConfigsForFile(
                notebookPathToDeepnoteProjectFilePath(notebookUri)
            );
            result.issues.forEach((issue) => {
                logger.warn(
                    `SqlIntegrationEnvironmentVariablesProvider: integrations file issue ${issue.code} at '${issue.path}': ${issue.message}`
                );
            });

            return result.configs;
        } catch (error) {
            logger.error(
                'SqlIntegrationEnvironmentVariablesProvider: file integrations source failed; falling back to SecretStorage',
                error
            );

            return [];
        }
    }

    /** File config wins on id conflict; SecretStorage is the fallback for project ids the file lacks; file-only ids are appended additively (CLI parity). */
    private async mergeIntegrationConfigs(
        projectIntegrations: ProjectIntegration[],
        fileConfigs: DatabaseIntegrationConfig[]
    ): Promise<DatabaseIntegrationConfig[]> {
        const fileConfigsById = new Map(fileConfigs.map((config) => [config.id, config]));
        const consumedFileIds = new Set<string>();

        // Read from SecretStorage only the project integrations the file did not provide.
        const secretStorageIds = projectIntegrations
            .map((integration) => integration.id)
            .filter((id) => !fileConfigsById.has(id));
        const secretStorageResults = await Promise.allSettled(
            secretStorageIds.map((id) => this.integrationStorage.getIntegrationConfig(id))
        );
        const secretStorageConfigsById = new Map<string, DatabaseIntegrationConfig>();
        secretStorageResults.forEach((result, index) => {
            const id = secretStorageIds[index];
            if (result.status === 'fulfilled') {
                if (result.value) {
                    secretStorageConfigsById.set(id, result.value);
                }

                return;
            }
            logger.error(
                `SqlIntegrationEnvironmentVariablesProvider: Failed to load integration config ${id}`,
                result.reason
            );
        });

        // Resolve each project integration in declared order: file config wins, else the SecretStorage fallback.
        const allConfigs: Array<DatabaseIntegrationConfig> = [];
        for (const integration of projectIntegrations) {
            const fileConfig = fileConfigsById.get(integration.id);
            if (fileConfig) {
                consumedFileIds.add(integration.id);
                allConfigs.push(fileConfig);

                continue;
            }
            const secretStorageConfig = secretStorageConfigsById.get(integration.id);
            if (secretStorageConfig) {
                allConfigs.push(secretStorageConfig);
            }
        }

        // Append file-only integrations (not declared in project.integrations) additively, deduped by the map.
        for (const fileConfig of fileConfigsById.values()) {
            if (!consumedFileIds.has(fileConfig.id)) {
                allConfigs.push(fileConfig);
            }
        }

        return allConfigs;
    }
}
