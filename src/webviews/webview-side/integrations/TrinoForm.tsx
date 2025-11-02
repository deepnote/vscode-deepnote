import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';

export interface ITrinoFormProps {
    integrationId: string;
    existingConfig: Extract<DatabaseIntegrationConfig, { type: 'trino' }> | null;
    defaultName?: string;
    onSave: (config: Extract<DatabaseIntegrationConfig, { type: 'trino' }>) => void;
    onCancel: () => void;
}

function createEmptyTrinoConfig(
    integrationId: string,
    defaultName?: string
): Extract<DatabaseIntegrationConfig, { type: 'trino' }> {
    const unnamedIntegration = getLocString('integrationsUnnamedIntegration', 'Unnamed Integration ({0})');

    return {
        id: integrationId,
        name: (defaultName || format(unnamedIntegration, integrationId)).trim(),
        type: 'trino',
        metadata: {
            host: '',
            user: '',
            password: '',
            database: '',
            port: '8080'
        }
    };
}

export const TrinoForm: React.FC<ITrinoFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    onSave,
    onCancel
}) => {
    const [pendingConfig, setPendingConfig] = React.useState<Extract<DatabaseIntegrationConfig, { type: 'trino' }>>(
        () => existingConfig || createEmptyTrinoConfig(integrationId, defaultName)
    );

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
                <label htmlFor="name">{getLocString('integrationsTrinoNameLabel' as any, 'Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={pendingConfig.name}
                    onChange={handleNameChange}
                    placeholder={getLocString('integrationsTrinoNamePlaceholder' as any, 'My Trino Database')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="host">
                    {getLocString('integrationsTrinoHostLabel' as any, 'Host')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="host"
                    value={pendingConfig.metadata.host}
                    onChange={handleHostChange}
                    placeholder={getLocString('integrationsTrinoHostPlaceholder' as any, 'localhost')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="port">
                    {getLocString('integrationsTrinoPortLabel' as any, 'Port')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="port"
                    value={pendingConfig.metadata.port}
                    onChange={handlePortChange}
                    placeholder="8080"
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="database">
                    {getLocString('integrationsTrinoDatabaseLabel' as any, 'Database')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="database"
                    value={pendingConfig.metadata.database}
                    onChange={handleDatabaseChange}
                    placeholder={getLocString('integrationsTrinoDatabasePlaceholder' as any, 'my_database')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="username">
                    {getLocString('integrationsTrinoUsernameLabel' as any, 'Username')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="username"
                    value={pendingConfig.metadata.user}
                    onChange={handleUsernameChange}
                    placeholder={getLocString('integrationsTrinoUsernamePlaceholder' as any, 'username')}
                    autoComplete="username"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="password">
                    {getLocString('integrationsTrinoPasswordLabel' as any, 'Password')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="password"
                    id="password"
                    value={pendingConfig.metadata.password}
                    onChange={handlePasswordChange}
                    placeholder={getLocString('integrationsTrinoPasswordPlaceholder' as any, '••••••••')}
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
