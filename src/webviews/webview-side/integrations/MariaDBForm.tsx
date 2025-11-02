import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';
import { SshOptionsFields } from './SshOptionsFields';
import { CaCertificateFields } from './CaCertificateFields';

function createEmptyMariaDBConfig(params: {
    id: string;
    name?: string;
}): Extract<DatabaseIntegrationConfig, { type: 'mariadb' }> {
    const unnamedIntegration = getLocString('integrationsUnnamedIntegration', 'Unnamed Integration ({0})');

    return {
        id: params.id,
        name: (params.name || format(unnamedIntegration, params.id)).trim(),
        type: 'mariadb',
        metadata: {
            host: '',
            port: '3306',
            database: '',
            user: '',
            password: ''
        }
    };
}

export interface IMariaDBFormProps {
    integrationId: string;
    existingConfig: Extract<DatabaseIntegrationConfig, { type: 'mariadb' }> | null;
    defaultName?: string;
    onSave: (config: Extract<DatabaseIntegrationConfig, { type: 'mariadb' }>) => void;
    onCancel: () => void;
}

export const MariaDBForm: React.FC<IMariaDBFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    onSave,
    onCancel
}) => {
    const [pendingConfig, setPendingConfig] = React.useState<Extract<DatabaseIntegrationConfig, { type: 'mariadb' }>>(
        existingConfig
            ? structuredClone(existingConfig)
            : createEmptyMariaDBConfig({ id: integrationId, name: defaultName })
    );

    React.useEffect(() => {
        setPendingConfig(
            existingConfig
                ? structuredClone(existingConfig)
                : createEmptyMariaDBConfig({ id: integrationId, name: defaultName })
        );
    }, [existingConfig, integrationId, defaultName]);

    const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({ ...prev, name: e.target.value }));
    };

    const handleHostChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, host: e.target.value } }));
    };

    const handlePortChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, port: e.target.value } }));
    };

    const handleDatabaseChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, database: e.target.value } }));
    };

    const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, user: e.target.value } }));
    };

    const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, password: e.target.value } }));
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
                <label htmlFor="name">{getLocString('integrationsMariaDBNameLabel', 'Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={pendingConfig.name}
                    onChange={handleNameChange}
                    placeholder={getLocString('integrationsMariaDBNamePlaceholder', 'My MariaDB Database')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="host">
                    {getLocString('integrationsMariaDBHostLabel', 'Host')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="host"
                    value={pendingConfig.metadata.host}
                    onChange={handleHostChange}
                    placeholder={getLocString('integrationsMariaDBHostPlaceholder', 'localhost')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="port">{getLocString('integrationsMariaDBPortLabel', 'Port')}</label>
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
                    {getLocString('integrationsMariaDBDatabaseLabel', 'Database')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="database"
                    value={pendingConfig.metadata.database}
                    onChange={handleDatabaseChange}
                    placeholder={getLocString('integrationsMariaDBDatabasePlaceholder', 'my_database')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="username">
                    {getLocString('integrationsMariaDBUsernameLabel', 'Username')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="username"
                    value={pendingConfig.metadata.user}
                    onChange={handleUsernameChange}
                    placeholder={getLocString('integrationsMariaDBUsernamePlaceholder', 'username')}
                    autoComplete="username"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="password">
                    {getLocString('integrationsMariaDBPasswordLabel', 'Password')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="password"
                    id="password"
                    value={pendingConfig.metadata.password}
                    onChange={handlePasswordChange}
                    placeholder={getLocString('integrationsMariaDBPasswordPlaceholder', '••••••••')}
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
