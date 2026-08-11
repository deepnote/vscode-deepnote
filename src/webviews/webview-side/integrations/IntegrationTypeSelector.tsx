import * as React from 'react';
import { getLocString } from '../react-common/locReactSide';
import { ConfigurableDatabaseIntegrationType } from './types';
import { integrationTypeLabels, integrationTypeIcons } from './integrationUtils';

export interface IIntegrationTypeSelectorProps {
    onSelectType: (type: ConfigurableDatabaseIntegrationType) => void;
}

interface IntegrationTypeInfo {
    type: ConfigurableDatabaseIntegrationType;
    label: string;
    icon: string;
}

// Data Warehouses & Lakes
const WAREHOUSE_INTEGRATION_TYPES: IntegrationTypeInfo[] = [
    {
        type: 'clickhouse',
        label: integrationTypeLabels['clickhouse'],
        icon: integrationTypeIcons['clickhouse']
    },
    {
        type: 'redshift',
        label: integrationTypeLabels['redshift'],
        icon: integrationTypeIcons['redshift']
    },
    {
        type: 'athena',
        label: integrationTypeLabels['athena'],
        icon: integrationTypeIcons['athena']
    },
    {
        type: 'big-query',
        label: integrationTypeLabels['big-query'],
        icon: integrationTypeIcons['big-query']
    },
    {
        type: 'snowflake',
        label: integrationTypeLabels['snowflake'],
        icon: integrationTypeIcons['snowflake']
    },
    {
        type: 'databricks',
        label: integrationTypeLabels['databricks'],
        icon: integrationTypeIcons['databricks']
    },
    {
        type: 'dremio',
        label: integrationTypeLabels['dremio'],
        icon: integrationTypeIcons['dremio']
    },
    {
        type: 'trino',
        label: integrationTypeLabels['trino'],
        icon: integrationTypeIcons['trino']
    }
];

// Databases
const DATABASE_INTEGRATION_TYPES: IntegrationTypeInfo[] = [
    {
        type: 'mongodb',
        label: integrationTypeLabels['mongodb'],
        icon: integrationTypeIcons['mongodb']
    },
    {
        type: 'pgsql',
        label: integrationTypeLabels['pgsql'],
        icon: integrationTypeIcons['pgsql']
    },
    {
        type: 'mysql',
        label: integrationTypeLabels['mysql'],
        icon: integrationTypeIcons['mysql']
    },
    {
        type: 'mariadb',
        label: integrationTypeLabels['mariadb'],
        icon: integrationTypeIcons['mariadb']
    },
    {
        type: 'sql-server',
        label: integrationTypeLabels['sql-server'],
        icon: integrationTypeIcons['sql-server']
    },
    {
        type: 'alloydb',
        label: integrationTypeLabels['alloydb'],
        icon: integrationTypeIcons['alloydb']
    },
    {
        type: 'spanner',
        label: integrationTypeLabels['spanner'],
        icon: integrationTypeIcons['spanner']
    },
    {
        type: 'cloud-sql',
        label: integrationTypeLabels['cloud-sql'],
        icon: integrationTypeIcons['cloud-sql']
    },
    {
        type: 'materialize',
        label: integrationTypeLabels['materialize'],
        icon: integrationTypeIcons['materialize']
    },
    {
        type: 'mindsdb',
        label: integrationTypeLabels['mindsdb'],
        icon: integrationTypeIcons['mindsdb']
    }
];

export const IntegrationTypeSelector: React.FC<IIntegrationTypeSelectorProps> = ({ onSelectType }) => {
    return (
        <div className="integration-type-selector">
            <h2>{getLocString('integrationsAddNewIntegration', 'Add New Integration')}</h2>

            <div className="integration-type-section">
                <h3 className="integration-type-section-title">
                    {getLocString('integrationsDataWarehousesLakes', 'Data Warehouses & Lakes')}
                </h3>
                <div className="integration-type-grid">
                    {WAREHOUSE_INTEGRATION_TYPES.map((integrationInfo) => (
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
                        </button>
                    ))}
                </div>
            </div>

            <div className="integration-type-section">
                <h3 className="integration-type-section-title">{getLocString('integrationsDatabases', 'Databases')}</h3>
                <div className="integration-type-grid">
                    {DATABASE_INTEGRATION_TYPES.map((integrationInfo) => (
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
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
};
