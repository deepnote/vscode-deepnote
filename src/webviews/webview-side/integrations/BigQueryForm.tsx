import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import { BigQueryAuthMethods, DatabaseIntegrationConfig } from '@deepnote/database-integrations';

type BigQueryConfig = Extract<DatabaseIntegrationConfig, { type: 'big-query' }>;

function createEmptyBigQueryConfig(params: { id: string; name?: string }): BigQueryConfig {
    const unnamedIntegration = getLocString('integrationsUnnamedIntegration', 'Unnamed Integration ({0})');

    return {
        id: params.id,
        name: (params.name || format(unnamedIntegration, params.id)).trim(),
        type: 'big-query',
        metadata: {
            authMethod: BigQueryAuthMethods.ServiceAccount,
            service_account: ''
        }
    };
}

export interface IBigQueryFormProps {
    integrationId: string;
    existingConfig: BigQueryConfig | null;
    defaultName?: string;
    onSave: (config: BigQueryConfig) => void;
    onCancel: () => void;
}

export const BigQueryForm: React.FC<IBigQueryFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    onSave,
    onCancel
}) => {
    const [pendingConfig, setPendingConfig] = React.useState<BigQueryConfig>(
        existingConfig && existingConfig.metadata.authMethod === BigQueryAuthMethods.ServiceAccount
            ? structuredClone(existingConfig)
            : createEmptyBigQueryConfig({ id: integrationId, name: defaultName })
    );

    const [credentialsError, setCredentialsError] = React.useState<string | null>(null);

    React.useEffect(() => {
        setPendingConfig(
            existingConfig && existingConfig.metadata.authMethod === BigQueryAuthMethods.ServiceAccount
                ? structuredClone(existingConfig)
                : createEmptyBigQueryConfig({ id: integrationId, name: defaultName })
        );
        setCredentialsError(null);
    }, [existingConfig, integrationId, defaultName]);

    // Extract service account value with proper type narrowing
    const serviceAccountValue =
        pendingConfig.metadata.authMethod === BigQueryAuthMethods.ServiceAccount
            ? pendingConfig.metadata.service_account
            : '';

    const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({
            ...prev,
            name: e.target.value
        }));
    };

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

        setPendingConfig((prev) => {
            if (prev.metadata.authMethod === BigQueryAuthMethods.ServiceAccount) {
                return {
                    ...prev,
                    metadata: {
                        ...prev.metadata,
                        service_account: value
                    }
                };
            }
            return prev;
        });

        validateCredentials(value);
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        // Validate credentials before submitting
        if (!validateCredentials(serviceAccountValue)) {
            return;
        }

        onSave(pendingConfig);
    };

    return (
        <form onSubmit={handleSubmit}>
            <div className="form-group">
                <label htmlFor="name">{getLocString('integrationsBigQueryNameLabel', 'Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={pendingConfig.name}
                    onChange={handleNameChange}
                    placeholder={getLocString('integrationsBigQueryNamePlaceholder', 'My BigQuery Project')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="credentials">
                    {getLocString('integrationsBigQueryCredentialsLabel', 'Service Account Credentials (JSON)')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <textarea
                    id="credentials"
                    value={serviceAccountValue}
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
