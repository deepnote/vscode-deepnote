import * as React from 'react';
import { getLocString } from '../react-common/locReactSide';
import { ConfigurableDatabaseIntegrationType } from './types';
import { integrationTypeIcons, integrationTypeLabel } from './integrationUtils';

export interface IIntegrationTypeSelectorProps {
    /** Opens the extension-host picker of integrations other projects already configured. */
    onAddExisting: () => void;
    onSelectType: (type: ConfigurableDatabaseIntegrationType) => void;
}

// Display order, not the map's alphabetical order.
const WAREHOUSE_INTEGRATION_TYPES: ConfigurableDatabaseIntegrationType[] = [
    'clickhouse',
    'redshift',
    'athena',
    'big-query',
    'snowflake',
    'databricks',
    'dremio',
    'trino'
];

const DATABASE_INTEGRATION_TYPES: ConfigurableDatabaseIntegrationType[] = [
    'mongodb',
    'pgsql',
    'mysql',
    'mariadb',
    'sql-server',
    'alloydb',
    'spanner',
    'cloud-sql',
    'materialize',
    'mindsdb'
];

export const IntegrationTypeSelector: React.FC<IIntegrationTypeSelectorProps> = ({ onAddExisting, onSelectType }) => {
    return (
        <div className="integration-type-selector">
            <div className="integration-type-selector-header">
                <h2>{getLocString('integrationsAddNewIntegration', 'Add New Integration')}</h2>
                <button type="button" className="secondary" onClick={onAddExisting}>
                    {getLocString('integrationsAddExistingIntegration', 'Add Existing Integration')}
                </button>
            </div>

            <div className="integration-type-section">
                <h3 className="integration-type-section-title">
                    {getLocString('integrationsDataWarehousesLakes', 'Data Warehouses & Lakes')}
                </h3>
                <div className="integration-type-grid">
                    {WAREHOUSE_INTEGRATION_TYPES.map((type) => {
                        const label = integrationTypeLabel(type);

                        return (
                            <button
                                key={type}
                                type="button"
                                className="integration-type-card"
                                onClick={() => onSelectType(type)}
                            >
                                <div className="integration-type-icon">
                                    <img src={integrationTypeIcons[type]} alt={label} />
                                </div>
                                <div className="integration-type-label">{label}</div>
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="integration-type-section">
                <h3 className="integration-type-section-title">{getLocString('integrationsDatabases', 'Databases')}</h3>
                <div className="integration-type-grid">
                    {DATABASE_INTEGRATION_TYPES.map((type) => {
                        const label = integrationTypeLabel(type);

                        return (
                            <button
                                key={type}
                                type="button"
                                className="integration-type-card"
                                onClick={() => onSelectType(type)}
                            >
                                <div className="integration-type-icon">
                                    <img src={integrationTypeIcons[type]} alt={label} />
                                </div>
                                <div className="integration-type-label">{label}</div>
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};
