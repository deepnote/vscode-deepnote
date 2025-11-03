import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';
import { SshOptionsFields } from './SshOptionsFields';
import { CaCertificateFields } from './CaCertificateFields';

export interface IMindsDBFormProps {
    integrationId: string;
    existingConfig: Extract<DatabaseIntegrationConfig, { type: 'mindsdb' }> | null;
    defaultName?: string;
    onSave: (config: Extract<DatabaseIntegrationConfig, { type: 'mindsdb' }>) => void;
    onCancel: () => void;
}

function createEmptyMindsDBConfig(params: {
    id: string;
    name?: string;
}): Extract<DatabaseIntegrationConfig, { type: 'mindsdb' }> {
    const unnamedIntegration = getLocString('integrationsUnnamedIntegration', 'Unnamed Integration ({0})');

    return {
        id: params.id,
        name: (params.name || format(unnamedIntegration, params.id)).trim(),
        type: 'mindsdb',
        metadata: {
            host: '',
            user: '',
            password: '',
            database: ''
        }
    };
}

export const MindsDBForm: React.FC<IMindsDBFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    onSave,
    onCancel
}) => {
    const [pendingConfig, setPendingConfig] = React.useState<Extract<DatabaseIntegrationConfig, { type: 'mindsdb' }>>(
        existingConfig
            ? structuredClone(existingConfig)
            : createEmptyMindsDBConfig({ id: integrationId, name: defaultName })
    );

    React.useEffect(() => {
        setPendingConfig(
            existingConfig
                ? structuredClone(existingConfig)
                : createEmptyMindsDBConfig({ id: integrationId, name: defaultName })
        );
    }, [existingConfig, integrationId, defaultName]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(pendingConfig);
    };

    const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig({ ...pendingConfig, name: value });
    };

    const handleHostChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig({
            ...pendingConfig,
            metadata: { ...pendingConfig.metadata, host: value }
        });
    };

    const handlePortChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig({
            ...pendingConfig,
            metadata: { ...pendingConfig.metadata, port: value || undefined }
        });
    };

    const handleDatabaseChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig({
            ...pendingConfig,
            metadata: { ...pendingConfig.metadata, database: value }
        });
    };

    const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig({
            ...pendingConfig,
            metadata: { ...pendingConfig.metadata, user: value }
        });
    };

    const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig({
            ...pendingConfig,
            metadata: { ...pendingConfig.metadata, password: value }
        });
    };

    const handleSshEnabledChange = (enabled: boolean) => {
        setPendingConfig({
            ...pendingConfig,
            metadata: { ...pendingConfig.metadata, sshEnabled: enabled || undefined }
        });
    };

    const handleSshHostChange = (host: string) => {
        setPendingConfig({
            ...pendingConfig,
            metadata: { ...pendingConfig.metadata, sshHost: host || undefined }
        });
    };

    const handleSshPortChange = (port: string) => {
        setPendingConfig({
            ...pendingConfig,
            metadata: { ...pendingConfig.metadata, sshPort: port || undefined }
        });
    };

    const handleSshUserChange = (user: string) => {
        setPendingConfig({
            ...pendingConfig,
            metadata: { ...pendingConfig.metadata, sshUser: user || undefined }
        });
    };

    const handleCaCertificateNameChange = (name: string) => {
        setPendingConfig({
            ...pendingConfig,
            metadata: { ...pendingConfig.metadata, caCertificateName: name || undefined }
        });
    };

    return (
        <form onSubmit={handleSubmit}>
            <div className="form-group">
                <label htmlFor="name">{getLocString('integrationsMindsDBNameLabel', 'Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={pendingConfig.name}
                    onChange={handleNameChange}
                    placeholder={getLocString('integrationsMindsDBNamePlaceholder', 'My MindsDB Database')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="host">
                    {getLocString('integrationsMindsDBHostLabel', 'Host')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="host"
                    value={pendingConfig.metadata.host}
                    onChange={handleHostChange}
                    placeholder={getLocString('integrationsMindsDBHostPlaceholder', 'localhost')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="port">{getLocString('integrationsMindsDBPortLabel', 'Port')}</label>
                <input
                    type="text"
                    id="port"
                    value={pendingConfig.metadata.port || ''}
                    onChange={handlePortChange}
                    placeholder="47334"
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="database">
                    {getLocString('integrationsMindsDBDatabaseLabel', 'Database')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="database"
                    value={pendingConfig.metadata.database}
                    onChange={handleDatabaseChange}
                    placeholder={getLocString('integrationsMindsDBDatabasePlaceholder', 'my_database')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="username">
                    {getLocString('integrationsMindsDBUsernameLabel', 'Username')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="username"
                    value={pendingConfig.metadata.user}
                    onChange={handleUsernameChange}
                    placeholder={getLocString('integrationsMindsDBUsernamePlaceholder', 'username')}
                    autoComplete="username"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="password">
                    {getLocString('integrationsMindsDBPasswordLabel', 'Password')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="password"
                    id="password"
                    value={pendingConfig.metadata.password}
                    onChange={handlePasswordChange}
                    placeholder={getLocString('integrationsMindsDBPasswordPlaceholder', '••••••••')}
                    autoComplete="current-password"
                    required
                />
            </div>

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
                caCertificateName={pendingConfig.metadata.caCertificateName}
                onCaCertificateNameChange={handleCaCertificateNameChange}
                showSslEnabled={false}
                showCertificateText={false}
            />

            <div className="form-actions">
                <button type="button" className="secondary" onClick={onCancel}>
                    {getLocString('integrationsCancel', 'Cancel')}
                </button>
                <button type="submit" className="primary">
                    {getLocString('integrationsSave', 'Save')}
                </button>
            </div>
        </form>
    );
};
