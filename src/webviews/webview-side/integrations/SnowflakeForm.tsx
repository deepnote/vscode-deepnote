import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import {
    SnowflakeIntegrationConfig,
    SnowflakeAuthMethod,
    SnowflakeAuthMethods,
    isSupportedSnowflakeAuthMethod
} from './types';

export interface ISnowflakeFormProps {
    integrationId: string;
    existingConfig: SnowflakeIntegrationConfig | null;
    integrationName?: string;
    onSave: (config: SnowflakeIntegrationConfig) => void;
    onCancel: () => void;
}

// Helper to get initial values from existing config
function getInitialValues(existingConfig: SnowflakeIntegrationConfig | null) {
    if (!existingConfig) {
        return {
            username: '',
            password: '',
            privateKey: '',
            privateKeyPassphrase: ''
        };
    }

    // Type narrowing based on authMethod
    // Note: existingConfig can have authMethod === null (legacy configs from backend)
    if (existingConfig.authMethod === null || existingConfig.authMethod === SnowflakeAuthMethods.PASSWORD) {
        return {
            username: existingConfig.username || '',
            password: existingConfig.password || '',
            privateKey: '',
            privateKeyPassphrase: ''
        };
    } else if (existingConfig.authMethod === SnowflakeAuthMethods.SERVICE_ACCOUNT_KEY_PAIR) {
        return {
            username: existingConfig.username || '',
            password: '',
            privateKey: existingConfig.privateKey || '',
            privateKeyPassphrase: existingConfig.privateKeyPassphrase || ''
        };
    } else {
        // Unsupported auth method - try to extract username if available
        return {
            username: 'username' in existingConfig ? String(existingConfig.username || '') : '',
            password: '',
            privateKey: '',
            privateKeyPassphrase: ''
        };
    }
}

export const SnowflakeForm: React.FC<ISnowflakeFormProps> = ({
    integrationId,
    existingConfig,
    integrationName,
    onSave,
    onCancel
}) => {
    const isUnsupported = existingConfig ? !isSupportedSnowflakeAuthMethod(existingConfig.authMethod) : false;
    const initialValues = getInitialValues(existingConfig);

    const [name, setName] = React.useState(existingConfig?.name || integrationName || '');
    const [account, setAccount] = React.useState(existingConfig?.account || '');
    const [authMethod, setAuthMethod] = React.useState<SnowflakeAuthMethod>(
        existingConfig?.authMethod ?? SnowflakeAuthMethods.PASSWORD
    );
    const [username, setUsername] = React.useState(initialValues.username);
    const [password, setPassword] = React.useState(initialValues.password);
    const [privateKey, setPrivateKey] = React.useState(initialValues.privateKey);
    const [privateKeyPassphrase, setPrivateKeyPassphrase] = React.useState(initialValues.privateKeyPassphrase);
    const [database, setDatabase] = React.useState(existingConfig?.database || '');
    const [warehouse, setWarehouse] = React.useState(existingConfig?.warehouse || '');
    const [role, setRole] = React.useState(existingConfig?.role || '');

    // Update form fields when existingConfig or integrationName changes
    React.useEffect(() => {
        if (existingConfig) {
            const values = getInitialValues(existingConfig);
            setName(existingConfig.name || '');
            setAccount(existingConfig.account || '');
            setAuthMethod(existingConfig.authMethod ?? SnowflakeAuthMethods.PASSWORD);
            setUsername(values.username);
            setPassword(values.password);
            setPrivateKey(values.privateKey);
            setPrivateKeyPassphrase(values.privateKeyPassphrase);
            setDatabase(existingConfig.database || '');
            setWarehouse(existingConfig.warehouse || '');
            setRole(existingConfig.role || '');
        } else {
            setName(integrationName || '');
            setAccount('');
            setAuthMethod(SnowflakeAuthMethods.PASSWORD);
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

        const unnamedIntegration = getLocString('integrationsUnnamedIntegration', 'Unnamed Integration ({0})');

        let config: SnowflakeIntegrationConfig;

        if (authMethod === SnowflakeAuthMethods.PASSWORD) {
            config = {
                id: integrationId,
                name: (name || format(unnamedIntegration, integrationId)).trim(),
                type: 'snowflake',
                account: account.trim(),
                authMethod: authMethod,
                username: username.trim(),
                password: password.trim(),
                database: database.trim() || undefined,
                warehouse: warehouse.trim() || undefined,
                role: role.trim() || undefined
            };
        } else if (authMethod === SnowflakeAuthMethods.SERVICE_ACCOUNT_KEY_PAIR) {
            // Guard against empty private key
            if (!privateKey.trim()) {
                return;
            }

            config = {
                id: integrationId,
                name: (name || format(unnamedIntegration, integrationId)).trim(),
                type: 'snowflake',
                account: account.trim(),
                authMethod: authMethod,
                username: username.trim(),
                privateKey: privateKey.trim(),
                privateKeyPassphrase: privateKeyPassphrase.trim() || undefined,
                database: database.trim() || undefined,
                warehouse: warehouse.trim() || undefined,
                role: role.trim() || undefined
            };
        } else {
            // This shouldn't happen as we disable the form for unsupported methods
            return;
        }

        onSave(config);
    };

    return (
        <form onSubmit={handleSubmit}>
            {isUnsupported && (
                <div className="message message-error" style={{ marginBottom: '16px' }}>
                    {getLocString(
                        'integrationsSnowflakeUnsupportedAuthMethod',
                        'This Snowflake integration uses an authentication method that is not supported in VS Code. You can view the integration details but cannot edit or use it.'
                    )}
                </div>
            )}

            <div className="form-group">
                <label htmlFor="name">{getLocString('integrationsSnowflakeNameLabel', 'Integration name')}</label>
                <input
                    type="text"
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={getLocString('integrationsSnowflakeNamePlaceholder', '')}
                    autoComplete="off"
                    disabled={isUnsupported}
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
                    pattern=".*\S.*"
                    disabled={isUnsupported}
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
                    disabled={isUnsupported}
                >
                    <option value={SnowflakeAuthMethods.PASSWORD}>
                        {getLocString('integrationsSnowflakeAuthMethodUsernamePassword', 'Username & password')}
                    </option>
                    <option value={SnowflakeAuthMethods.SERVICE_ACCOUNT_KEY_PAIR}>
                        {getLocString('integrationsSnowflakeAuthMethodKeyPair', 'Key-pair (service account)')}
                    </option>
                </select>
            </div>

            {!isUnsupported &&
                (authMethod === SnowflakeAuthMethods.PASSWORD ? (
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
                                autoComplete="username"
                                required
                                pattern=".*\S.*"
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
                                placeholder={getLocString('integrationsSnowflakePasswordPlaceholder', '••••••••')}
                                autoComplete="current-password"
                                required
                                pattern=".*\S.*"
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
                            <p className="form-help-text" id="username-help">
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
                                autoComplete="username"
                                required
                                pattern=".*\S.*"
                                aria-describedby="username-help"
                            />
                        </div>

                        <div className="form-group">
                            <label htmlFor="privateKey">
                                {getLocString('integrationsSnowflakePrivateKeyLabel', 'Private Key')}{' '}
                                <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                            </label>
                            <p className="form-help-text" id="privateKey-help">
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
                                aria-describedby="privateKey-help"
                            />
                        </div>

                        <div className="form-group">
                            <label htmlFor="privateKeyPassphrase">
                                {getLocString(
                                    'integrationsSnowflakePrivateKeyPassphraseLabel',
                                    'Private Key Passphrase (optional)'
                                )}
                            </label>
                            <p className="form-help-text" id="privateKeyPassphrase-help">
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
                                autoComplete="off"
                                aria-describedby="privateKeyPassphrase-help"
                            />
                        </div>
                    </>
                ))}

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
                    disabled={isUnsupported}
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
                    disabled={isUnsupported}
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
                    disabled={isUnsupported}
                />
            </div>

            <div className="form-actions">
                <button type="submit" className="primary" disabled={isUnsupported}>
                    {getLocString('integrationsSave', 'Save')}
                </button>
                <button type="button" className="secondary" onClick={onCancel}>
                    {getLocString('integrationsCancel', 'Cancel')}
                </button>
            </div>
        </form>
    );
};
