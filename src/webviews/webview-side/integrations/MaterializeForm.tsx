import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';
import { SshOptionsFields } from './SshOptionsFields';
import { CaCertificateFields } from './CaCertificateFields';

export interface IMaterializeFormProps {
    integrationId: string;
    existingConfig: Extract<DatabaseIntegrationConfig, { type: 'materialize' }> | null;
    defaultName?: string;
    onSave: (config: Extract<DatabaseIntegrationConfig, { type: 'materialize' }>) => void;
    onCancel: () => void;
}

function createEmptyMaterializeConfig(params: {
    id: string;
    name?: string;
}): Extract<DatabaseIntegrationConfig, { type: 'materialize' }> {
    const unnamedIntegration = getLocString('integrationsUnnamedIntegration', 'Unnamed Integration ({0})');

    return {
        id: params.id,
        name: (params.name || format(unnamedIntegration, params.id)).trim(),
        type: 'materialize',
        metadata: {
            host: '',
            port: '6875',
            user: '',
            password: '',
            database: '',
            cluster: ''
        }
    };
}

export const MaterializeForm: React.FC<IMaterializeFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    onSave,
    onCancel
}) => {
    const [pendingConfig, setPendingConfig] = React.useState<
        Extract<DatabaseIntegrationConfig, { type: 'materialize' }>
    >(
        existingConfig
            ? structuredClone(existingConfig)
            : createEmptyMaterializeConfig({ id: integrationId, name: defaultName })
    );

    React.useEffect(() => {
        setPendingConfig(
            existingConfig
                ? structuredClone(existingConfig)
                : createEmptyMaterializeConfig({ id: integrationId, name: defaultName })
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

    const handleClusterChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig({
            ...pendingConfig,
            metadata: { ...pendingConfig.metadata, cluster: value }
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
                <label htmlFor="name">{getLocString('integrationsMaterializeNameLabel', 'Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={pendingConfig.name}
                    onChange={handleNameChange}
                    placeholder={getLocString('integrationsMaterializeNamePlaceholder', 'My Materialize Database')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="host">
                    {getLocString('integrationsMaterializeHostLabel', 'Host')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="host"
                    value={pendingConfig.metadata.host}
                    onChange={handleHostChange}
                    placeholder={getLocString('integrationsMaterializeHostPlaceholder', 'localhost')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="port">{getLocString('integrationsMaterializePortLabel', 'Port')}</label>
                <input
                    type="text"
                    id="port"
                    value={pendingConfig.metadata.port || ''}
                    onChange={handlePortChange}
                    placeholder="6875"
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="database">
                    {getLocString('integrationsMaterializeDatabaseLabel', 'Database')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="database"
                    value={pendingConfig.metadata.database}
                    onChange={handleDatabaseChange}
                    placeholder={getLocString('integrationsMaterializeDatabasePlaceholder', 'my_database')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="cluster">
                    {getLocString('integrationsMaterializeClusterLabel', 'Cluster')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="cluster"
                    value={pendingConfig.metadata.cluster}
                    onChange={handleClusterChange}
                    placeholder={getLocString('integrationsMaterializeClusterPlaceholder', 'quickstart')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="username">
                    {getLocString('integrationsMaterializeUsernameLabel', 'Username')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="username"
                    value={pendingConfig.metadata.user}
                    onChange={handleUsernameChange}
                    placeholder={getLocString('integrationsMaterializeUsernamePlaceholder', 'username')}
                    autoComplete="username"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="password">
                    {getLocString('integrationsMaterializePasswordLabel', 'Password')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="password"
                    id="password"
                    value={pendingConfig.metadata.password}
                    onChange={handlePasswordChange}
                    placeholder={getLocString('integrationsMaterializePasswordPlaceholder', '••••••••')}
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
