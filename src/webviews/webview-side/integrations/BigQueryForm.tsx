import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import { BigQueryIntegrationConfig } from './types';

export interface IBigQueryFormProps {
    integrationId: string;
    existingConfig: BigQueryIntegrationConfig | null;
    onSave: (config: BigQueryIntegrationConfig) => void;
    onCancel: () => void;
}

export const BigQueryForm: React.FC<IBigQueryFormProps> = ({ integrationId, existingConfig, onSave, onCancel }) => {
    const [name, setName] = React.useState(existingConfig?.name || '');
    const [projectId, setProjectId] = React.useState(existingConfig?.projectId || '');
    const [credentials, setCredentials] = React.useState(existingConfig?.credentials || '');
    const [credentialsError, setCredentialsError] = React.useState<string | null>(null);

    // Update form fields when existingConfig changes
    React.useEffect(() => {
        if (existingConfig) {
            setName(existingConfig.name || '');
            setProjectId(existingConfig.projectId || '');
            setCredentials(existingConfig.credentials || '');
            setCredentialsError(null);
        }
    }, [existingConfig]);

    const validateCredentials = (value: string): boolean => {
        if (!value.trim()) {
            setCredentialsError(getLocString('integrationsBigQueryCredentialsRequired', 'Credentials are required'));
            return false;
        }

        try {
            JSON.parse(value);
            setCredentialsError(null);
            return true;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Invalid JSON format';
            const invalidJsonMsg = format('Invalid JSON: {0}', errorMessage);
            setCredentialsError(invalidJsonMsg);
            return false;
        }
    };

    const handleCredentialsChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const value = e.target.value;
        setCredentials(value);
        validateCredentials(value);
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        // Validate credentials before submitting
        if (!validateCredentials(credentials)) {
            return;
        }

        const unnamedIntegration = format('Unnamed BigQuery Integration ({0})', integrationId);

        const config: BigQueryIntegrationConfig = {
            id: integrationId,
            name: name || unnamedIntegration,
            type: 'bigquery',
            projectId,
            credentials
        };

        onSave(config);
    };

    return (
        <form onSubmit={handleSubmit}>
            <div className="form-group">
                <label htmlFor="name">{getLocString('integrationsBigQueryNameLabel', 'Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={getLocString('integrationsBigQueryNamePlaceholder', 'My BigQuery Project')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="projectId">
                    {getLocString('integrationsBigQueryProjectIdLabel', 'Project ID')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="projectId"
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    placeholder={getLocString('integrationsBigQueryProjectIdPlaceholder', 'my-project-id')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="credentials">
                    {getLocString('integrationsBigQueryCredentialsLabel', 'Service Account Credentials (JSON)')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <textarea
                    id="credentials"
                    value={credentials}
                    onChange={handleCredentialsChange}
                    placeholder={getLocString(
                        'integrationsBigQueryCredentialsPlaceholder',
                        '{"type": "service_account", ...}'
                    )}
                    rows={10}
                    autoComplete="off"
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                    required
                    aria-invalid={credentialsError ? 'true' : 'false'}
                    aria-describedby={credentialsError ? 'credentials-error' : undefined}
                />
                {credentialsError && (
                    <div id="credentials-error" className="error-message" role="alert">
                        {credentialsError}
                    </div>
                )}
            </div>

            <div className="form-actions">
                <button type="submit" className="primary">
                    {getLocString('integrationsSave', 'Save')}
                </button>
                <button type="button" className="secondary" onClick={onCancel}>
                    {getLocString('integrationsCancel', 'Cancel')}
                </button>
            </div>
        </form>
    );
};
