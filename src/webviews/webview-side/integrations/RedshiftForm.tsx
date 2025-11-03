import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';
import { SshOptionsFields } from './SshOptionsFields';
import { CaCertificateFields } from './CaCertificateFields';

type RedshiftConfig = Extract<DatabaseIntegrationConfig, { type: 'redshift' }>;

function createEmptyRedshiftConfig(params: { id: string; name?: string }): RedshiftConfig {
    const unnamedIntegration = getLocString('integrationsUnnamedIntegration', 'Unnamed Integration ({0})');

    return {
        id: params.id,
        name: (params.name || format(unnamedIntegration, params.id)).trim(),
        type: 'redshift',
        metadata: {
            authMethod: 'username-and-password',
            host: '',
            port: '5439',
            database: '',
            user: '',
            password: ''
        }
    };
}

export interface IRedshiftFormProps {
    integrationId: string;
    existingConfig: RedshiftConfig | null;
    defaultName?: string;
    onSave: (config: RedshiftConfig) => void;
    onCancel: () => void;
}

export const RedshiftForm: React.FC<IRedshiftFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    onSave,
    onCancel
}) => {
    const [pendingConfig, setPendingConfig] = React.useState<RedshiftConfig>(
        existingConfig
            ? structuredClone(existingConfig)
            : createEmptyRedshiftConfig({ id: integrationId, name: defaultName })
    );
    // Store credentials temporarily when switching to individual-credentials
    const [savedCredentials, setSavedCredentials] = React.useState<{ user: string; password: string }>({
        user: '',
        password: ''
    });

    React.useEffect(() => {
        setPendingConfig(
            existingConfig
                ? structuredClone(existingConfig)
                : createEmptyRedshiftConfig({ id: integrationId, name: defaultName })
        );
    }, [existingConfig, integrationId, defaultName]);

    const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({ ...prev, name: value }));
    };

    const handleAuthMethodChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const value = e.target.value;
        const authMethod = value as 'username-and-password' | 'individual-credentials';
        if (authMethod === 'username-and-password') {
            setPendingConfig((prev) => ({
                ...prev,
                metadata: {
                    authMethod: 'username-and-password',
                    host: prev.metadata.host,
                    port: prev.metadata.port,
                    database: prev.metadata.database,
                    user: savedCredentials.user,
                    password: savedCredentials.password
                }
            }));
        } else {
            // Save current credentials before switching
            if (pendingConfig.metadata.authMethod === 'username-and-password') {
                setSavedCredentials({
                    user: pendingConfig.metadata.user,
                    password: pendingConfig.metadata.password
                });
            }
            setPendingConfig((prev) => ({
                ...prev,
                metadata: {
                    authMethod: 'individual-credentials',
                    host: prev.metadata.host,
                    port: prev.metadata.port,
                    database: prev.metadata.database
                }
            }));
        }
    };

    const handleHostChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, host: value } }));
    };

    const handlePortChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, port: value } }));
    };

    const handleDatabaseChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, database: value } }));
    };

    const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        if (pendingConfig.metadata.authMethod === 'username-and-password') {
            setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, user: value } }));
        }
    };

    const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        if (pendingConfig.metadata.authMethod === 'username-and-password') {
            setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, password: value } }));
        }
    };

    const handleSshEnabledChange = (enabled: boolean) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: { ...prev.metadata, sshEnabled: enabled || undefined }
        }));
    };

    const handleSshHostChange = (host: string) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: { ...prev.metadata, sshHost: host || undefined }
        }));
    };

    const handleSshPortChange = (port: string) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: { ...prev.metadata, sshPort: port || undefined }
        }));
    };

    const handleSshUserChange = (user: string) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: { ...prev.metadata, sshUser: user || undefined }
        }));
    };

    const handleSslEnabledChange = (enabled: boolean) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: { ...prev.metadata, sslEnabled: enabled || undefined }
        }));
    };

    const handleCaCertificateNameChange = (name: string) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: { ...prev.metadata, caCertificateName: name || undefined }
        }));
    };

    const handleCaCertificateTextChange = (text: string) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: { ...prev.metadata, caCertificateText: text || undefined }
        }));
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(pendingConfig);
    };

    return (
        <form onSubmit={handleSubmit}>
            <div className="form-group">
                <label htmlFor="name">{getLocString('integrationsRedshiftNameLabel', 'Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={pendingConfig.name}
                    onChange={handleNameChange}
                    placeholder={getLocString('integrationsRedshiftNamePlaceholder', 'My Redshift Cluster')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="authMethod">
                    {getLocString('integrationsRedshiftAuthMethodLabel', 'Authentication Method')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <select id="authMethod" value={pendingConfig.metadata.authMethod} onChange={handleAuthMethodChange}>
                    <option value="username-and-password">
                        {getLocString('integrationsRedshiftAuthMethodUsernamePassword', 'Username and Password')}
                    </option>
                    <option value="individual-credentials">
                        {getLocString(
                            'integrationsRedshiftAuthMethodIndividualCredentials',
                            'Individual Credentials (IAM)'
                        )}
                    </option>
                </select>
                <small className="form-help">
                    {getLocString(
                        'integrationsRedshiftAuthMethodHelp',
                        'Individual Credentials uses your AWS credentials configured in the environment.'
                    )}
                </small>
            </div>

            <div className="form-group">
                <label htmlFor="host">
                    {getLocString('integrationsRedshiftHostLabel', 'Cluster Endpoint')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="host"
                    value={pendingConfig.metadata.host}
                    onChange={handleHostChange}
                    placeholder={getLocString(
                        'integrationsRedshiftHostPlaceholder',
                        'my-cluster.abc123.us-east-1.redshift.amazonaws.com'
                    )}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="port">{getLocString('integrationsRedshiftPortLabel', 'Port')}</label>
                <input
                    type="text"
                    id="port"
                    value={pendingConfig.metadata.port || '5439'}
                    onChange={handlePortChange}
                    placeholder="5439"
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="database">
                    {getLocString('integrationsRedshiftDatabaseLabel', 'Database')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="database"
                    value={pendingConfig.metadata.database}
                    onChange={handleDatabaseChange}
                    placeholder={getLocString('integrationsRedshiftDatabasePlaceholder', 'dev')}
                    autoComplete="off"
                    required
                />
            </div>

            {pendingConfig.metadata.authMethod === 'username-and-password' && (
                <>
                    <div className="form-group">
                        <label htmlFor="username">
                            {getLocString('integrationsRedshiftUsernameLabel', 'Username')}{' '}
                            <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                        </label>
                        <input
                            type="text"
                            id="username"
                            value={pendingConfig.metadata.user}
                            onChange={handleUsernameChange}
                            placeholder={getLocString('integrationsRedshiftUsernamePlaceholder', 'admin')}
                            autoComplete="username"
                            required
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="password">
                            {getLocString('integrationsRedshiftPasswordLabel', 'Password')}{' '}
                            <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                        </label>
                        <input
                            type="password"
                            id="password"
                            value={pendingConfig.metadata.password}
                            onChange={handlePasswordChange}
                            placeholder={getLocString('integrationsRedshiftPasswordPlaceholder', '••••••••')}
                            autoComplete="current-password"
                            required
                        />
                    </div>
                </>
            )}

            <SshOptionsFields
                sshEnabled={pendingConfig.metadata.sshEnabled}
                sshHost={pendingConfig.metadata.sshHost}
                sshPort={pendingConfig.metadata.sshPort}
                sshUser={pendingConfig.metadata.sshUser}
                onSshEnabledChange={handleSshEnabledChange}
                onSshHostChange={handleSshHostChange}
                onSshPortChange={handleSshPortChange}
                onSshUserChange={handleSshUserChange}
            />

            <CaCertificateFields
                sslEnabled={pendingConfig.metadata.sslEnabled}
                caCertificateName={pendingConfig.metadata.caCertificateName}
                caCertificateText={pendingConfig.metadata.caCertificateText}
                onSslEnabledChange={handleSslEnabledChange}
                onCaCertificateNameChange={handleCaCertificateNameChange}
                onCaCertificateTextChange={handleCaCertificateTextChange}
                showSslEnabled={true}
                showCertificateText={true}
            />

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
