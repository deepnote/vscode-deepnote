import * as React from 'react';
import { getLocString } from '../react-common/locReactSide';
import { ConfigurableDatabaseIntegrationType, IntegrationWithStatus } from './types';

export interface IIntegrationItemProps {
    integration: IntegrationWithStatus;
    onConfigure: (integrationId: string) => void;
    onReset: (integrationId: string) => void;
    onDelete: (integrationId: string) => void;
}

const getIntegrationTypeLabel = (type: ConfigurableDatabaseIntegrationType): string => {
    switch (type) {
        case 'alloydb':
            return getLocString('integrationsAlloyDBTypeLabel', 'AlloyDB');
        case 'athena':
            return getLocString('integrationsAthenaTypeLabel', 'Amazon Athena');
        case 'big-query':
            return getLocString('integrationsBigQueryTypeLabel', 'BigQuery');
        case 'clickhouse':
            return getLocString('integrationsClickHouseTypeLabel', 'ClickHouse');
        case 'databricks':
            return getLocString('integrationsDatabricksTypeLabel', 'Databricks');
        case 'dremio':
            return getLocString('integrationsDremioTypeLabel', 'Dremio');
        case 'mariadb':
            return getLocString('integrationsMariaDBTypeLabel', 'MariaDB');
        case 'materialize':
            return getLocString('integrationsMaterializeTypeLabel', 'Materialize');
        case 'mindsdb':
            return getLocString('integrationsMindsDBTypeLabel', 'MindsDB');
        case 'mongodb':
            return getLocString('integrationsMongoDBTypeLabel', 'MongoDB');
        case 'mysql':
            return getLocString('integrationsMySQLTypeLabel', 'MySQL');
        case 'pgsql':
            return getLocString('integrationsPostgresTypeLabel', 'PostgreSQL');
        case 'redshift':
            return getLocString('integrationsRedshiftTypeLabel', 'Amazon Redshift');
        case 'snowflake':
            return getLocString('integrationsSnowflakeTypeLabel', 'Snowflake');
        case 'spanner':
            return getLocString('integrationsSpannerTypeLabel', 'Google Cloud Spanner');
        case 'sql-server':
            return getLocString('integrationsSQLServerTypeLabel', 'SQL Server');
        case 'trino':
            return getLocString('integrationsTrinoTypeLabel', 'Trino');
        default:
            return type;
    }
};

export const IntegrationItem: React.FC<IIntegrationItemProps> = ({ integration, onConfigure, onReset, onDelete }) => {
    const statusClass = integration.status === 'connected' ? 'status-connected' : 'status-disconnected';
    const statusText =
        integration.status === 'connected'
            ? getLocString('integrationsConnected', 'Connected')
            : getLocString('integrationsNotConfigured', 'Not Configured');
    const configureText = integration.config
        ? getLocString('integrationsReconfigure', 'Reconfigure')
        : getLocString('integrationsConfigure', 'Configure');

    // Get the name: prefer config name, then integration name from project, then ID
    const name = integration.config?.name || integration.integrationName || integration.id;

    // Get the type: prefer config type, then integration type from project
    const type = integration.config?.type || integration.integrationType;

    // Build display name with type
    const displayName = type ? `${name} (${getIntegrationTypeLabel(type)})` : name;

    return (
        <div className="integration-item">
            <div className="integration-info">
                <div className="integration-name">{displayName}</div>
                <div className={`integration-status ${statusClass}`}>{statusText}</div>
            </div>
            <div className="integration-actions">
                <button type="button" onClick={() => onConfigure(integration.id)}>
                    {configureText}
                </button>
                {integration.config && (
                    <button type="button" className="secondary" onClick={() => onReset(integration.id)}>
                        {getLocString('integrationsReset', 'Reset')}
                    </button>
                )}
                {integration.config && (
                    <button
                        type="button"
                        className="icon-button"
                        onClick={() => onDelete(integration.id)}
                        title={getLocString('integrationsDelete', 'Delete')}
                        aria-label={getLocString('integrationsDelete', 'Delete')}
                    >
                        <span className="codicon codicon-trash" />
                    </button>
                )}
            </div>
        </div>
    );
};
