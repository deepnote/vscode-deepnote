import * as React from 'react';
import { getLocString } from '../react-common/locReactSide';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';
import { SshOptionsFields } from './SshOptionsFields';
import { CaCertificateFields } from './CaCertificateFields';
import { getDefaultIntegrationName } from './integrationUtils';

export interface IClickHouseFormProps {
    integrationId: string;
    existingConfig: Extract<DatabaseIntegrationConfig, { type: 'clickhouse' }> | null;
    defaultName?: string;
    onSave: (config: Extract<DatabaseIntegrationConfig, { type: 'clickhouse' }>) => void;
    onCancel: () => void;
}

function createEmptyClickHouseConfig(params: {
    id: string;
    name?: string;
}): Extract<DatabaseIntegrationConfig, { type: 'clickhouse' }> {
    return {
        id: params.id,
        name: (params.name || getDefaultIntegrationName('clickhouse')).trim(),
        type: 'clickhouse',
        metadata: {
            host: '',
            user: '',
            database: ''
        }
    };
}

export const ClickHouseForm: React.FC<IClickHouseFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    onSave,
    onCancel
}) => {
    const [pendingConfig, setPendingConfig] = React.useState<
        Extract<DatabaseIntegrationConfig, { type: 'clickhouse' }>
    >(
        existingConfig
            ? structuredClone(existingConfig)
            : createEmptyClickHouseConfig({ id: integrationId, name: defaultName })
    );

    React.useEffect(() => {
        setPendingConfig(
            existingConfig
                ? structuredClone(existingConfig)
                : createEmptyClickHouseConfig({ id: integrationId, name: defaultName })
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
            metadata: { ...pendingConfig.metadata, password: value || undefined }
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
                <label htmlFor="name">{getLocString('integrationsClickHouseNameLabel', 'Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={pendingConfig.name}
                    onChange={handleNameChange}
                    placeholder={getLocString('integrationsClickHouseNamePlaceholder', 'My ClickHouse Database')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="host">
                    {getLocString('integrationsClickHouseHostLabel', 'Host')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="host"
                    value={pendingConfig.metadata.host}
                    onChange={handleHostChange}
                    placeholder={getLocString('integrationsClickHouseHostPlaceholder', 'localhost')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="port">{getLocString('integrationsClickHousePortLabel', 'Port')}</label>
                <input
                    type="text"
                    id="port"
                    value={pendingConfig.metadata.port || ''}
                    onChange={handlePortChange}
                    placeholder="8123"
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="database">
                    {getLocString('integrationsClickHouseDatabaseLabel', 'Database')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="database"
                    value={pendingConfig.metadata.database}
                    onChange={handleDatabaseChange}
                    placeholder={getLocString('integrationsClickHouseDatabasePlaceholder', 'my_database')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="username">
                    {getLocString('integrationsClickHouseUsernameLabel', 'Username')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="username"
                    value={pendingConfig.metadata.user}
                    onChange={handleUsernameChange}
                    placeholder={getLocString('integrationsClickHouseUsernamePlaceholder', 'username')}
                    autoComplete="username"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="password">{getLocString('integrationsClickHousePasswordLabel', 'Password')}</label>
                <input
                    type="password"
                    id="password"
                    value={pendingConfig.metadata.password || ''}
                    onChange={handlePasswordChange}
                    placeholder={getLocString('integrationsClickHousePasswordPlaceholder', '••••••••')}
                    autoComplete="current-password"
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
