import * as React from 'react';
import { getLocString } from '../react-common/locReactSide';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';
import { getDefaultIntegrationName } from './integrationUtils';

function createEmptyCloudSqlConfig(params: {
    id: string;
    name?: string;
}): Extract<DatabaseIntegrationConfig, { type: 'cloud-sql' }> {
    return {
        id: params.id,
        name: (params.name || getDefaultIntegrationName('cloud-sql')).trim(),
        type: 'cloud-sql',
        metadata: {
            service_account: ''
        }
    };
}

export interface ICloudSqlFormProps {
    integrationId: string;
    existingConfig: Extract<DatabaseIntegrationConfig, { type: 'cloud-sql' }> | null;
    defaultName?: string;
    onSave: (config: Extract<DatabaseIntegrationConfig, { type: 'cloud-sql' }>) => void;
    onCancel: () => void;
}

export const CloudSqlForm: React.FC<ICloudSqlFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    onSave,
    onCancel
}) => {
    const [pendingConfig, setPendingConfig] = React.useState<Extract<DatabaseIntegrationConfig, { type: 'cloud-sql' }>>(
        existingConfig
            ? structuredClone(existingConfig)
            : createEmptyCloudSqlConfig({ id: integrationId, name: defaultName })
    );
    const [serviceAccountError, setServiceAccountError] = React.useState<string | null>(null);

    React.useEffect(() => {
        setPendingConfig(
            existingConfig
                ? structuredClone(existingConfig)
                : createEmptyCloudSqlConfig({ id: integrationId, name: defaultName })
        );
        setServiceAccountError(null);
    }, [existingConfig, integrationId, defaultName]);

    const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({ ...prev, name: value }));
    };

    const handleServiceAccountChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const value = e.target.value;
        setServiceAccountError(null);

        // Try to parse as JSON to validate
        if (value.trim()) {
            try {
                JSON.parse(value);
            } catch (err) {
                setServiceAccountError(
                    getLocString('integrationsCloudSqlServiceAccountInvalidJson', 'Invalid JSON format')
                );
            }
        }

        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, service_account: value } }));
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        const serviceAccount = pendingConfig.metadata.service_account.trim();

        // Service account is required (`required` on the textarea does not reject whitespace-only input)
        if (!serviceAccount) {
            setServiceAccountError(
                getLocString('integrationsCloudSqlServiceAccountRequired', 'Service account is required')
            );
            return;
        }

        // Validate service account JSON
        try {
            JSON.parse(serviceAccount);
        } catch (err) {
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
                    placeholder={getLocString('integrationsCloudSqlNamePlaceholder', 'My Cloud SQL Database')}
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
                    )}
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
