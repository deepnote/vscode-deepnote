import * as React from 'react';
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

export interface IIntegrationTypeSelectorProps {
    onSelectType: (type: ConfigurableDatabaseIntegrationType) => void;
}

interface IntegrationTypeInfo {
    type: ConfigurableDatabaseIntegrationType;
    label: string;
    icon: string;
}

const INTEGRATION_TYPES: IntegrationTypeInfo[] = [
    {
        type: 'pgsql',
        label: 'PostgreSQL',
        icon: postgresqlLogo
    },
    {
        type: 'mysql',
        label: 'MySQL',
        icon: mysqlLogo
    },
    {
        type: 'mariadb',
        label: 'MariaDB',
        icon: mariadbLogo
    },
    {
        type: 'mongodb',
        label: 'MongoDB',
        icon: mongodbLogo
    },
    {
        type: 'sql-server',
        label: 'Microsoft SQL Server',
        icon: sqlServerLogo
    },
    {
        type: 'big-query',
        label: 'Google BigQuery',
        icon: bigqueryLogo
    },
    {
        type: 'snowflake',
        label: 'Snowflake',
        icon: snowflakeLogo
    },
    {
        type: 'alloydb',
        label: 'Google AlloyDB',
        icon: alloydbLogo
    },
    {
        type: 'spanner',
        label: 'Google Cloud Spanner',
        icon: spannerLogo
    },
    {
        type: 'materialize',
        label: 'Materialize',
        icon: materializeLogo
    },
    {
        type: 'clickhouse',
        label: 'ClickHouse',
        icon: clickhouseLogo
    },
    {
        type: 'athena',
        label: 'Amazon Athena',
        icon: athenaLogo
    },
    {
        type: 'redshift',
        label: 'Amazon Redshift',
        icon: redshiftLogo
    },
    {
        type: 'databricks',
        label: 'Databricks',
        icon: databricksLogo
    },
    {
        type: 'dremio',
        label: 'Dremio',
        icon: dremioLogo
    },
    {
        type: 'mindsdb',
        label: 'MindsDB',
        icon: mindsdbLogo
    },
    {
        type: 'trino',
        label: 'Trino',
        icon: trinoLogo
    }
];

export const IntegrationTypeSelector: React.FC<IIntegrationTypeSelectorProps> = ({ onSelectType }) => {
    return (
        <div className="integration-type-selector">
            <h2>{getLocString('integrationsAddNewIntegration', 'Add New Integration')}</h2>
            <div className="integration-type-grid">
                {INTEGRATION_TYPES.map((integrationInfo) => (
                    <button
                        key={integrationInfo.type}
                        type="button"
                        className="integration-type-card"
                        onClick={() => onSelectType(integrationInfo.type)}
                    >
                        <div className="integration-type-icon">
                            <img src={integrationInfo.icon} alt={integrationInfo.label} />
                        </div>
                        <div className="integration-type-label">{integrationInfo.label}</div>
                        <div className="integration-type-category">
                            {getLocString('integrationsDatabase', 'Database')}
                        </div>
                    </button>
                ))}
            </div>
        </div>
    );
};
