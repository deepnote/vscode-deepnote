// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as React from 'react';
import { IVsCodeApi } from '../react-common/postOffice';
import { IntegrationList } from './IntegrationList';
import { ConfigurationForm } from './ConfigurationForm';
import { IntegrationWithStatus, WebviewMessage, IntegrationConfig } from './types';

export interface IIntegrationPanelProps {
    baseTheme: string;
    vscodeApi: IVsCodeApi;
}

export const IntegrationPanel: React.FC<IIntegrationPanelProps> = ({ baseTheme, vscodeApi }) => {
    const [integrations, setIntegrations] = React.useState<IntegrationWithStatus[]>([]);
    const [selectedIntegrationId, setSelectedIntegrationId] = React.useState<string | null>(null);
    const [selectedConfig, setSelectedConfig] = React.useState<IntegrationConfig | null>(null);
    const [message, setMessage] = React.useState<{ type: 'success' | 'error'; text: string } | null>(null);

    // Handle messages from the extension
    React.useEffect(() => {
        const handleMessage = (event: MessageEvent<WebviewMessage>) => {
            const msg = event.data;

            switch (msg.type) {
                case 'update':
                    setIntegrations(msg.integrations);
                    break;

                case 'showForm':
                    setSelectedIntegrationId(msg.integrationId);
                    setSelectedConfig(msg.config);
                    break;

                case 'success':
                case 'error':
                    setMessage({ type: msg.type, text: msg.message });
                    // Auto-hide message after 5 seconds
                    setTimeout(() => setMessage(null), 5000);
                    break;
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, []);

    const handleConfigure = (integrationId: string) => {
        vscodeApi.postMessage({
            type: 'configure',
            integrationId
        });
    };

    const handleDelete = (integrationId: string) => {
        if (confirm('Are you sure you want to delete this integration configuration?')) {
            vscodeApi.postMessage({
                type: 'delete',
                integrationId
            });
        }
    };

    const handleSave = (config: IntegrationConfig) => {
        vscodeApi.postMessage({
            type: 'save',
            config
        });
        setSelectedIntegrationId(null);
        setSelectedConfig(null);
    };

    const handleCancel = () => {
        setSelectedIntegrationId(null);
        setSelectedConfig(null);
    };

    return (
        <div className={`integration-panel theme-${baseTheme}`}>
            <h1>Deepnote Integrations</h1>

            {message && (
                <div className={`message message-${message.type}`}>
                    {message.text}
                </div>
            )}

            <IntegrationList
                integrations={integrations}
                onConfigure={handleConfigure}
                onDelete={handleDelete}
            />

            {selectedIntegrationId && (
                <ConfigurationForm
                    integrationId={selectedIntegrationId}
                    existingConfig={selectedConfig}
                    onSave={handleSave}
                    onCancel={handleCancel}
                />
            )}
        </div>
    );
};

