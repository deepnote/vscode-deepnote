import * as React from 'react';

import { generateUuid } from '../../../platform/common/uuid';
import { IVsCodeApi } from '../react-common/postOffice';
import { getLocString, storeLocStrings } from '../react-common/locReactSide';
import { IntegrationList } from './IntegrationList';
import { IntegrationTypeSelector } from './IntegrationTypeSelector';
import { ConfigurationForm } from './ConfigurationForm';
import {
    ConfigurableDatabaseIntegrationConfig,
    ConfigurableDatabaseIntegrationType,
    DetectedIntegration,
    WebviewMessage,
    WebviewOutboundMessage
} from './types';

export interface IIntegrationPanelProps {
    baseTheme: string;
    vscodeApi: IVsCodeApi;
}

export const IntegrationPanel: React.FC<IIntegrationPanelProps> = ({ baseTheme, vscodeApi }) => {
    const [integrations, setIntegrations] = React.useState<DetectedIntegration[]>([]);
    const [projectName, setProjectName] = React.useState<string | undefined>(undefined);
    const [selectedIntegrationId, setSelectedIntegrationId] = React.useState<string | null>(null);
    const [selectedConfig, setSelectedConfig] = React.useState<ConfigurableDatabaseIntegrationConfig | null>(null);
    const [selectedIntegrationDefaultName, setSelectedIntegrationDefaultName] = React.useState<string | undefined>(
        undefined
    );
    const [selectedIntegrationType, setSelectedIntegrationType] = React.useState<
        ConfigurableDatabaseIntegrationType | undefined
    >(undefined);
    const [message, setMessage] = React.useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [confirmReset, setConfirmReset] = React.useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = React.useState<string | null>(null);

    const messageTimerRef = React.useRef<NodeJS.Timeout | null>(null);
    const confirmResetTimerRef = React.useRef<NodeJS.Timeout | null>(null);
    const confirmDeleteTimerRef = React.useRef<NodeJS.Timeout | null>(null);

    // Cleanup timers on unmount
    React.useEffect(() => {
        return () => {
            if (messageTimerRef.current) {
                clearTimeout(messageTimerRef.current);
                messageTimerRef.current = null;
            }
            if (confirmResetTimerRef.current) {
                clearTimeout(confirmResetTimerRef.current);
                confirmResetTimerRef.current = null;
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
                    setProjectName(msg.projectName);
                    break;

                case 'showForm':
                    setSelectedIntegrationId(msg.integrationId);
                    setSelectedConfig(msg.config);
                    setSelectedIntegrationDefaultName(msg.integrationName);
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

    const postOutbound = (message: WebviewOutboundMessage) => {
        vscodeApi.postMessage(message);
    };

    const handleConfigure = (integrationId: string) => {
        postOutbound({
            type: 'configure',
            integrationId
        });
    };

    const handleAuthenticate = (integrationId: string) => {
        postOutbound({
            type: 'authenticate',
            integrationId
        });
    };

    const handleReset = (integrationId: string) => {
        // Clear any existing confirmReset timer before creating a new one
        if (confirmResetTimerRef.current) {
            clearTimeout(confirmResetTimerRef.current);
        }

        setConfirmReset(integrationId);
    };

    const handleConfirmReset = () => {
        if (confirmReset) {
            // Clear the timer when user confirms
            if (confirmResetTimerRef.current) {
                clearTimeout(confirmResetTimerRef.current);
                confirmResetTimerRef.current = null;
            }

            postOutbound({
                type: 'reset',
                integrationId: confirmReset
            });
            setConfirmReset(null);
        }
    };

    const handleCancelReset = () => {
        // Clear the timer when user cancels
        if (confirmResetTimerRef.current) {
            clearTimeout(confirmResetTimerRef.current);
            confirmResetTimerRef.current = null;
        }

        setConfirmReset(null);
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

            postOutbound({
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

    const handleSave = (config: ConfigurableDatabaseIntegrationConfig) => {
        postOutbound({
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
        setSelectedIntegrationDefaultName(undefined);
        setSelectedIntegrationType(undefined);
    };

    const handleSelectIntegrationType = (type: ConfigurableDatabaseIntegrationType) => {
        // Generate a new UUID for the integration
        const newId = generateUuid();

        // Set up the form for creating a new integration
        setSelectedIntegrationId(newId);
        setSelectedConfig(null);
        setSelectedIntegrationDefaultName(undefined);
        setSelectedIntegrationType(type);
    };

    return (
        <div className={`integration-panel theme-${baseTheme}`}>
            <h1>{getLocString('integrationsTitle', 'Deepnote Integrations')}</h1>
            {projectName && <p className="project-name">{projectName}</p>}

            {message && <div className={`message message-${message.type}`}>{message.text}</div>}

            <IntegrationList
                integrations={integrations}
                onConfigure={handleConfigure}
                onReset={handleReset}
                onDelete={handleDelete}
                onAuthenticate={handleAuthenticate}
            />

            <IntegrationTypeSelector onSelectType={handleSelectIntegrationType} />

            {selectedIntegrationId && selectedIntegrationType && (
                <ConfigurationForm
                    integrationId={selectedIntegrationId}
                    existingConfig={selectedConfig}
                    defaultName={selectedIntegrationDefaultName}
                    integrationType={selectedIntegrationType}
                    onSave={handleSave}
                    onCancel={handleCancel}
                />
            )}

            {confirmReset && (
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
                            <button type="button" className="primary" onClick={handleConfirmReset}>
                                {getLocString('integrationsReset', 'Reset')}
                            </button>
                            <button type="button" className="secondary" onClick={handleCancelReset}>
                                {getLocString('integrationsCancel', 'Cancel')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {confirmDelete && (
                <div className="configuration-form-overlay">
                    <div className="configuration-form-container" style={{ maxWidth: '400px' }}>
                        <div className="configuration-form-header">
                            <h2>{getLocString('integrationsConfirmDeleteTitle', 'Confirm Delete')}</h2>
                        </div>
                        <div className="configuration-form-body">
                            <p>
                                {getLocString(
                                    'integrationsConfirmDeleteMessage',
                                    'Are you sure you want to permanently delete this integration?'
                                )}
                            </p>
                            <p style={{ marginTop: '10px', fontSize: '0.9em', opacity: 0.8 }}>
                                {getLocString(
                                    'integrationsConfirmDeleteDetails',
                                    'This will permanently remove the integration from your project. This action cannot be undone.'
                                )}
                            </p>
                        </div>
                        <div className="form-actions">
                            <button type="button" className="primary" onClick={handleConfirmDelete}>
                                {getLocString('integrationsDelete', 'Delete')}
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
