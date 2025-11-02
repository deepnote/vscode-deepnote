import * as React from 'react';
import { getLocString } from '../react-common/locReactSide';
import { IntegrationWithStatus } from './types';
import { DatabaseIntegrationType } from '@deepnote/database-integrations';

export interface IIntegrationItemProps {
    integration: IntegrationWithStatus;
    onConfigure: (integrationId: string) => void;
    onDelete: (integrationId: string) => void;
}

const getIntegrationTypeLabel = (type: DatabaseIntegrationType): string => {
    switch (type) {
        case 'pgsql':
            return getLocString('integrationsPostgresTypeLabel', 'PostgreSQL');
        case 'big-query':
            return getLocString('integrationsBigQueryTypeLabel', 'BigQuery');
        case 'snowflake':
            return getLocString('integrationsSnowflakeTypeLabel', 'Snowflake');
        default:
            return type;
    }
};

export const IntegrationItem: React.FC<IIntegrationItemProps> = ({ integration, onConfigure, onDelete }) => {
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
                    <button type="button" className="secondary" onClick={() => onDelete(integration.id)}>
                        {getLocString('integrationsReset', 'Reset')}
                    </button>
                )}
            </div>
        </div>
    );
};
