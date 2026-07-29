import * as React from 'react';

import { getLocString } from '../react-common/locReactSide';
import { ConfigurableDatabaseIntegrationType, DetectedIntegration } from './types';
import { integrationTypeIcons } from './integrationUtils';

export interface IIntegrationItemProps {
    integration: DetectedIntegration;
    onConfigure: (integrationId: string) => void;
    onReset: (integrationId: string) => void;
    onDelete: (integrationId: string) => void;
    onAuthenticate: (integrationId: string) => void;
}

const getIntegrationTypeLabel = (type: ConfigurableDatabaseIntegrationType): string => {
    switch (type) {
        case 'alloydb':
            return getLocString('integrationsAlloyDBTypeLabel', 'Google AlloyDB');
        case 'athena':
            return getLocString('integrationsAthenaTypeLabel', 'Amazon Athena');
        case 'big-query':
            return getLocString('integrationsBigQueryTypeLabel', 'Google BigQuery');
        case 'clickhouse':
            return getLocString('integrationsClickHouseTypeLabel', 'ClickHouse');
        case 'cloud-sql':
            return getLocString('integrationsCloudSqlTypeLabel', 'Google Cloud SQL');
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
            return getLocString('integrationsSpannerTypeLabel', 'Google Spanner');
        case 'sql-server':
            return getLocString('integrationsSQLServerTypeLabel', 'Microsoft SQL Server');
        case 'trino':
            return getLocString('integrationsTrinoTypeLabel', 'Trino');
        default:
            return type;
    }
};

export const IntegrationItem: React.FC<IIntegrationItemProps> = ({
    integration,
    onConfigure,
    onReset,
    onDelete,
    onAuthenticate
}) => {
    // Credentials the panel can edit live in SecretStorage, which is exactly what `config` holds.
    const statusClass = integration.config ? 'status-connected' : 'status-disconnected';
    const statusText = integration.config
        ? getLocString('integrationsConnected', 'Connected')
        : getLocString('integrationsNotConfigured', 'Not Configured');
    const configureText = integration.config
        ? getLocString('integrationsReconfigure', 'Reconfigure')
        : getLocString('integrationsConfigure', 'Configure');

    // Get the name: prefer config name, then integration name from project, then ID
    const name = integration.config?.name || integration.integrationName || integration.id;

    // Get the type: prefer config type, then integration type from project
    const type = integration.config?.type || integration.integrationType;

    // Get the type label and icon
    const typeLabel = type ? getIntegrationTypeLabel(type) : undefined;
    const typeIcon = type ? integrationTypeIcons[type] : undefined;

    // Federated-auth UI: `tokenStatus` alone decides. The extension gates on its candidate set, which also
    // covers integrations declared in `.deepnote.env.yaml` — those have no `config` here, so re-deriving
    // eligibility from `config` would hide the action for exactly the case that needs it.
    const tokenStatus = integration.tokenStatus;
    const showFederatedAuth = tokenStatus && tokenStatus !== 'unsupported';

    const tokenStatusText =
        tokenStatus === 'authenticated'
            ? getLocString('integrationsTokenStatusAuthenticated', 'Authenticated')
            : getLocString('integrationsTokenStatusDisconnected', 'Not authenticated');
    const tokenStatusPillClass = tokenStatus === 'authenticated' ? 'status-connected' : 'status-disconnected';
    const authenticateButtonText =
        tokenStatus === 'authenticated'
            ? getLocString('integrationsReauthenticate', 'Re-authenticate with Google')
            : getLocString('integrationsAuthenticate', 'Authenticate with Google');

    return (
        <div className="integration-item">
            {typeIcon && (
                <div className="integration-item-icon">
                    <img src={typeIcon} alt={typeLabel || ''} />
                </div>
            )}
            <div className="integration-info">
                <div className="integration-name">{name}</div>
                <div className="integration-meta">
                    {typeLabel && <span className="integration-type">{typeLabel}</span>}
                    {typeLabel && <span className="integration-meta-separator"> • </span>}
                    <span className={`integration-status ${statusClass}`}>{statusText}</span>
                    {showFederatedAuth && (
                        <>
                            <span className="integration-meta-separator"> • </span>
                            <span className={`integration-status ${tokenStatusPillClass}`}>{tokenStatusText}</span>
                        </>
                    )}
                </div>
            </div>
            <div className="integration-actions">
                <button type="button" onClick={() => onConfigure(integration.id)}>
                    {configureText}
                </button>
                {showFederatedAuth && (
                    <button type="button" onClick={() => onAuthenticate(integration.id)}>
                        {authenticateButtonText}
                    </button>
                )}
                {integration.config && (
                    <button type="button" className="secondary" onClick={() => onReset(integration.id)}>
                        {getLocString('integrationsReset', 'Reset')}
                    </button>
                )}
                {integration.config && (
                    <button
                        type="button"
                        className="secondary"
                        onClick={() => onDelete(integration.id)}
                        title={getLocString('integrationsDelete', 'Delete')}
                        aria-label={getLocString('integrationsDelete', 'Delete')}
                    >
                        {getLocString('integrationsDelete', 'Delete')}
                    </button>
                )}
            </div>
        </div>
    );
};
