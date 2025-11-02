import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';

export interface IClickHouseFormProps {
    integrationId: string;
    existingConfig: Extract<DatabaseIntegrationConfig, { type: 'clickhouse' }> | null;
    defaultName?: string;
    onSave: (config: Extract<DatabaseIntegrationConfig, { type: 'clickhouse' }>) => void;
    onCancel: () => void;
}

function createEmptyClickHouseConfig(
    integrationId: string,
    defaultName?: string
): Extract<DatabaseIntegrationConfig, { type: 'clickhouse' }> {
    const unnamedIntegration = getLocString('integrationsUnnamedIntegration', 'Unnamed Integration ({0})');

    return {
        id: integrationId,
        name: (defaultName || format(unnamedIntegration, integrationId)).trim(),
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
    >(() => existingConfig || createEmptyClickHouseConfig(integrationId, defaultName));

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
            metadata: { ...pendingConfig.metadata, password: e.target.value || undefined }
        });
    };

    return (
        <form onSubmit={handleSubmit}>
            <div className="form-group">
                <label htmlFor="name">
                    {getLocString('integrationsClickHouseNameLabel' as any, 'Name (optional)')}
                </label>
                <input
                    type="text"
                    id="name"
                    value={pendingConfig.name}
                    onChange={handleNameChange}
                    placeholder={getLocString('integrationsClickHouseNamePlaceholder' as any, 'My ClickHouse Database')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="host">
                    {getLocString('integrationsClickHouseHostLabel' as any, 'Host')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="host"
                    value={pendingConfig.metadata.host}
                    onChange={handleHostChange}
                    placeholder={getLocString('integrationsClickHouseHostPlaceholder' as any, 'localhost')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="port">{getLocString('integrationsClickHousePortLabel' as any, 'Port')}</label>
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
                    {getLocString('integrationsClickHouseDatabaseLabel' as any, 'Database')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="database"
                    value={pendingConfig.metadata.database}
                    onChange={handleDatabaseChange}
                    placeholder={getLocString('integrationsClickHouseDatabasePlaceholder' as any, 'my_database')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="username">
                    {getLocString('integrationsClickHouseUsernameLabel' as any, 'Username')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="username"
                    value={pendingConfig.metadata.user}
                    onChange={handleUsernameChange}
                    placeholder={getLocString('integrationsClickHouseUsernamePlaceholder' as any, 'username')}
                    autoComplete="username"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="password">
                    {getLocString('integrationsClickHousePasswordLabel' as any, 'Password')}
                </label>
                <input
                    type="password"
                    id="password"
                    value={pendingConfig.metadata.password || ''}
                    onChange={handlePasswordChange}
                    placeholder={getLocString('integrationsClickHousePasswordPlaceholder' as any, '••••••••')}
                    autoComplete="current-password"
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
