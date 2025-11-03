import { getLocString } from '../react-common/locReactSide';
import { ConfigurableDatabaseIntegrationType } from './types';

// Localized labels for integration types (duplicated from sqlCellStatusBarProvider.ts due to import restrictions)
export const integrationTypeLabels: Record<ConfigurableDatabaseIntegrationType, string> = {
    alloydb: 'AlloyDB',
    athena: 'Amazon Athena',
    'big-query': 'BigQuery',
    clickhouse: 'ClickHouse',
    databricks: 'Databricks',
    dremio: 'Dremio',
    mariadb: 'MariaDB',
    materialize: 'Materialize',
    mindsdb: 'MindsDB',
    mongodb: 'MongoDB',
    mysql: 'MySQL',
    pgsql: 'PostgreSQL',
    redshift: 'Amazon Redshift',
    snowflake: 'Snowflake',
    spanner: 'Google Cloud Spanner',
    'sql-server': 'Microsoft SQL Server',
    trino: 'Trino'
};

/**
 * Get the default name for a new integration
 * @param type The integration type
 * @returns The default name in the format "My {type} integration"
 */
export function getDefaultIntegrationName(type: ConfigurableDatabaseIntegrationType): string {
    const typeLabel = integrationTypeLabels[type] || type;
    return getLocString('integrationsDefaultName', 'My {0} integration').replace('{0}', typeLabel);
}
