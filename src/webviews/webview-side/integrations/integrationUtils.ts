import { getLocString } from '../react-common/locReactSide';
import { ConfigurableDatabaseIntegrationType } from './types';

// Import integration logos
/* eslint-disable @typescript-eslint/no-require-imports */
const postgresqlLogo: string = require('./icons/postgresql.svg');
const mysqlLogo: string = require('./icons/mysql.svg');
const mariadbLogo: string = require('./icons/mariadb.svg');
const mongodbLogo: string = require('./icons/mongodb.svg');
const sqlServerLogo: string = require('./icons/sql-server.svg');
const bigqueryLogo: string = require('./icons/bigquery.svg');
const snowflakeLogo: string = require('./icons/snowflake.svg');
const alloydbLogo: string = require('./icons/alloydb.svg');
const spannerLogo: string = require('./icons/spanner.svg');
const materializeLogo: string = require('./icons/materialize.svg');
const clickhouseLogo: string = require('./icons/clickhouse.svg');
const athenaLogo: string = require('./icons/athena.svg');
const redshiftLogo: string = require('./icons/redshift.svg');
const databricksLogo: string = require('./icons/databricks.svg');
const dremioLogo: string = require('./icons/dremio.svg');
const mindsdbLogo: string = require('./icons/mindsdb.svg');
const trinoLogo: string = require('./icons/trino.svg');
/* eslint-enable @typescript-eslint/no-require-imports */

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

// Icon mapping for integration types
export const integrationTypeIcons: Record<ConfigurableDatabaseIntegrationType, string> = {
    alloydb: alloydbLogo,
    athena: athenaLogo,
    'big-query': bigqueryLogo,
    clickhouse: clickhouseLogo,
    databricks: databricksLogo,
    dremio: dremioLogo,
    mariadb: mariadbLogo,
    materialize: materializeLogo,
    mindsdb: mindsdbLogo,
    mongodb: mongodbLogo,
    mysql: mysqlLogo,
    pgsql: postgresqlLogo,
    redshift: redshiftLogo,
    snowflake: snowflakeLogo,
    spanner: spannerLogo,
    'sql-server': sqlServerLogo,
    trino: trinoLogo
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
