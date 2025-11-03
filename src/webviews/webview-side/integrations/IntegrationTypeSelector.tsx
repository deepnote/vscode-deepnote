import * as React from 'react';
import { getLocString } from '../react-common/locReactSide';
import { ConfigurableDatabaseIntegrationType } from './types';

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
        icon: '🐘'
    },
    {
        type: 'mysql',
        label: 'MySQL',
        icon: '🐬'
    },
    {
        type: 'mariadb',
        label: 'MariaDB',
        icon: '🦭'
    },
    {
        type: 'mongodb',
        label: 'MongoDB',
        icon: '🍃'
    },
    {
        type: 'sql-server',
        label: 'Microsoft SQL Server',
        icon: '🗄️'
    },
    {
        type: 'big-query',
        label: 'Google BigQuery',
        icon: '📊'
    },
    {
        type: 'snowflake',
        label: 'Snowflake',
        icon: '❄️'
    },
    {
        type: 'alloydb',
        label: 'Google AlloyDB',
        icon: '🔷'
    },
    {
        type: 'spanner',
        label: 'Google Cloud Spanner',
        icon: '🔧'
    },
    {
        type: 'materialize',
        label: 'Materialize',
        icon: '⚡'
    },
    {
        type: 'clickhouse',
        label: 'ClickHouse',
        icon: '🏠'
    },
    {
        type: 'athena',
        label: 'Amazon Athena',
        icon: '🏛️'
    },
    {
        type: 'redshift',
        label: 'Amazon Redshift',
        icon: '🔴'
    },
    {
        type: 'databricks',
        label: 'Databricks',
        icon: '🧱'
    },
    {
        type: 'dremio',
        label: 'Dremio',
        icon: '🚀'
    },
    {
        type: 'mindsdb',
        label: 'MindsDB',
        icon: '🧠'
    },
    {
        type: 'trino',
        label: 'Trino',
        icon: '⚙️'
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
                        <div className="integration-type-icon">{integrationInfo.icon}</div>
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

