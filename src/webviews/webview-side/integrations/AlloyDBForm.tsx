import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';
import { SshOptionsFields } from './SshOptionsFields';
import { CaCertificateFields } from './CaCertificateFields';

export interface IAlloyDBFormProps {
    integrationId: string;
    existingConfig: Extract<DatabaseIntegrationConfig, { type: 'alloydb' }> | null;
    defaultName?: string;
    onSave: (config: Extract<DatabaseIntegrationConfig, { type: 'alloydb' }>) => void;
    onCancel: () => void;
}

function createEmptyAlloyDBConfig(params: {
    id: string;
    name?: string;
}): Extract<DatabaseIntegrationConfig, { type: 'alloydb' }> {
    const unnamedIntegration = getLocString('integrationsUnnamedIntegration', 'Unnamed Integration ({0})');

    return {
        id: params.id,
        name: (params.name || format(unnamedIntegration, params.id)).trim(),
        type: 'alloydb',
        metadata: {
            host: '',
            user: '',
            password: '',
            database: ''
        }
    };
}

export const AlloyDBForm: React.FC<IAlloyDBFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    onSave,
    onCancel
}) => {
    const [pendingConfig, setPendingConfig] = React.useState<Extract<DatabaseIntegrationConfig, { type: 'alloydb' }>>(
        existingConfig
            ? structuredClone(existingConfig)
            : createEmptyAlloyDBConfig({ id: integrationId, name: defaultName })
    );

    React.useEffect(() => {
        setPendingConfig(
            existingConfig
                ? structuredClone(existingConfig)
                : createEmptyAlloyDBConfig({ id: integrationId, name: defaultName })
        );
    }, [existingConfig, integrationId, defaultName]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(pendingConfig);
    };

    const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig({ ...pendingConfig, name: e.target.value });
    };

    const handleHostChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig({
            ...pendingConfig,
            metadata: { ...pendingConfig.metadata, host: e.target.value }
        });
    };

    const handlePortChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig({
            ...pendingConfig,
            metadata: { ...pendingConfig.metadata, port: e.target.value || undefined }
        });
    };

    const handleDatabaseChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig({
            ...pendingConfig,
            metadata: { ...pendingConfig.metadata, database: e.target.value }
        });
    };

    const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig({
            ...pendingConfig,
            metadata: { ...pendingConfig.metadata, user: e.target.value }
        });
    };

    const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig({
            ...pendingConfig,
            metadata: { ...pendingConfig.metadata, password: e.target.value }
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

    const handleSslEnabledChange = (enabled: boolean) => {
        setPendingConfig({
            ...pendingConfig,
            metadata: { ...pendingConfig.metadata, sslEnabled: enabled || undefined }
        });
    };

    const handleCaCertificateNameChange = (name: string) => {
        setPendingConfig({
            ...pendingConfig,
            metadata: { ...pendingConfig.metadata, caCertificateName: name || undefined }
        });
    };

    const handleCaCertificateTextChange = (text: string) => {
        setPendingConfig({
            ...pendingConfig,
            metadata: { ...pendingConfig.metadata, caCertificateText: text || undefined }
        });
    };

    return (
        <form onSubmit={handleSubmit}>
            <div className="form-group">
                <label htmlFor="name">{getLocString('integrationsAlloyDBNameLabel', 'Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={pendingConfig.name}
                    onChange={handleNameChange}
                    placeholder={getLocString('integrationsAlloyDBNamePlaceholder', 'My AlloyDB Database')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="host">
                    {getLocString('integrationsAlloyDBHostLabel', 'Host')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="host"
                    value={pendingConfig.metadata.host}
                    onChange={handleHostChange}
                    placeholder={getLocString('integrationsAlloyDBHostPlaceholder', 'localhost')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="port">{getLocString('integrationsAlloyDBPortLabel', 'Port')}</label>
                <input
                    type="text"
                    id="port"
                    value={pendingConfig.metadata.port || ''}
                    onChange={handlePortChange}
                    placeholder="5432"
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="database">
                    {getLocString('integrationsAlloyDBDatabaseLabel', 'Database')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="database"
                    value={pendingConfig.metadata.database}
                    onChange={handleDatabaseChange}
                    placeholder={getLocString('integrationsAlloyDBDatabasePlaceholder', 'my_database')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="username">
                    {getLocString('integrationsAlloyDBUsernameLabel', 'Username')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="username"
                    value={pendingConfig.metadata.user}
                    onChange={handleUsernameChange}
                    placeholder={getLocString('integrationsAlloyDBUsernamePlaceholder', 'username')}
                    autoComplete="username"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="password">
                    {getLocString('integrationsAlloyDBPasswordLabel', 'Password')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="password"
                    id="password"
                    value={pendingConfig.metadata.password}
                    onChange={handlePasswordChange}
                    placeholder={getLocString('integrationsAlloyDBPasswordPlaceholder', '••••••••')}
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
