import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';
import { SshOptionsFields } from './SshOptionsFields';
import { CaCertificateFields } from './CaCertificateFields';

function createEmptyPostgresConfig(params: {
    id: string;
    name?: string;
}): Extract<DatabaseIntegrationConfig, { type: 'pgsql' }> {
    const unnamedIntegration = getLocString('integrationsUnnamedIntegration', 'Unnamed Integration ({0})');

    return {
        id: params.id,
        name: (params.name || format(unnamedIntegration, params.id)).trim(),
        type: 'pgsql',
        metadata: {
            host: '',
            port: '5432',
            database: '',
            user: '',
            password: '',
            sslEnabled: false
        }
    };
}

export interface IPostgresFormProps {
    integrationId: string;
    existingConfig: Extract<DatabaseIntegrationConfig, { type: 'pgsql' }> | null;
    defaultName?: string;
    onSave: (config: Extract<DatabaseIntegrationConfig, { type: 'pgsql' }>) => void;
    onCancel: () => void;
}

export const PostgresForm: React.FC<IPostgresFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    onSave,
    onCancel
}) => {
    const [pendingConfig, setPendingConfig] = React.useState<Extract<DatabaseIntegrationConfig, { type: 'pgsql' }>>(
        existingConfig
            ? structuredClone(existingConfig)
            : createEmptyPostgresConfig({ id: integrationId, name: defaultName })
    );

    React.useEffect(() => {
        setPendingConfig(
            existingConfig
                ? structuredClone(existingConfig)
                : createEmptyPostgresConfig({ id: integrationId, name: defaultName })
        );
    }, [existingConfig, integrationId, defaultName]);

    const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({
            ...prev,
            name: value
        }));
    };

    const handleHostChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({
            ...prev,
            metadata: {
                ...prev.metadata,
                host: value
            }
        }));
    };

    const handlePortChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({
            ...prev,
            metadata: {
                ...prev.metadata,
                port: value
            }
        }));
    };

    const handleDatabaseChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({
            ...prev,
            metadata: {
                ...prev.metadata,
                database: value
            }
        }));
    };

    const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({
            ...prev,
            metadata: {
                ...prev.metadata,
                user: value
            }
        }));
    };

    const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({
            ...prev,
            metadata: {
                ...prev.metadata,
                password: value
            }
        }));
    };

    const handleSshEnabledChange = (enabled: boolean) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: {
                ...prev.metadata,
                sshEnabled: enabled || undefined
            }
        }));
    };

    const handleSshHostChange = (host: string) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: {
                ...prev.metadata,
                sshHost: host || undefined
            }
        }));
    };

    const handleSshPortChange = (port: string) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: {
                ...prev.metadata,
                sshPort: port || undefined
            }
        }));
    };

    const handleSshUserChange = (user: string) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: {
                ...prev.metadata,
                sshUser: user || undefined
            }
        }));
    };

    const handleSslEnabledChange = (enabled: boolean) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: {
                ...prev.metadata,
                sslEnabled: enabled || undefined
            }
        }));
    };

    const handleCaCertificateNameChange = (name: string) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: {
                ...prev.metadata,
                caCertificateName: name || undefined
            }
        }));
    };

    const handleCaCertificateTextChange = (text: string) => {
        setPendingConfig((prev) => ({
            ...prev,
            metadata: {
                ...prev.metadata,
                caCertificateText: text || undefined
            }
        }));
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(pendingConfig);
    };

    return (
        <form onSubmit={handleSubmit}>
            <div className="form-group">
                <label htmlFor="name">{getLocString('integrationsPostgresNameLabel', 'Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={pendingConfig.name}
                    onChange={handleNameChange}
                    placeholder={getLocString('integrationsPostgresNamePlaceholder', 'My PostgreSQL Database')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="host">
                    {getLocString('integrationsPostgresHostLabel', 'Host')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="host"
                    value={pendingConfig.metadata.host}
                    onChange={handleHostChange}
                    placeholder={getLocString('integrationsPostgresHostPlaceholder', 'localhost')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="port">
                    {getLocString('integrationsPostgresPortLabel', 'Port')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="number"
                    id="port"
                    value={pendingConfig.metadata.port}
                    onChange={handlePortChange}
                    placeholder={getLocString('integrationsPostgresPortPlaceholder', '5432')}
                    min={1}
                    max={65535}
                    step={1}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="database">
                    {getLocString('integrationsPostgresDatabaseLabel', 'Database')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="database"
                    value={pendingConfig.metadata.database}
                    onChange={handleDatabaseChange}
                    placeholder={getLocString('integrationsPostgresDatabasePlaceholder', 'mydb')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="username">
                    {getLocString('integrationsPostgresUsernameLabel', 'Username')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="username"
                    value={pendingConfig.metadata.user}
                    onChange={handleUsernameChange}
                    placeholder={getLocString('integrationsPostgresUsernamePlaceholder', 'postgres')}
                    autoComplete="username"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="password">
                    {getLocString('integrationsPostgresPasswordLabel', 'Password')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="password"
                    id="password"
                    value={pendingConfig.metadata.password}
                    onChange={handlePasswordChange}
                    placeholder={getLocString('integrationsPostgresPasswordPlaceholder', '••••••••')}
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
