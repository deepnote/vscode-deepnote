import {
    ConfigurableDatabaseIntegrationConfig,
    isFederatedAuthMetadata
} from '../../platform/notebooks/deepnote/integrationTypes';

/**
 * SQL LSP connection configuration format expected by sql-language-server
 */
export interface SqlLspConnection {
    name: string;
    adapter: 'postgres' | 'mysql' | 'bigquery';
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    projectId?: string;
    keyFilename?: string;
}

/**
 * Database types supported by sql-language-server
 */
export const supportedSqlLspTypes = ['mysql', 'pgsql', 'big-query'] as const;

/**
 * Check if integration type is supported by sql-language-server
 * @param type Integration type from extension
 * @returns True if supported by sql-language-server
 */
export function isSupportedBySqlLsp(type: string): boolean {
    return (supportedSqlLspTypes as readonly string[]).includes(type);
}

/**
 * Convert extension's integration config to sql-language-server connection format
 * @param config Integration configuration from extension
 * @returns Connection configuration for sql-language-server, or null if conversion fails
 */
export function convertToSqlLspConnection(config: ConfigurableDatabaseIntegrationConfig): SqlLspConnection | null {
    try {
        if (isFederatedAuthMetadata(config.metadata)) {
            return null;
        }

        switch (config.type) {
            case 'pgsql':
                return {
                    name: config.name || 'postgres',
                    adapter: 'postgres',
                    host: config.metadata.host || 'localhost',
                    port: Number(config.metadata.port) || 5432,
                    user: config.metadata.user,
                    password: config.metadata.password,
                    database: config.metadata.database
                };

            case 'mysql':
                return {
                    name: config.name || 'mysql',
                    adapter: 'mysql',
                    host: config.metadata.host || 'localhost',
                    port: Number(config.metadata.port) || 3306,
                    user: config.metadata.user,
                    password: config.metadata.password,
                    database: config.metadata.database
                };

            default:
                return null;
        }
    } catch {
        return null;
    }
}
