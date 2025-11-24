import * as React from 'react';
import { getLocString } from '../react-common/locReactSide';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';
import { SshOptionsFields } from './SshOptionsFields';
import { getDefaultIntegrationName } from './integrationUtils';

function createEmptyDatabricksConfig(params: {
    id: string;
    name?: string;
}): Extract<DatabaseIntegrationConfig, { type: 'databricks' }> {
    return {
        id: params.id,
        name: (params.name || getDefaultIntegrationName('databricks')).trim(),
        type: 'databricks',
        metadata: {
            host: '',
            port: '443',
            httpPath: '',
            token: '',
            schema: '',
            catalog: ''
        }
    };
}

export interface IDatabricksFormProps {
    integrationId: string;
    existingConfig: Extract<DatabaseIntegrationConfig, { type: 'databricks' }> | null;
    defaultName?: string;
    onSave: (config: Extract<DatabaseIntegrationConfig, { type: 'databricks' }>) => void;
    onCancel: () => void;
}

export const DatabricksForm: React.FC<IDatabricksFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    onSave,
    onCancel
}) => {
    const [pendingConfig, setPendingConfig] = React.useState<
        Extract<DatabaseIntegrationConfig, { type: 'databricks' }>
    >(
        existingConfig
            ? structuredClone(existingConfig)
            : createEmptyDatabricksConfig({ id: integrationId, name: defaultName })
    );

    React.useEffect(() => {
        setPendingConfig(
            existingConfig
                ? structuredClone(existingConfig)
                : createEmptyDatabricksConfig({ id: integrationId, name: defaultName })
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

    const handleHttpPathChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, httpPath: value } }));
    };

    const handleTokenChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, token: value } }));
    };

    const handleSchemaChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, schema: value } }));
    };

    const handleCatalogChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, catalog: value } }));
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

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(pendingConfig);
    };

    return (
        <form onSubmit={handleSubmit}>
            <div className="form-group">
                <label htmlFor="name">{getLocString('integrationsDatabricksNameLabel', 'Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={pendingConfig.name}
                    onChange={handleNameChange}
                    placeholder={getLocString('integrationsDatabricksNamePlaceholder', 'My Databricks Workspace')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="host">
                    {getLocString('integrationsDatabricksHostLabel', 'Server Hostname')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="host"
                    value={pendingConfig.metadata.host}
                    onChange={handleHostChange}
                    placeholder={getLocString(
                        'integrationsDatabricksHostPlaceholder',
                        'dbc-1234abcd-5678.cloud.databricks.com'
                    )}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="httpPath">
                    {getLocString('integrationsDatabricksHttpPathLabel', 'HTTP Path')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="httpPath"
                    value={pendingConfig.metadata.httpPath}
                    onChange={handleHttpPathChange}
                    placeholder={getLocString(
                        'integrationsDatabricksHttpPathPlaceholder',
                        '/sql/1.0/warehouses/abc123'
                    )}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="token">
                    {getLocString('integrationsDatabricksTokenLabel', 'Access Token')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="password"
                    id="token"
                    value={pendingConfig.metadata.token}
                    onChange={handleTokenChange}
                    placeholder={getLocString('integrationsDatabricksTokenPlaceholder', '••••••••')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="port">{getLocString('integrationsDatabricksPortLabel', 'Port')}</label>
                <input
                    type="text"
                    id="port"
                    value={pendingConfig.metadata.port}
                    onChange={handlePortChange}
                    placeholder="443"
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="catalog">
                    {getLocString('integrationsDatabricksCatalogLabel', 'Catalog (optional)')}
                </label>
                <input
                    type="text"
                    id="catalog"
                    value={pendingConfig.metadata.catalog || ''}
                    onChange={handleCatalogChange}
                    placeholder={getLocString('integrationsDatabricksCatalogPlaceholder', 'main')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="schema">{getLocString('integrationsDatabricksSchemaLabel', 'Schema (optional)')}</label>
                <input
                    type="text"
                    id="schema"
                    value={pendingConfig.metadata.schema || ''}
                    onChange={handleSchemaChange}
                    placeholder={getLocString('integrationsDatabricksSchemaPlaceholder', 'default')}
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
