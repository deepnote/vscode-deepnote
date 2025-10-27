import { inject, injectable } from 'inversify';
import { CancellationToken, Event, EventEmitter, NotebookDocument, workspace } from 'vscode';

import { IDisposableRegistry, Resource } from '../../common/types';
import { EnvironmentVariables } from '../../common/variables/types';
import { BaseError } from '../../errors/types';
import { logger } from '../../logging';
import { IIntegrationStorage, ISqlIntegrationEnvVarsProvider } from './types';
import {
    DATAFRAME_SQL_INTEGRATION_ID,
    IntegrationConfig,
    IntegrationType,
    SnowflakeAuthMethods
} from './integrationTypes';

/**
 * Error thrown when an unsupported integration type is encountered.
 *
 * Cause:
 * An integration configuration has a type that is not supported by the SQL integration system.
 *
 * Handled by:
 * Callers should handle this error and inform the user that the integration type is not supported.
 */
class UnsupportedIntegrationError extends BaseError {
    constructor(public readonly integrationType: string) {
        super('unknown', `Unsupported integration type: ${integrationType}`);
    }
}

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
function convertIntegrationConfigToJson(config: IntegrationConfig): string {
    switch (config.type) {
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

            // Check if this is a supported auth method
            if (config.authMethod === null || config.authMethod === SnowflakeAuthMethods.PASSWORD) {
                // Username+password authentication
                const encodedUsername = encodeURIComponent(config.username);
                const encodedPassword = encodeURIComponent(config.password);
                const database = config.database ? `/${encodeURIComponent(config.database)}` : '';
                url = `snowflake://${encodedUsername}:${encodedPassword}@${encodedAccount}${database}`;

                const queryParams: string[] = [];
                if (config.warehouse) {
                    queryParams.push(`warehouse=${encodeURIComponent(config.warehouse)}`);
                }
                if (config.role) {
                    queryParams.push(`role=${encodeURIComponent(config.role)}`);
                }
                queryParams.push('application=Deepnote');

                if (queryParams.length > 0) {
                    url += `?${queryParams.join('&')}`;
                }
            } else if (config.authMethod === SnowflakeAuthMethods.SERVICE_ACCOUNT_KEY_PAIR) {
                // Service account key-pair authentication
                const encodedUsername = encodeURIComponent(config.username);
                const database = config.database ? `/${encodeURIComponent(config.database)}` : '';
                url = `snowflake://${encodedUsername}@${encodedAccount}${database}`;

                const queryParams: string[] = [];
                if (config.warehouse) {
                    queryParams.push(`warehouse=${encodeURIComponent(config.warehouse)}`);
                }
                if (config.role) {
                    queryParams.push(`role=${encodeURIComponent(config.role)}`);
                }
                queryParams.push('authenticator=snowflake_jwt');
                queryParams.push('application=Deepnote');

                if (queryParams.length > 0) {
                    url += `?${queryParams.join('&')}`;
                }

                // For key-pair auth, pass the private key and passphrase as params
                params.private_key = config.privateKey;
                if (config.privateKeyPassphrase) {
                    params.private_key_passphrase = config.privateKeyPassphrase;
                }
            } else {
                // Unsupported auth method
                throw new UnsupportedIntegrationError(
                    `Snowflake integration with auth method '${config.authMethod}' is not supported in VSCode`
                );
            }

            return JSON.stringify({
                url: url,
                params: params,
                param_style: 'format'
            });
        }

        default:
            throw new UnsupportedIntegrationError((config as IntegrationConfig).type);
    }
}

/**
 * Provides environment variables for SQL integrations.
 * This service scans notebooks for SQL blocks and injects the necessary credentials
 * as environment variables so they can be used during SQL block execution.
 */
@injectable()
export class SqlIntegrationEnvironmentVariablesProvider implements ISqlIntegrationEnvVarsProvider {
    private readonly _onDidChangeEnvironmentVariables = new EventEmitter<Resource>();

    public readonly onDidChangeEnvironmentVariables: Event<Resource> = this._onDidChangeEnvironmentVariables.event;

    constructor(
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage,
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
     * Get environment variables for SQL integrations used in the given notebook.
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
        logger.trace(
            `SqlIntegrationEnvironmentVariablesProvider: Available notebooks count: ${workspace.notebookDocuments.length}`
        );

        // Find the notebook document for this resource
        const notebook = workspace.notebookDocuments.find((nb) => nb.uri.toString() === resource.toString());
        if (!notebook) {
            logger.warn(`SqlIntegrationEnvironmentVariablesProvider: No notebook found for ${resource.toString()}`);
            return envVars;
        }

        // Scan all cells for SQL integration IDs
        const integrationIds = this.scanNotebookForIntegrations(notebook);
        if (integrationIds.size === 0) {
            logger.info(
                `SqlIntegrationEnvironmentVariablesProvider: No SQL integrations found in ${resource.toString()}`
            );
            return envVars;
        }

        logger.trace(`SqlIntegrationEnvironmentVariablesProvider: Found ${integrationIds.size} SQL integrations`);

        // Get credentials for each integration and add to environment variables
        for (const integrationId of integrationIds) {
            if (token?.isCancellationRequested) {
                break;
            }

            try {
                const config = await this.integrationStorage.getIntegrationConfig(integrationId);
                if (!config) {
                    logger.warn(
                        `SqlIntegrationEnvironmentVariablesProvider: No configuration found for integration ${integrationId}`
                    );
                    continue;
                }

                // Convert integration config to JSON and add as environment variable
                const envVarName = convertToEnvironmentVariableName(getSqlEnvVarName(integrationId));
                const credentialsJson = convertIntegrationConfigToJson(config);

                envVars[envVarName] = credentialsJson;
                logger.info(
                    `SqlIntegrationEnvironmentVariablesProvider: Added env var ${envVarName} for integration ${integrationId}`
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

    /**
     * Scan a notebook for SQL integration IDs.
     */
    private scanNotebookForIntegrations(notebook: NotebookDocument): Set<string> {
        const integrationIds = new Set<string>();

        for (const cell of notebook.getCells()) {
            // Only check SQL cells
            if (cell.document.languageId !== 'sql') {
                continue;
            }

            const metadata = cell.metadata;
            if (metadata && typeof metadata === 'object') {
                const integrationId = (metadata as Record<string, unknown>).sql_integration_id;
                if (typeof integrationId === 'string') {
                    // Skip the internal DuckDB integration
                    if (integrationId === DATAFRAME_SQL_INTEGRATION_ID) {
                        continue;
                    }

                    integrationIds.add(integrationId);
                    logger.trace(
                        `SqlIntegrationEnvironmentVariablesProvider: Found integration ${integrationId} in cell ${cell.index}`
                    );
                }
            }
        }

        return integrationIds;
    }
}
