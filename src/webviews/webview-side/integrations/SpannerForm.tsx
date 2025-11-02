import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';

function createEmptySpannerConfig(params: {
    id: string;
    name?: string;
}): Extract<DatabaseIntegrationConfig, { type: 'spanner' }> {
    const unnamedIntegration = getLocString('integrationsUnnamedIntegration', 'Unnamed Integration ({0})');

    return {
        id: params.id,
        name: (params.name || format(unnamedIntegration, params.id)).trim(),
        type: 'spanner',
        metadata: {
            instance: '',
            database: '',
            service_account: '',
            dataBoostEnabled: false
        }
    };
}

export interface ISpannerFormProps {
    integrationId: string;
    existingConfig: Extract<DatabaseIntegrationConfig, { type: 'spanner' }> | null;
    defaultName?: string;
    onSave: (config: Extract<DatabaseIntegrationConfig, { type: 'spanner' }>) => void;
    onCancel: () => void;
}

export const SpannerForm: React.FC<ISpannerFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    onSave,
    onCancel
}) => {
    const [pendingConfig, setPendingConfig] = React.useState<Extract<DatabaseIntegrationConfig, { type: 'spanner' }>>(
        existingConfig
            ? structuredClone(existingConfig)
            : createEmptySpannerConfig({ id: integrationId, name: defaultName })
    );
    const [serviceAccountError, setServiceAccountError] = React.useState<string | null>(null);

    React.useEffect(() => {
        setPendingConfig(
            existingConfig
                ? structuredClone(existingConfig)
                : createEmptySpannerConfig({ id: integrationId, name: defaultName })
        );
    }, [existingConfig, integrationId, defaultName]);

    const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({ ...prev, name: value }));
    };

    const handleInstanceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, instance: value } }));
    };

    const handleDatabaseChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, database: value } }));
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
                    getLocString('integrationsSpannerServiceAccountInvalidJson', 'Invalid JSON format')
                );
            }
        }

        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, service_account: value } }));
    };

    const handleDataBoostChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const checked = e.target.checked;
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, dataBoostEnabled: checked } }));
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        // Validate service account JSON
        if (pendingConfig.metadata.service_account.trim()) {
            try {
                JSON.parse(pendingConfig.metadata.service_account);
            } catch (err) {
                setServiceAccountError(
                    getLocString('integrationsSpannerServiceAccountInvalidJson', 'Invalid JSON format')
                );
                return;
            }
        }

        onSave(pendingConfig);
    };

    return (
        <form onSubmit={handleSubmit}>
            <div className="form-group">
                <label htmlFor="name">{getLocString('integrationsSpannerNameLabel', 'Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={pendingConfig.name}
                    onChange={handleNameChange}
                    placeholder={getLocString('integrationsSpannerNamePlaceholder', 'My Spanner Database')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="instance">
                    {getLocString('integrationsSpannerInstanceLabel', 'Instance ID')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="instance"
                    value={pendingConfig.metadata.instance}
                    onChange={handleInstanceChange}
                    placeholder={getLocString('integrationsSpannerInstancePlaceholder', 'my-instance')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="database">
                    {getLocString('integrationsSpannerDatabaseLabel', 'Database')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="database"
                    value={pendingConfig.metadata.database}
                    onChange={handleDatabaseChange}
                    placeholder={getLocString('integrationsSpannerDatabasePlaceholder', 'my-database')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="service_account">
                    {getLocString('integrationsSpannerServiceAccountLabel', 'Service Account JSON')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <textarea
                    id="service_account"
                    value={pendingConfig.metadata.service_account}
                    onChange={handleServiceAccountChange}
                    placeholder={getLocString(
                        'integrationsSpannerServiceAccountPlaceholder',
                        '{\n  "type": "service_account",\n  "project_id": "...",\n  ...\n}'
                    )}
                    rows={8}
                    required
                    className={serviceAccountError ? 'error' : ''}
                />
                {serviceAccountError && <div className="error-message">{serviceAccountError}</div>}
                <small className="form-help">
                    {getLocString(
                        'integrationsSpannerServiceAccountHelp',
                        'Paste the contents of your Google Cloud service account JSON key file.'
                    )}
                </small>
            </div>

            <div className="form-group">
                <label>
                    <input
                        type="checkbox"
                        checked={pendingConfig.metadata.dataBoostEnabled}
                        onChange={handleDataBoostChange}
                    />{' '}
                    {getLocString('integrationsSpannerDataBoostLabel', 'Enable Data Boost')}
                </label>
                <small className="form-help">
                    {getLocString(
                        'integrationsSpannerDataBoostHelp',
                        'Data Boost provides independent compute resources for analytics queries.'
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
