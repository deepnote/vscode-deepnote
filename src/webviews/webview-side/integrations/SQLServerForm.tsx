import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';

export interface ISQLServerFormProps {
    integrationId: string;
    existingConfig: Extract<DatabaseIntegrationConfig, { type: 'sql-server' }> | null;
    defaultName?: string;
    onSave: (config: Extract<DatabaseIntegrationConfig, { type: 'sql-server' }>) => void;
    onCancel: () => void;
}

function createEmptySQLServerConfig(
    integrationId: string,
    defaultName?: string
): Extract<DatabaseIntegrationConfig, { type: 'sql-server' }> {
    const unnamedIntegration = getLocString('integrationsUnnamedIntegration', 'Unnamed Integration ({0})');

    return {
        id: integrationId,
        name: (defaultName || format(unnamedIntegration, integrationId)).trim(),
        type: 'sql-server',
        metadata: {
            host: '',
            user: '',
            password: '',
            database: '',
            port: '1433'
        }
    };
}

export const SQLServerForm: React.FC<ISQLServerFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    onSave,
    onCancel
}) => {
    const [pendingConfig, setPendingConfig] = React.useState<
        Extract<DatabaseIntegrationConfig, { type: 'sql-server' }>
    >(() => existingConfig || createEmptySQLServerConfig(integrationId, defaultName));

    React.useEffect(() => {
        if (existingConfig) {
            setPendingConfig(existingConfig);
        }
    }, [existingConfig]);

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
            metadata: { ...pendingConfig.metadata, port: e.target.value }
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

    return (
        <form onSubmit={handleSubmit}>
            <div className="form-group">
                <label htmlFor="name">{getLocString('integrationsSQLServerNameLabel' as any, 'Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={pendingConfig.name}
                    onChange={handleNameChange}
                    placeholder={getLocString('integrationsSQLServerNamePlaceholder' as any, 'My SQL Server Database')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="host">
                    {getLocString('integrationsSQLServerHostLabel' as any, 'Host')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="host"
                    value={pendingConfig.metadata.host}
                    onChange={handleHostChange}
                    placeholder={getLocString('integrationsSQLServerHostPlaceholder' as any, 'localhost')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="port">
                    {getLocString('integrationsSQLServerPortLabel' as any, 'Port')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="port"
                    value={pendingConfig.metadata.port}
                    onChange={handlePortChange}
                    placeholder="1433"
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="database">
                    {getLocString('integrationsSQLServerDatabaseLabel' as any, 'Database')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="database"
                    value={pendingConfig.metadata.database}
                    onChange={handleDatabaseChange}
                    placeholder={getLocString('integrationsSQLServerDatabasePlaceholder' as any, 'my_database')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="username">
                    {getLocString('integrationsSQLServerUsernameLabel' as any, 'Username')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="username"
                    value={pendingConfig.metadata.user}
                    onChange={handleUsernameChange}
                    placeholder={getLocString('integrationsSQLServerUsernamePlaceholder' as any, 'username')}
                    autoComplete="username"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="password">
                    {getLocString('integrationsSQLServerPasswordLabel' as any, 'Password')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="password"
                    id="password"
                    value={pendingConfig.metadata.password}
                    onChange={handlePasswordChange}
                    placeholder={getLocString('integrationsSQLServerPasswordPlaceholder' as any, '••••••••')}
                    autoComplete="current-password"
                    required
                />
            </div>

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
