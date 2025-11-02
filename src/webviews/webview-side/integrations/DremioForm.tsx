import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';

function createEmptyDremioConfig(params: {
    id: string;
    name?: string;
}): Extract<DatabaseIntegrationConfig, { type: 'dremio' }> {
    const unnamedIntegration = getLocString('integrationsUnnamedIntegration', 'Unnamed Integration ({0})');

    return {
        id: params.id,
        name: (params.name || format(unnamedIntegration, params.id)).trim(),
        type: 'dremio',
        metadata: {
            host: '',
            port: '9047',
            schema: '',
            token: ''
        }
    };
}

export interface IDremioFormProps {
    integrationId: string;
    existingConfig: Extract<DatabaseIntegrationConfig, { type: 'dremio' }> | null;
    defaultName?: string;
    onSave: (config: Extract<DatabaseIntegrationConfig, { type: 'dremio' }>) => void;
    onCancel: () => void;
}

export const DremioForm: React.FC<IDremioFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    onSave,
    onCancel
}) => {
    const [pendingConfig, setPendingConfig] = React.useState<Extract<DatabaseIntegrationConfig, { type: 'dremio' }>>(
        existingConfig
            ? structuredClone(existingConfig)
            : createEmptyDremioConfig({ id: integrationId, name: defaultName })
    );

    React.useEffect(() => {
        setPendingConfig(
            existingConfig
                ? structuredClone(existingConfig)
                : createEmptyDremioConfig({ id: integrationId, name: defaultName })
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

    const handleSchemaChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, schema: e.target.value } }));
    };

    const handleTokenChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, token: e.target.value } }));
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(pendingConfig);
    };

    return (
        <form onSubmit={handleSubmit}>
            <div className="form-group">
                <label htmlFor="name">{getLocString('integrationsDremioNameLabel', 'Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={pendingConfig.name}
                    onChange={handleNameChange}
                    placeholder={getLocString('integrationsDremioNamePlaceholder', 'My Dremio Instance')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="host">
                    {getLocString('integrationsDremioHostLabel', 'Host')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="host"
                    value={pendingConfig.metadata.host}
                    onChange={handleHostChange}
                    placeholder={getLocString('integrationsDremioHostPlaceholder', 'dremio.example.com')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="port">{getLocString('integrationsDremioPortLabel', 'Port')}</label>
                <input
                    type="text"
                    id="port"
                    value={pendingConfig.metadata.port}
                    onChange={handlePortChange}
                    placeholder="9047"
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="schema">
                    {getLocString('integrationsDremioSchemaLabel', 'Schema')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="schema"
                    value={pendingConfig.metadata.schema}
                    onChange={handleSchemaChange}
                    placeholder={getLocString('integrationsDremioSchemaPlaceholder', 'my_schema')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="token">
                    {getLocString('integrationsDremioTokenLabel', 'Personal Access Token')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="password"
                    id="token"
                    value={pendingConfig.metadata.token}
                    onChange={handleTokenChange}
                    placeholder={getLocString('integrationsDremioTokenPlaceholder', '••••••••')}
                    autoComplete="off"
                    required
                />
            </div>

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
