import { inject, injectable } from 'inversify';
import { CancellationToken, Event, EventEmitter, l10n } from 'vscode';

import { IDisposableRegistry, Resource } from '../../common/types';
import { EnvironmentVariables } from '../../common/variables/types';
import { UnsupportedIntegrationError } from '../../errors/unsupportedIntegrationError';
import { logger } from '../../logging';
import { IIntegrationStorage, ISqlIntegrationEnvVarsProvider } from './types';
import {
    LegacyIntegrationConfig,
    IntegrationType,
    SnowflakeAuthMethods,
    DuckDBIntegrationConfig,
    DATAFRAME_SQL_INTEGRATION_ID
} from './integrationTypes';
import { INotebookEditorProvider, IDeepnoteNotebookManager } from '../../../notebooks/types';

/**
 * Converts an integration ID to the environment variable name format expected by SQL blocks.
 * Example: 'my-postgres-db' -> 'SQL_MY_POSTGRES_DB'
 */
function convertToEnvironmentVariableName(str: string): string {
    return (/^\d/.test(str) ? `_${str}` : str).toUpperCase().replace(/[^\w]/g, '_');
}

function getSqlEnvVarName(integrationId: string): string {
    return `SQL_${integrationId}`;
}

/**
 * Converts integration configuration to the JSON format expected by the SQL execution code.
 * The format must match what deepnote_toolkit expects:
 * {
 *   "url": "sqlalchemy_connection_url",
 *   "params": {},
 *   "param_style": "qmark" | "format" | etc.
 * }
 */
function convertIntegrationConfigToJson(config: LegacyIntegrationConfig): string {
    switch (config.type) {
        case IntegrationType.DuckDB: {
            // Internal DuckDB integration for querying dataframes
            return JSON.stringify({
                url: 'deepnote+duckdb:///:memory:',
                params: {},
                param_style: 'qmark'
            });
        }

        case IntegrationType.Postgres: {
            // Build PostgreSQL connection URL
            // Format: postgresql://username:password@host:port/database
            const encodedUsername = encodeURIComponent(config.username);
            const encodedPassword = encodeURIComponent(config.password);
            const encodedDatabase = encodeURIComponent(config.database);
            const url = `postgresql://${encodedUsername}:${encodedPassword}@${config.host}:${config.port}/${encodedDatabase}`;

            return JSON.stringify({
                url: url,
                params: config.ssl ? { sslmode: 'require' } : {},
                param_style: 'format'
            });
        }

        case IntegrationType.BigQuery: {
            // BigQuery uses a special URL format
            return JSON.stringify({
                url: 'bigquery://?user_supplied_client=true',
                params: {
                    project_id: config.projectId,
                    credentials: JSON.parse(config.credentials)
                },
                param_style: 'format'
            });
        }

        case IntegrationType.Snowflake: {
            // Build Snowflake connection URL
            // Format depends on auth method:
            // Username+password: snowflake://{username}:{password}@{account}/{database}?warehouse={warehouse}&role={role}&application=YourApp
            // Service account key-pair: snowflake://{username}@{account}/{database}?warehouse={warehouse}&role={role}&authenticator=snowflake_jwt&application=YourApp
            const encodedAccount = encodeURIComponent(config.account);

            let url: string;
            const params: Record<string, unknown> = {};

            if (config.authMethod === null || config.authMethod === SnowflakeAuthMethods.PASSWORD) {
                // Username+password authentication
                const encodedUsername = encodeURIComponent(config.username);
                const encodedPassword = encodeURIComponent(config.password);
                const database = config.database ? `/${encodeURIComponent(config.database)}` : '';
                url = `snowflake://${encodedUsername}:${encodedPassword}@${encodedAccount}${database}`;

                const queryParams = new URLSearchParams();
                if (config.warehouse) {
                    queryParams.set('warehouse', config.warehouse);
                }
                if (config.role) {
                    queryParams.set('role', config.role);
                }
                queryParams.set('application', 'Deepnote');

                const queryString = queryParams.toString();
                if (queryString) {
                    url += `?${queryString}`;
                }
            } else {
                // Service account key-pair authentication (the only other supported method)
                // TypeScript needs help narrowing the type here
                if (config.authMethod !== SnowflakeAuthMethods.SERVICE_ACCOUNT_KEY_PAIR) {
                    // This should never happen due to the type guard above, but TypeScript needs this
                    throw new UnsupportedIntegrationError(
                        l10n.t(
                            "Snowflake integration with auth method '{0}' is not supported in VSCode",
                            config.authMethod
                        )
                    );
                }

                const encodedUsername = encodeURIComponent(config.username);
                const database = config.database ? `/${encodeURIComponent(config.database)}` : '';
                url = `snowflake://${encodedUsername}@${encodedAccount}${database}`;

                const queryParams = new URLSearchParams();
                if (config.warehouse) {
                    queryParams.set('warehouse', config.warehouse);
                }
                if (config.role) {
                    queryParams.set('role', config.role);
                }
                queryParams.set('authenticator', 'snowflake_jwt');
                queryParams.set('application', 'Deepnote');

                const queryString = queryParams.toString();
                if (queryString) {
                    url += `?${queryString}`;
                }

                // For key-pair auth, pass the private key and passphrase as params
                params.snowflake_private_key = btoa(config.privateKey);
                if (config.privateKeyPassphrase) {
                    params.snowflake_private_key_passphrase = config.privateKeyPassphrase;
                }
            }

            return JSON.stringify({
                url: url,
                params: params,
                param_style: 'pyformat'
            });
        }

        default:
            throw new UnsupportedIntegrationError(
                l10n.t('Unsupported integration type: {0}', (config as LegacyIntegrationConfig).type)
            );
    }
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
        @inject(INotebookEditorProvider) private readonly notebookEditorProvider: INotebookEditorProvider,
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
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
        const envVars: EnvironmentVariables = {};

        if (!resource) {
            return envVars;
        }

        if (token?.isCancellationRequested) {
            return envVars;
        }

        logger.trace(`SqlIntegrationEnvironmentVariablesProvider: Getting env vars for resource`);

        // Get the notebook document from the resource
        const notebook = this.notebookEditorProvider.findAssociatedNotebookDocument(resource);
        if (!notebook) {
            logger.trace(`SqlIntegrationEnvironmentVariablesProvider: No notebook found for resource`);
            return envVars;
        }

        // Get the project ID from the notebook metadata
        const projectId = notebook.metadata?.deepnoteProjectId as string | undefined;
        if (!projectId) {
            logger.trace(`SqlIntegrationEnvironmentVariablesProvider: No project ID found in notebook metadata`);
            return envVars;
        }

        logger.trace(`SqlIntegrationEnvironmentVariablesProvider: Project ID: ${projectId}`);

        // Get the project from the notebook manager
        const project = this.notebookManager.getOriginalProject(projectId);
        if (!project) {
            logger.trace(`SqlIntegrationEnvironmentVariablesProvider: No project found for ID: ${projectId}`);
            return envVars;
        }

        // Get the list of integrations from the project
        const projectIntegrations = project.project.integrations || [];
        logger.trace(
            `SqlIntegrationEnvironmentVariablesProvider: Found ${projectIntegrations.length} integrations in project`
        );

        // Always add the internal DuckDB integration
        const duckdbConfig: DuckDBIntegrationConfig = {
            id: DATAFRAME_SQL_INTEGRATION_ID,
            name: 'Dataframe SQL (DuckDB)',
            type: IntegrationType.DuckDB
        };

        try {
            const envVarName = convertToEnvironmentVariableName(getSqlEnvVarName(duckdbConfig.id));
            const credentialsJson = convertIntegrationConfigToJson(duckdbConfig);
            envVars[envVarName] = credentialsJson;
            logger.debug(
                `SqlIntegrationEnvironmentVariablesProvider: Added env var ${envVarName} for DuckDB integration`
            );
        } catch (error) {
            logger.error(
                `SqlIntegrationEnvironmentVariablesProvider: Failed to get credentials for DuckDB integration`,
                error
            );
        }

        // Get credentials for each project integration and add to environment variables
        for (const projectIntegration of projectIntegrations) {
            if (token?.isCancellationRequested) {
                break;
            }

            const integrationId = projectIntegration.id;

            // Skip the internal DuckDB integration (already added above)
            if (integrationId === DATAFRAME_SQL_INTEGRATION_ID) {
                continue;
            }

            try {
                // Get the integration configuration from storage
                const config = await this.integrationStorage.getIntegrationConfig(integrationId);
                if (!config) {
                    logger.debug(
                        `SqlIntegrationEnvironmentVariablesProvider: No configuration found for integration ${integrationId}, skipping`
                    );
                    continue;
                }

                // Convert integration config to JSON and add as environment variable
                const envVarName = convertToEnvironmentVariableName(getSqlEnvVarName(config.id));
                const credentialsJson = convertIntegrationConfigToJson(config);

                envVars[envVarName] = credentialsJson;
                logger.debug(
                    `SqlIntegrationEnvironmentVariablesProvider: Added env var ${envVarName} for integration ${config.id}`
                );
            } catch (error) {
                logger.error(
                    `SqlIntegrationEnvironmentVariablesProvider: Failed to get credentials for integration ${integrationId}`,
                    error
                );
            }
        }

        logger.trace(`SqlIntegrationEnvironmentVariablesProvider: Returning ${Object.keys(envVars).length} env vars`);

        return envVars;
    }
}
