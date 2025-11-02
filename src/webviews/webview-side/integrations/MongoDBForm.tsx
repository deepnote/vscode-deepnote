import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';
import { SshOptionsFields } from './SshOptionsFields';
import { CaCertificateFields } from './CaCertificateFields';

function createEmptyMongoDBConfig(params: {
    id: string;
    name?: string;
}): Extract<DatabaseIntegrationConfig, { type: 'mongodb' }> {
    const unnamedIntegration = getLocString('integrationsUnnamedIntegration', 'Unnamed Integration ({0})');

    return {
        id: params.id,
        name: (params.name || format(unnamedIntegration, params.id)).trim(),
        type: 'mongodb',
        metadata: {
            connection_string: ''
        }
    };
}

export interface IMongoDBFormProps {
    integrationId: string;
    existingConfig: Extract<DatabaseIntegrationConfig, { type: 'mongodb' }> | null;
    defaultName?: string;
    onSave: (config: Extract<DatabaseIntegrationConfig, { type: 'mongodb' }>) => void;
    onCancel: () => void;
}

export const MongoDBForm: React.FC<IMongoDBFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    onSave,
    onCancel
}) => {
    const [pendingConfig, setPendingConfig] = React.useState<Extract<DatabaseIntegrationConfig, { type: 'mongodb' }>>(
        existingConfig
            ? structuredClone(existingConfig)
            : createEmptyMongoDBConfig({ id: integrationId, name: defaultName })
    );

    React.useEffect(() => {
        setPendingConfig(
            existingConfig
                ? structuredClone(existingConfig)
                : createEmptyMongoDBConfig({ id: integrationId, name: defaultName })
        );
    }, [existingConfig, integrationId, defaultName]);

    const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({ ...prev, name: e.target.value }));
    };

    const handleConnectionStringChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, connection_string: e.target.value } }));
    };

    const handleRawConnectionStringChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: { ...prev.metadata, rawConnectionString: e.target.value || undefined }
        }));
    };

    const handlePrefixChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: { ...prev.metadata, prefix: e.target.value || undefined }
        }));
    };

    const handleHostChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: { ...prev.metadata, host: e.target.value || undefined }
        }));
    };

    const handlePortChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: { ...prev.metadata, port: e.target.value || undefined }
        }));
    };

    const handleUserChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: { ...prev.metadata, user: e.target.value || undefined }
        }));
    };

    const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: { ...prev.metadata, password: e.target.value || undefined }
        }));
    };

    const handleDatabaseChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: { ...prev.metadata, database: e.target.value || undefined }
        }));
    };

    const handleOptionsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: { ...prev.metadata, options: e.target.value || undefined }
        }));
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
                <label htmlFor="name">{getLocString('integrationsMongoDBNameLabel', 'Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={pendingConfig.name}
                    onChange={handleNameChange}
                    placeholder={getLocString('integrationsMongoDBNamePlaceholder', 'My MongoDB Database')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="connection_string">
                    {getLocString('integrationsMongoDBConnectionStringLabel', 'Connection String')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <textarea
                    id="connection_string"
                    value={pendingConfig.metadata.connection_string}
                    onChange={handleConnectionStringChange}
                    placeholder={getLocString(
                        'integrationsMongoDBConnectionStringPlaceholder',
                        'mongodb://username:password@host:port/database'
                    )}
                    rows={4}
                    required
                />
                <small className="form-help">
                    {getLocString(
                        'integrationsMongoDBConnectionStringHelp',
                        'Enter your MongoDB connection string. Example: mongodb://user:pass@host:27017/mydb or mongodb+srv://user:pass@cluster.mongodb.net/mydb'
                    )}
                </small>
            </div>

            <div className="form-section-note">
                {getLocString(
                    'integrationsMongoDBOptionalFieldsNote',
                    'The following fields are optional and redundant with the connection string. They create environment variables for use in your code.'
                )}
            </div>

            <div className="form-group">
                <label htmlFor="rawConnectionString">
                    {getLocString('integrationsMongoDBRawConnectionStringLabel', 'Raw Connection String (optional)')}
                </label>
                <input
                    type="text"
                    id="rawConnectionString"
                    value={pendingConfig.metadata.rawConnectionString || ''}
                    onChange={handleRawConnectionStringChange}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="prefix">{getLocString('integrationsMongoDBPrefixLabel', 'Prefix (optional)')}</label>
                <input
                    type="text"
                    id="prefix"
                    value={pendingConfig.metadata.prefix || ''}
                    onChange={handlePrefixChange}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="host">{getLocString('integrationsMongoDBHostLabel', 'Host (optional)')}</label>
                <input
                    type="text"
                    id="host"
                    value={pendingConfig.metadata.host || ''}
                    onChange={handleHostChange}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="port">{getLocString('integrationsMongoDBPortLabel', 'Port (optional)')}</label>
                <input
                    type="text"
                    id="port"
                    value={pendingConfig.metadata.port || ''}
                    onChange={handlePortChange}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="user">{getLocString('integrationsMongoDBUserLabel', 'User (optional)')}</label>
                <input
                    type="text"
                    id="user"
                    value={pendingConfig.metadata.user || ''}
                    onChange={handleUserChange}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="password">
                    {getLocString('integrationsMongoDBPasswordLabel', 'Password (optional)')}
                </label>
                <input
                    type="password"
                    id="password"
                    value={pendingConfig.metadata.password || ''}
                    onChange={handlePasswordChange}
                    autoComplete="current-password"
                />
            </div>

            <div className="form-group">
                <label htmlFor="database">
                    {getLocString('integrationsMongoDBDatabaseLabel', 'Database (optional)')}
                </label>
                <input
                    type="text"
                    id="database"
                    value={pendingConfig.metadata.database || ''}
                    onChange={handleDatabaseChange}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="options">{getLocString('integrationsMongoDBOptionsLabel', 'Options (optional)')}</label>
                <input
                    type="text"
                    id="options"
                    value={pendingConfig.metadata.options || ''}
                    onChange={handleOptionsChange}
                    autoComplete="off"
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
