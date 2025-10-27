import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import { SnowflakeIntegrationConfig, SnowflakeAuthMethod } from './types';

export interface ISnowflakeFormProps {
    integrationId: string;
    existingConfig: SnowflakeIntegrationConfig | null;
    integrationName?: string;
    onSave: (config: SnowflakeIntegrationConfig) => void;
    onCancel: () => void;
}

export const SnowflakeForm: React.FC<ISnowflakeFormProps> = ({
    integrationId,
    existingConfig,
    integrationName,
    onSave,
    onCancel
}) => {
    const [name, setName] = React.useState(existingConfig?.name || integrationName || '');
    const [account, setAccount] = React.useState(existingConfig?.account || '');
    const [authMethod, setAuthMethod] = React.useState<SnowflakeAuthMethod>(
        existingConfig?.authMethod || 'username_password'
    );
    const [username, setUsername] = React.useState(existingConfig?.username || '');
    const [password, setPassword] = React.useState(existingConfig?.password || '');
    const [privateKey, setPrivateKey] = React.useState(existingConfig?.privateKey || '');
    const [privateKeyPassphrase, setPrivateKeyPassphrase] = React.useState(existingConfig?.privateKeyPassphrase || '');
    const [database, setDatabase] = React.useState(existingConfig?.database || '');
    const [warehouse, setWarehouse] = React.useState(existingConfig?.warehouse || '');
    const [role, setRole] = React.useState(existingConfig?.role || '');

    // Update form fields when existingConfig or integrationName changes
    React.useEffect(() => {
        if (existingConfig) {
            setName(existingConfig.name || '');
            setAccount(existingConfig.account || '');
            setAuthMethod(existingConfig.authMethod || 'username_password');
            setUsername(existingConfig.username || '');
            setPassword(existingConfig.password || '');
            setPrivateKey(existingConfig.privateKey || '');
            setPrivateKeyPassphrase(existingConfig.privateKeyPassphrase || '');
            setDatabase(existingConfig.database || '');
            setWarehouse(existingConfig.warehouse || '');
            setRole(existingConfig.role || '');
        } else {
            setName(integrationName || '');
            setAccount('');
            setAuthMethod('username_password');
            setUsername('');
            setPassword('');
            setPrivateKey('');
            setPrivateKeyPassphrase('');
            setDatabase('');
            setWarehouse('');
            setRole('');
        }
    }, [existingConfig, integrationName]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        const unnamedIntegration = format('Unnamed Snowflake Integration ({0})', integrationId);

        const config: SnowflakeIntegrationConfig = {
            id: integrationId,
            name: (name || unnamedIntegration).trim(),
            type: 'snowflake',
            account: account.trim(),
            authMethod,
            username: username.trim(),
            password: authMethod === 'username_password' ? password.trim() : undefined,
            privateKey: authMethod === 'key_pair' ? privateKey.trim() : undefined,
            privateKeyPassphrase: authMethod === 'key_pair' ? privateKeyPassphrase.trim() : undefined,
            database: database.trim() || undefined,
            warehouse: warehouse.trim() || undefined,
            role: role.trim() || undefined
        };

        onSave(config);
    };

    return (
        <form onSubmit={handleSubmit}>
            <div className="form-group">
                <label htmlFor="name">{getLocString('integrationsSnowflakeNameLabel', 'Integration name')}</label>
                <input
                    type="text"
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={getLocString('integrationsSnowflakeNamePlaceholder', '[Demo] Snowflake')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="account">
                    {getLocString('integrationsSnowflakeAccountLabel', 'Account name')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="account"
                    value={account}
                    onChange={(e) => setAccount(e.target.value)}
                    placeholder={getLocString('integrationsSnowflakeAccountPlaceholder', 'abcd.us-east-1')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="authMethod">
                    {getLocString('integrationsSnowflakeAuthMethodLabel', 'Authentication')}
                </label>
                <select
                    id="authMethod"
                    value={authMethod}
                    onChange={(e) => setAuthMethod(e.target.value as SnowflakeAuthMethod)}
                >
                    <option value="username_password">
                        {getLocString('integrationsSnowflakeAuthMethodUsernamePassword', 'Username & password')}
                    </option>
                    <option value="key_pair">
                        {getLocString('integrationsSnowflakeAuthMethodKeyPair', 'Key-pair (service account)')}
                    </option>
                </select>
            </div>

            {authMethod === 'username_password' ? (
                <>
                    <div className="form-group">
                        <label htmlFor="username">
                            {getLocString('integrationsSnowflakeUsernameLabel', 'Username')}{' '}
                            <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                        </label>
                        <input
                            type="text"
                            id="username"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            placeholder={getLocString('integrationsSnowflakeUsernamePlaceholder', '')}
                            autoComplete="username"
                            required
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="password">
                            {getLocString('integrationsSnowflakePasswordLabel', 'Password')}{' '}
                            <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                        </label>
                        <input
                            type="password"
                            id="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={getLocString('integrationsSnowflakePasswordPlaceholder', '•••••')}
                            autoComplete="current-password"
                            required
                        />
                    </div>
                </>
            ) : (
                <>
                    <div className="form-group">
                        <label htmlFor="username">
                            {getLocString(
                                'integrationsSnowflakeServiceAccountUsernameLabel',
                                'Service Account Username'
                            )}{' '}
                            <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                        </label>
                        <p className="form-help-text">
                            {getLocString(
                                'integrationsSnowflakeServiceAccountUsernameHelp',
                                'The username of the service account that will be used to connect to Snowflake'
                            )}
                        </p>
                        <input
                            type="text"
                            id="username"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            placeholder={getLocString('integrationsSnowflakeServiceAccountUsernamePlaceholder', '')}
                            autoComplete="username"
                            required
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="privateKey">
                            {getLocString('integrationsSnowflakePrivateKeyLabel', 'Private Key')}{' '}
                            <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                        </label>
                        <p className="form-help-text">
                            {getLocString(
                                'integrationsSnowflakePrivateKeyHelp',
                                'The private key in PEM format. Make sure to include the entire key, including BEGIN and END markers.'
                            )}
                        </p>
                        <textarea
                            id="privateKey"
                            value={privateKey}
                            onChange={(e) => setPrivateKey(e.target.value)}
                            placeholder={getLocString(
                                'integrationsSnowflakePrivateKeyPlaceholder',
                                "Begins with '-----BEGIN PRIVATE KEY-----'"
                            )}
                            rows={8}
                            autoComplete="off"
                            spellCheck={false}
                            autoCorrect="off"
                            autoCapitalize="off"
                            required
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="privateKeyPassphrase">
                            {getLocString(
                                'integrationsSnowflakePrivateKeyPassphraseLabel',
                                'Private Key Passphrase (optional)'
                            )}
                        </label>
                        <p className="form-help-text">
                            {getLocString(
                                'integrationsSnowflakePrivateKeyPassphraseHelp',
                                'If the private key is encrypted, provide the passphrase to decrypt it'
                            )}
                        </p>
                        <input
                            type="password"
                            id="privateKeyPassphrase"
                            value={privateKeyPassphrase}
                            onChange={(e) => setPrivateKeyPassphrase(e.target.value)}
                            placeholder={getLocString(
                                'integrationsSnowflakePrivateKeyPassphrasePlaceholder',
                                'Private key passphrase (optional)'
                            )}
                            autoComplete="off"
                        />
                    </div>
                </>
            )}

            <div className="form-group">
                <label htmlFor="database">
                    {getLocString('integrationsSnowflakeDatabaseLabel', 'Database (optional)')}
                </label>
                <input
                    type="text"
                    id="database"
                    value={database}
                    onChange={(e) => setDatabase(e.target.value)}
                    placeholder={getLocString('integrationsSnowflakeDatabasePlaceholder', '')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="role">{getLocString('integrationsSnowflakeRoleLabel', 'Role (optional)')}</label>
                <input
                    type="text"
                    id="role"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    placeholder={getLocString('integrationsSnowflakeRolePlaceholder', '')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="warehouse">
                    {getLocString('integrationsSnowflakeWarehouseLabel', 'Warehouse (optional)')}
                </label>
                <input
                    type="text"
                    id="warehouse"
                    value={warehouse}
                    onChange={(e) => setWarehouse(e.target.value)}
                    placeholder={getLocString('integrationsSnowflakeWarehousePlaceholder', '')}
                    autoComplete="off"
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
