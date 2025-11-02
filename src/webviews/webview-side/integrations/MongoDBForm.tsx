import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';

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
