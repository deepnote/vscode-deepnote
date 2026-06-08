import * as React from 'react';
import { getLocString } from '../react-common/locReactSide';
import { getDefaultIntegrationName } from './integrationUtils';
import { CloudSqlIntegrationConfig } from './types';

function createEmptyCloudSqlConfig(params: { id: string; name?: string }): CloudSqlIntegrationConfig {
    return {
        id: params.id,
        name: (params.name || getDefaultIntegrationName('cloud-sql')).trim(),
        type: 'cloud-sql',
        metadata: {
            service_account: ''
        }
    };
}

export interface ICloudSQLFormProps {
    integrationId: string;
    existingConfig: CloudSqlIntegrationConfig | null;
    defaultName?: string;
    onSave: (config: CloudSqlIntegrationConfig) => void;
    onCancel: () => void;
}

export const CloudSQLForm: React.FC<ICloudSQLFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    onSave,
    onCancel
}) => {
    const [pendingConfig, setPendingConfig] = React.useState<CloudSqlIntegrationConfig>(
        existingConfig
            ? structuredClone(existingConfig)
            : createEmptyCloudSqlConfig({ id: integrationId, name: defaultName })
    );
    const [serviceAccountError, setServiceAccountError] = React.useState<string | null>(null);

    React.useEffect(() => {
        setServiceAccountError(null);
        setPendingConfig(
            existingConfig
                ? structuredClone(existingConfig)
                : createEmptyCloudSqlConfig({ id: integrationId, name: defaultName })
        );
    }, [existingConfig, integrationId, defaultName]);

    const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;

        setPendingConfig((prev) => ({ ...prev, name: value }));
    };

    const handleServiceAccountChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const value = e.target.value;

        setServiceAccountError(null);

        if (value.trim()) {
            try {
                JSON.parse(value);
            } catch {
                setServiceAccountError(
                    getLocString('integrationsCloudSqlServiceAccountInvalidJson', 'Invalid JSON format')
                );
            }
        }

        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, service_account: value } }));
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        const trimmedServiceAccount = pendingConfig.metadata.service_account.trim();
        if (!trimmedServiceAccount) {
            setServiceAccountError(
                getLocString('integrationsCloudSqlServiceAccountInvalidJson', 'Invalid JSON format')
            );

            return;
        }

        try {
            JSON.parse(trimmedServiceAccount);
        } catch {
            setServiceAccountError(
                getLocString('integrationsCloudSqlServiceAccountInvalidJson', 'Invalid JSON format')
            );

            return;
        }

        onSave(pendingConfig);
    };

    return (
        <form onSubmit={handleSubmit}>
            <div className="form-group">
                <label htmlFor="name">{getLocString('integrationsCloudSqlNameLabel', 'Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={pendingConfig.name}
                    onChange={handleNameChange}
                    placeholder={getLocString('integrationsCloudSqlNamePlaceholder', 'e.g. Sales data')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="service_account">
                    {getLocString('integrationsCloudSqlServiceAccountLabel', 'Service Account JSON')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <textarea
                    id="service_account"
                    value={pendingConfig.metadata.service_account}
                    onChange={handleServiceAccountChange}
                    placeholder={getLocString(
                        'integrationsCloudSqlServiceAccountPlaceholder',
                        '{\n  "type": "service_account",\n  "project_id": "...",\n  ...\n}'
                    )}
                    rows={8}
                    required
                    className={serviceAccountError ? 'error' : ''}
                />
                {serviceAccountError && <div className="error-message">{serviceAccountError}</div>}
                <small className="form-help">
                    {getLocString(
                        'integrationsCloudSqlServiceAccountHelp',
                        'Paste the contents of your Google Cloud service account JSON key file.'
                    )}{' '}
                    <a
                        href="https://cloud.google.com/iam/docs/creating-managing-service-account-keys"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {getLocString('integrationsCloudSqlLearnMore', 'Learn more.')}
                    </a>
                </small>
            </div>

            <div className="form-actions">
                <button type="submit" className="primary" disabled={!!serviceAccountError}>
                    {getLocString('integrationsSave', 'Save')}
                </button>
                <button type="button" className="secondary" onClick={onCancel}>
                    {getLocString('integrationsCancel', 'Cancel')}
                </button>
            </div>
        </form>
    );
};
