import * as React from 'react';
import { PostgresIntegrationConfig } from './types';
import { l10n } from 'vscode';

export interface IPostgresFormProps {
    integrationId: string;
    existingConfig: PostgresIntegrationConfig | null;
    onSave: (config: PostgresIntegrationConfig) => void;
    onCancel: () => void;
}

export const PostgresForm: React.FC<IPostgresFormProps> = ({ integrationId, existingConfig, onSave, onCancel }) => {
    const [name, setName] = React.useState(existingConfig?.name || '');
    const [host, setHost] = React.useState(existingConfig?.host || '');
    const [port, setPort] = React.useState(existingConfig?.port?.toString() || '5432');
    const [database, setDatabase] = React.useState(existingConfig?.database || '');
    const [username, setUsername] = React.useState(existingConfig?.username || '');
    const [password, setPassword] = React.useState(existingConfig?.password || '');
    const [ssl, setSsl] = React.useState(existingConfig?.ssl || false);

    // Update form fields when existingConfig changes
    React.useEffect(() => {
        if (existingConfig) {
            setName(existingConfig.name || '');
            setHost(existingConfig.host || '');
            setPort(existingConfig.port?.toString() || '5432');
            setDatabase(existingConfig.database || '');
            setUsername(existingConfig.username || '');
            setPassword(existingConfig.password || '');
            setSsl(existingConfig.ssl || false);
        }
    }, [existingConfig]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        const config: PostgresIntegrationConfig = {
            id: integrationId,
            name: name || integrationId,
            type: 'postgres',
            host,
            port: parseInt(port, 10),
            database,
            username,
            password,
            ssl
        };

        onSave(config);
    };

    return (
        <form onSubmit={handleSubmit}>
            <div className="form-group">
                <label htmlFor="name">{l10n.t('Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My PostgreSQL Database"
                />
            </div>

            <div className="form-group">
                <label htmlFor="host">
                    {l10n.t('Host')} <span className="required">*</span>
                </label>
                <input
                    type="text"
                    id="host"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="localhost"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="port">
                    {l10n.t('Port')} <span className="required">*</span>
                </label>
                <input
                    type="number"
                    id="port"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="5432"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="database">
                    {l10n.t('Database')} <span className="required">*</span>
                </label>
                <input
                    type="text"
                    id="database"
                    value={database}
                    onChange={(e) => setDatabase(e.target.value)}
                    placeholder="mydb"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="username">
                    {l10n.t('Username')} <span className="required">*</span>
                </label>
                <input
                    type="text"
                    id="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="postgres"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="password">
                    {l10n.t('Password')} <span className="required">*</span>
                </label>
                <input
                    type="password"
                    id="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                />
            </div>

            <div className="form-group checkbox-group">
                <label>
                    <input type="checkbox" checked={ssl} onChange={(e) => setSsl(e.target.checked)} />
                    {l10n.t('Use SSL')}
                </label>
            </div>

            <div className="form-actions">
                <button type="submit" className="primary">
                    {l10n.t('Save')}
                </button>
                <button type="button" className="secondary" onClick={onCancel}>
                    {l10n.t('Cancel')}
                </button>
            </div>
        </form>
    );
};
