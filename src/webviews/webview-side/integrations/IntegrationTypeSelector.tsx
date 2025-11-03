import * as React from 'react';
import { getLocString } from '../react-common/locReactSide';
import { ConfigurableDatabaseIntegrationType } from './types';
import { integrationTypeLabels } from './integrationUtils';

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
        label: integrationTypeLabels['pgsql'],
        icon: postgresqlLogo
    },
    {
        type: 'mysql',
        label: integrationTypeLabels['mysql'],
        icon: mysqlLogo
    },
    {
        type: 'mariadb',
        label: integrationTypeLabels['mariadb'],
        icon: mariadbLogo
    },
    {
        type: 'mongodb',
        label: integrationTypeLabels['mongodb'],
        icon: mongodbLogo
    },
    {
        type: 'sql-server',
        label: integrationTypeLabels['sql-server'],
        icon: sqlServerLogo
    },
    {
        type: 'big-query',
        label: integrationTypeLabels['big-query'],
        icon: bigqueryLogo
    },
    {
        type: 'snowflake',
        label: integrationTypeLabels['snowflake'],
        icon: snowflakeLogo
    },
    {
        type: 'alloydb',
        label: integrationTypeLabels['alloydb'],
        icon: alloydbLogo
    },
    {
        type: 'spanner',
        label: integrationTypeLabels['spanner'],
        icon: spannerLogo
    },
    {
        type: 'materialize',
        label: integrationTypeLabels['materialize'],
        icon: materializeLogo
    },
    {
        type: 'clickhouse',
        label: integrationTypeLabels['clickhouse'],
        icon: clickhouseLogo
    },
    {
        type: 'athena',
        label: integrationTypeLabels['athena'],
        icon: athenaLogo
    },
    {
        type: 'redshift',
        label: integrationTypeLabels['redshift'],
        icon: redshiftLogo
    },
    {
        type: 'databricks',
        label: integrationTypeLabels['databricks'],
        icon: databricksLogo
    },
    {
        type: 'dremio',
        label: integrationTypeLabels['dremio'],
        icon: dremioLogo
    },
    {
        type: 'mindsdb',
        label: integrationTypeLabels['mindsdb'],
        icon: mindsdbLogo
    },
    {
        type: 'trino',
        label: integrationTypeLabels['trino'],
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
