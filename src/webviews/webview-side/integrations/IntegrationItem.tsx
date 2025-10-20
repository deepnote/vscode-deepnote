import * as React from 'react';
import { getLocString } from '../react-common/locReactSide';
import { IntegrationWithStatus } from './types';

export interface IIntegrationItemProps {
    integration: IntegrationWithStatus;
    onConfigure: (integrationId: string) => void;
    onDelete: (integrationId: string) => void;
}

export const IntegrationItem: React.FC<IIntegrationItemProps> = ({ integration, onConfigure, onDelete }) => {
    const statusClass = integration.status === 'connected' ? 'status-connected' : 'status-disconnected';
    const statusText =
        integration.status === 'connected'
            ? getLocString('integrationsConnected', 'Connected')
            : getLocString('integrationsNotConfigured', 'Not Configured');
    const configureText = integration.config
        ? getLocString('integrationsReconfigure', 'Reconfigure')
        : getLocString('integrationsConfigure', 'Configure');
    const displayName = integration.config?.name || integration.id;

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
