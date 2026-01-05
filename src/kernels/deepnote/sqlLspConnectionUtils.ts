import { ConfigurableDatabaseIntegrationConfig } from '../../platform/notebooks/deepnote/integrationTypes';

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const metadata = config.metadata as Record<string, any>;
        const type = config.type as string;

        switch (type) {
            case 'pgsql':
                return {
                    name: config.name || 'postgres',
                    adapter: 'postgres',
                    host: metadata.host || 'localhost',
                    port: Number(metadata.port) || 5432,
                    user: metadata.username || metadata.user,
                    password: metadata.password,
                    database: metadata.database || metadata.dbname
                };

            case 'mysql':
                return {
                    name: config.name || 'mysql',
                    adapter: 'mysql',
                    host: metadata.host || 'localhost',
                    port: Number(metadata.port) || 3306,
                    user: metadata.username || metadata.user,
                    password: metadata.password,
                    database: metadata.database || metadata.dbname
                };

            case 'big-query':
                return {
                    name: config.name || 'bigquery',
                    adapter: 'bigquery',
                    projectId: metadata.projectId || metadata.project_id,
                    keyFilename: metadata.keyFilename || metadata.key_filename
                };

            default:
                return null;
        }
    } catch {
        return null;
    }
}
