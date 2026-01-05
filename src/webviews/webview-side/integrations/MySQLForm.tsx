import * as React from 'react';
import { getLocString } from '../react-common/locReactSide';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';
import { SshOptionsFields } from './SshOptionsFields';
import { CaCertificateFields } from './CaCertificateFields';
import { getDefaultIntegrationName } from './integrationUtils';

function createEmptyMySQLConfig(params: {
    id: string;
    name?: string;
}): Extract<DatabaseIntegrationConfig, { type: 'mysql' }> {
    return {
        id: params.id,
        name: (params.name || getDefaultIntegrationName('mysql')).trim(),
        type: 'mysql',
        metadata: {
            host: '',
            port: '3306',
            database: '',
            user: '',
            password: ''
        }
    };
}

export interface IMySQLFormProps {
    integrationId: string;
    existingConfig: Extract<DatabaseIntegrationConfig, { type: 'mysql' }> | null;
    defaultName?: string;
    onSave: (config: Extract<DatabaseIntegrationConfig, { type: 'mysql' }>) => void;
    onCancel: () => void;
}

export const MySQLForm: React.FC<IMySQLFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    onSave,
    onCancel
}) => {
    const [pendingConfig, setPendingConfig] = React.useState<Extract<DatabaseIntegrationConfig, { type: 'mysql' }>>(
        existingConfig
            ? structuredClone(existingConfig)
            : createEmptyMySQLConfig({ id: integrationId, name: defaultName })
    );

    React.useEffect(() => {
        setPendingConfig(
            existingConfig
                ? structuredClone(existingConfig)
                : createEmptyMySQLConfig({ id: integrationId, name: defaultName })
        );
    }, [existingConfig, integrationId, defaultName]);

    const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({ ...prev, name: value }));
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
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, user: value } }));
    };

    const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, password: value } }));
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

    const handleCaCertificateNameChange = (name: string) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: { ...prev.metadata, caCertificateName: name || undefined }
        }));
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(pendingConfig);
    };

    return (
        <form onSubmit={handleSubmit}>
            <div className="form-group">
                <label htmlFor="name">{getLocString('integrationsMySQLNameLabel', 'Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={pendingConfig.name}
                    onChange={handleNameChange}
                    placeholder={getLocString('integrationsMySQLNamePlaceholder', 'My MySQL Database')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="host">
                    {getLocString('integrationsMySQLHostLabel', 'Host')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="host"
                    value={pendingConfig.metadata.host}
                    onChange={handleHostChange}
                    placeholder={getLocString('integrationsMySQLHostPlaceholder', 'localhost')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="port">{getLocString('integrationsMySQLPortLabel', 'Port')}</label>
                <input
                    type="text"
                    id="port"
                    value={pendingConfig.metadata.port}
                    onChange={handlePortChange}
                    placeholder="3306"
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="database">
                    {getLocString('integrationsMySQLDatabaseLabel', 'Database')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="database"
                    value={pendingConfig.metadata.database}
                    onChange={handleDatabaseChange}
                    placeholder={getLocString('integrationsMySQLDatabasePlaceholder', 'my_database')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="username">
                    {getLocString('integrationsMySQLUsernameLabel', 'Username')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="username"
                    value={pendingConfig.metadata.user}
                    onChange={handleUsernameChange}
                    placeholder={getLocString('integrationsMySQLUsernamePlaceholder', 'username')}
                    autoComplete="username"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="password">
                    {getLocString('integrationsMySQLPasswordLabel', 'Password')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="password"
                    id="password"
                    value={pendingConfig.metadata.password}
                    onChange={handlePasswordChange}
                    placeholder={getLocString('integrationsMySQLPasswordPlaceholder', '••••••••')}
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
