import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import { BigQueryAuthMethods, DatabaseIntegrationConfig } from '@deepnote/database-integrations';
import { getDefaultIntegrationName } from './integrationUtils';

type BigQueryConfig = Extract<DatabaseIntegrationConfig, { type: 'big-query' }>;
type BigQueryAuthMethod = BigQueryConfig['metadata']['authMethod'];

function isBigQueryAuthMethod(value: string | undefined): value is BigQueryAuthMethod {
    return value === BigQueryAuthMethods.ServiceAccount || value === BigQueryAuthMethods.GoogleOauth;
}

function createEmptyBigQueryConfig(params: {
    id: string;
    name?: string;
    authMethod?: BigQueryAuthMethod;
}): BigQueryConfig {
    const name = (params.name || getDefaultIntegrationName('big-query')).trim();
    const authMethod = params.authMethod ?? BigQueryAuthMethods.ServiceAccount;
    if (authMethod === BigQueryAuthMethods.GoogleOauth) {
        return {
            id: params.id,
            name,
            type: 'big-query',
            metadata: {
                authMethod: BigQueryAuthMethods.GoogleOauth,
                project: '',
                clientId: '',
                clientSecret: ''
            }
        };
    }
    return {
        id: params.id,
        name,
        type: 'big-query',
        metadata: {
            authMethod: BigQueryAuthMethods.ServiceAccount,
            service_account: ''
        }
    };
}

function buildInitialConfig(
    existingConfig: BigQueryConfig | null,
    integrationId: string,
    defaultName?: string
): BigQueryConfig {
    if (!existingConfig) {
        return createEmptyBigQueryConfig({ id: integrationId, name: defaultName });
    }
    // Preserve existing config when its auth method is supported. Both
    // service-account and google-oauth are editable in this milestone.
    return structuredClone(existingConfig);
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
    const [pendingConfig, setPendingConfig] = React.useState<BigQueryConfig>(() =>
        buildInitialConfig(existingConfig, integrationId, defaultName)
    );

    const [credentialsError, setCredentialsError] = React.useState<string | null>(null);

    React.useEffect(() => {
        setPendingConfig(buildInitialConfig(existingConfig, integrationId, defaultName));
        setCredentialsError(null);
    }, [existingConfig, integrationId, defaultName]);

    const authMethod = pendingConfig.metadata.authMethod ?? BigQueryAuthMethods.ServiceAccount;

    // Extract service account value with proper type narrowing
    const serviceAccountValue =
        pendingConfig.metadata.authMethod === BigQueryAuthMethods.ServiceAccount
            ? pendingConfig.metadata.service_account
            : '';

    const oauthProject =
        pendingConfig.metadata.authMethod === BigQueryAuthMethods.GoogleOauth ? pendingConfig.metadata.project : '';
    const oauthClientId =
        pendingConfig.metadata.authMethod === BigQueryAuthMethods.GoogleOauth ? pendingConfig.metadata.clientId : '';
    const oauthClientSecret =
        pendingConfig.metadata.authMethod === BigQueryAuthMethods.GoogleOauth
            ? pendingConfig.metadata.clientSecret
            : '';

    const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({
            ...prev,
            name: value
        }));
    };

    const handleAuthMethodChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const nextAuthMethod = e.target.value;
        if (!isBigQueryAuthMethod(nextAuthMethod)) {
            // The <select> only renders the two canonical options, so this is
            // defence-in-depth against a stale/mismatched value flowing through.
            return;
        }
        setPendingConfig((prev) =>
            createEmptyBigQueryConfig({ id: prev.id, name: prev.name, authMethod: nextAuthMethod })
        );
        setCredentialsError(null);
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

    const handleOauthFieldChange =
        (field: 'project' | 'clientId' | 'clientSecret') => (e: React.ChangeEvent<HTMLInputElement>) => {
            const value = e.target.value;
            setPendingConfig((prev) => {
                if (prev.metadata.authMethod !== BigQueryAuthMethods.GoogleOauth) {
                    return prev;
                }
                return {
                    ...prev,
                    metadata: {
                        ...prev.metadata,
                        [field]: value
                    }
                };
            });
        };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        if (pendingConfig.metadata.authMethod === BigQueryAuthMethods.GoogleOauth) {
            // The browser-native `required` attribute on each input already
            // blocks empty submissions; no extra runtime validation needed
            // beyond preventing an empty save when all the fields are blank.
            onSave(pendingConfig);
            return;
        }

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
                <label htmlFor="bigquery-auth-method">
                    {getLocString('integrationsBigQueryAuthMethodLabel', 'Authentication method')}
                </label>
                <select id="bigquery-auth-method" value={authMethod} onChange={handleAuthMethodChange}>
                    <option value={BigQueryAuthMethods.ServiceAccount}>
                        {getLocString('integrationsBigQueryAuthMethodServiceAccount', 'Service account')}
                    </option>
                    <option value={BigQueryAuthMethods.GoogleOauth}>
                        {getLocString('integrationsBigQueryAuthMethodGoogleOauth', 'Google OAuth')}
                    </option>
                </select>
            </div>

            {authMethod === BigQueryAuthMethods.ServiceAccount && (
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
            )}

            {authMethod === BigQueryAuthMethods.GoogleOauth && (
                <>
                    <div className="form-help">
                        {getLocString(
                            'integrationsBigQueryGoogleOauthHelp',
                            "Create a 'Desktop app' OAuth client in Google Cloud Console and paste the client ID and secret above. The redirect URI is configured automatically."
                        )}
                    </div>

                    <div className="form-group">
                        <label htmlFor="bigquery-project">
                            {getLocString('integrationsBigQueryProjectLabel', 'Project')}{' '}
                            <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                        </label>
                        <input
                            type="text"
                            id="bigquery-project"
                            value={oauthProject}
                            onChange={handleOauthFieldChange('project')}
                            placeholder={getLocString('integrationsBigQueryProjectPlaceholder', 'my-project-id')}
                            autoComplete="off"
                            required
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="bigquery-client-id">
                            {getLocString('integrationsBigQueryClientIdLabel', 'OAuth client ID')}{' '}
                            <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                        </label>
                        <input
                            type="text"
                            id="bigquery-client-id"
                            value={oauthClientId}
                            onChange={handleOauthFieldChange('clientId')}
                            placeholder={getLocString(
                                'integrationsBigQueryClientIdPlaceholder',
                                '1234567890-abc.apps.googleusercontent.com'
                            )}
                            autoComplete="off"
                            required
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="bigquery-client-secret">
                            {getLocString('integrationsBigQueryClientSecretLabel', 'OAuth client secret')}{' '}
                            <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                        </label>
                        <input
                            type="password"
                            id="bigquery-client-secret"
                            value={oauthClientSecret}
                            onChange={handleOauthFieldChange('clientSecret')}
                            placeholder={getLocString('integrationsBigQueryClientSecretPlaceholder', 'GOCSPX-...')}
                            autoComplete="off"
                            required
                        />
                    </div>
                </>
            )}

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
