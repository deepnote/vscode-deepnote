import * as React from 'react';
import { IntegrationWithStatus } from './types';
import { l10n } from 'vscode';

export interface IIntegrationItemProps {
    integration: IntegrationWithStatus;
    onConfigure: (integrationId: string) => void;
    onDelete: (integrationId: string) => void;
}

export const IntegrationItem: React.FC<IIntegrationItemProps> = ({ integration, onConfigure, onDelete }) => {
    const statusClass = integration.status === 'connected' ? 'status-connected' : 'status-disconnected';
    const statusText = integration.status === 'connected' ? l10n.t('Connected') : l10n.t('Not Configured');
    const configureText = integration.config ? l10n.t('Reconfigure') : l10n.t('Configure');
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
                        {l10n.t('Reset')}
                    </button>
                )}
            </div>
        </div>
    );
};
