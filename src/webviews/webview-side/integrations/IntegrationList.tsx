import * as React from 'react';
import { getLocString } from '../react-common/locReactSide';
import { IntegrationItem } from './IntegrationItem';
import { DetectedIntegration } from './types';

export interface IIntegrationListProps {
    integrations: DetectedIntegration[];
    onConfigure: (integrationId: string) => void;
    onReset: (integrationId: string) => void;
    onDelete: (integrationId: string) => void;
    onAuthenticate: (integrationId: string) => void;
}

export const IntegrationList: React.FC<IIntegrationListProps> = ({
    integrations,
    onConfigure,
    onReset,
    onDelete,
    onAuthenticate
}) => {
    if (integrations.length === 0) {
        return (
            <p className="no-integrations">
                {getLocString('integrationsNoIntegrationsFound', 'No integrations found in this project.')}
            </p>
        );
    }

    return (
        <div className="integration-list">
            {integrations.map((integration) => (
                <IntegrationItem
                    key={integration.id}
                    integration={integration}
                    onConfigure={onConfigure}
                    onReset={onReset}
                    onDelete={onDelete}
                    onAuthenticate={onAuthenticate}
                />
            ))}
        </div>
    );
};
