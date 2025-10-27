import * as React from 'react';
import { IVsCodeApi } from '../react-common/postOffice';
import { getLocString, storeLocStrings } from '../react-common/locReactSide';
import { IntegrationList } from './IntegrationList';
import { ConfigurationForm } from './ConfigurationForm';
import { IntegrationWithStatus, WebviewMessage, IntegrationConfig, IntegrationType } from './types';

export interface IIntegrationPanelProps {
    baseTheme: string;
    vscodeApi: IVsCodeApi;
}

export const IntegrationPanel: React.FC<IIntegrationPanelProps> = ({ baseTheme, vscodeApi }) => {
    const [integrations, setIntegrations] = React.useState<IntegrationWithStatus[]>([]);
    const [selectedIntegrationId, setSelectedIntegrationId] = React.useState<string | null>(null);
    const [selectedConfig, setSelectedConfig] = React.useState<IntegrationConfig | null>(null);
    const [selectedIntegrationName, setSelectedIntegrationName] = React.useState<string | undefined>(undefined);
    const [selectedIntegrationType, setSelectedIntegrationType] = React.useState<IntegrationType | undefined>(
        undefined
    );
    const [message, setMessage] = React.useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [confirmDelete, setConfirmDelete] = React.useState<string | null>(null);

    const messageTimerRef = React.useRef<NodeJS.Timeout | null>(null);
    const confirmDeleteTimerRef = React.useRef<NodeJS.Timeout | null>(null);

    // Cleanup timers on unmount
    React.useEffect(() => {
        return () => {
            if (messageTimerRef.current) {
                clearTimeout(messageTimerRef.current);
                messageTimerRef.current = null;
            }
            if (confirmDeleteTimerRef.current) {
                clearTimeout(confirmDeleteTimerRef.current);
                confirmDeleteTimerRef.current = null;
            }
        };
    }, []);

    // Handle messages from the extension
    React.useEffect(() => {
        const handleMessage = (event: MessageEvent<WebviewMessage>) => {
            const msg = event.data;

            switch (msg.type) {
                case 'loc_init':
                    storeLocStrings(msg.locStrings);
                    break;

                case 'update':
                    setIntegrations(msg.integrations);
                    break;

                case 'showForm':
                    setSelectedIntegrationId(msg.integrationId);
                    setSelectedConfig(msg.config);
                    setSelectedIntegrationName(msg.integrationName);
                    setSelectedIntegrationType(msg.integrationType);
                    break;

                case 'success':
                case 'error':
                    setMessage({ type: msg.type, text: msg.message });

                    // Clear any existing message timer before creating a new one
                    if (messageTimerRef.current) {
                        clearTimeout(messageTimerRef.current);
                    }

                    // Auto-hide message after 5 seconds
                    messageTimerRef.current = setTimeout(() => {
                        setMessage(null);
                        messageTimerRef.current = null;
                    }, 5000);
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
        // Clear any existing confirmDelete timer before creating a new one
        if (confirmDeleteTimerRef.current) {
            clearTimeout(confirmDeleteTimerRef.current);
        }

        setConfirmDelete(integrationId);
    };

    const handleConfirmDelete = () => {
        if (confirmDelete) {
            // Clear the timer when user confirms
            if (confirmDeleteTimerRef.current) {
                clearTimeout(confirmDeleteTimerRef.current);
                confirmDeleteTimerRef.current = null;
            }

            vscodeApi.postMessage({
                type: 'delete',
                integrationId: confirmDelete
            });
            setConfirmDelete(null);
        }
    };

    const handleCancelDelete = () => {
        // Clear the timer when user cancels
        if (confirmDeleteTimerRef.current) {
            clearTimeout(confirmDeleteTimerRef.current);
            confirmDeleteTimerRef.current = null;
        }

        setConfirmDelete(null);
    };

    const handleSave = (config: IntegrationConfig) => {
        vscodeApi.postMessage({
            type: 'save',
            integrationId: config.id,
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
            <h1>{getLocString('integrationsTitle', 'Deepnote Integrations')}</h1>

            {message && <div className={`message message-${message.type}`}>{message.text}</div>}

            <IntegrationList integrations={integrations} onConfigure={handleConfigure} onDelete={handleDelete} />

            {selectedIntegrationId && (
                <ConfigurationForm
                    integrationId={selectedIntegrationId}
                    existingConfig={selectedConfig}
                    integrationName={selectedIntegrationName}
                    integrationType={selectedIntegrationType}
                    onSave={handleSave}
                    onCancel={handleCancel}
                />
            )}

            {confirmDelete && (
                <div className="configuration-form-overlay">
                    <div className="configuration-form-container" style={{ maxWidth: '400px' }}>
                        <div className="configuration-form-header">
                            <h2>{getLocString('integrationsConfirmResetTitle', 'Confirm Reset')}</h2>
                        </div>
                        <div className="configuration-form-body">
                            <p>
                                {getLocString(
                                    'integrationsConfirmResetMessage',
                                    'Are you sure you want to reset this integration configuration?'
                                )}
                            </p>
                            <p style={{ marginTop: '10px', fontSize: '0.9em', opacity: 0.8 }}>
                                {getLocString(
                                    'integrationsConfirmResetDetails',
                                    'This will remove the stored credentials. You can reconfigure it later.'
                                )}
                            </p>
                        </div>
                        <div className="form-actions">
                            <button type="button" className="primary" onClick={handleConfirmDelete}>
                                {getLocString('integrationsReset', 'Reset')}
                            </button>
                            <button type="button" className="secondary" onClick={handleCancelDelete}>
                                {getLocString('integrationsCancel', 'Cancel')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
