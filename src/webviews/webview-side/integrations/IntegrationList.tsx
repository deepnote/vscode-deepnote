// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as React from 'react';
import { IntegrationItem } from './IntegrationItem';
import { IntegrationWithStatus } from './types';

export interface IIntegrationListProps {
    integrations: IntegrationWithStatus[];
    onConfigure: (integrationId: string) => void;
    onDelete: (integrationId: string) => void;
}

export const IntegrationList: React.FC<IIntegrationListProps> = ({ integrations, onConfigure, onDelete }) => {
    if (integrations.length === 0) {
        return <p className="no-integrations">No integrations found in this project.</p>;
    }

    return (
        <div className="integration-list">
            {integrations.map((integration) => (
                <IntegrationItem
                    key={integration.id}
                    integration={integration}
                    onConfigure={onConfigure}
                    onDelete={onDelete}
                />
            ))}
        </div>
    );
};

