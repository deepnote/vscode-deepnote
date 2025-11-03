import * as React from 'react';
import { getLocString } from '../react-common/locReactSide';
import { DatabaseIntegrationConfig, SnowflakeAuthMethods } from '@deepnote/database-integrations';
import { getDefaultIntegrationName } from './integrationUtils';

type SnowflakeConfig = Extract<DatabaseIntegrationConfig, { type: 'snowflake' }>;
type SnowflakeAuthMethod = SnowflakeConfig['metadata']['authMethod'];

const SUPPORTED_AUTH_METHODS = [SnowflakeAuthMethods.Password, SnowflakeAuthMethods.ServiceAccountKeyPair] as const;

function isSupportedSnowflakeAuthMethod(authMethod: SnowflakeAuthMethod): boolean {
    return (SUPPORTED_AUTH_METHODS as readonly SnowflakeAuthMethod[]).includes(authMethod);
}

function createEmptySnowflakeConfig(params: { id: string; name?: string }): SnowflakeConfig {
    return {
        id: params.id,
        name: (params.name || getDefaultIntegrationName('snowflake')).trim(),
        type: 'snowflake',
        metadata: {
            authMethod: SnowflakeAuthMethods.Password,
            accountName: '',
            username: '',
            password: ''
        }
    };
}

export interface ISnowflakeFormProps {
    integrationId: string;
    existingConfig: SnowflakeConfig | null;
    defaultName?: string;
    onSave: (config: SnowflakeConfig) => void;
    onCancel: () => void;
}

export const SnowflakeForm: React.FC<ISnowflakeFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    onSave,
    onCancel
}) => {
    const [pendingConfig, setPendingConfig] = React.useState<SnowflakeConfig>(
        existingConfig && isSupportedSnowflakeAuthMethod(existingConfig.metadata.authMethod)
            ? structuredClone(existingConfig)
            : createEmptySnowflakeConfig({ id: integrationId, name: defaultName })
    );

    React.useEffect(() => {
        setPendingConfig(
            existingConfig && isSupportedSnowflakeAuthMethod(existingConfig.metadata.authMethod)
                ? structuredClone(existingConfig)
                : createEmptySnowflakeConfig({ id: integrationId, name: defaultName })
        );
    }, [existingConfig, integrationId, defaultName]);

    // Extract values for form fields with proper type narrowing
    const usernameValue =
        pendingConfig.metadata.authMethod === SnowflakeAuthMethods.Password ||
        pendingConfig.metadata.authMethod === SnowflakeAuthMethods.ServiceAccountKeyPair
            ? pendingConfig.metadata.username
            : '';

    const passwordValue =
        pendingConfig.metadata.authMethod === SnowflakeAuthMethods.Password ? pendingConfig.metadata.password : '';

    const privateKeyValue =
        pendingConfig.metadata.authMethod === SnowflakeAuthMethods.ServiceAccountKeyPair
            ? pendingConfig.metadata.privateKey
            : '';

    const privateKeyPassphraseValue =
        pendingConfig.metadata.authMethod === SnowflakeAuthMethods.ServiceAccountKeyPair
            ? pendingConfig.metadata.privateKeyPassphrase || ''
            : '';

    const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({
            ...prev,
            name: value
        }));
    };

    const handleAccountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({
            ...prev,
            metadata: {
                ...prev.metadata,
                accountName: value
            }
        }));
    };

    const handleAuthMethodChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const value = e.target.value;
        const newAuthMethod = value as SnowflakeAuthMethod;

        setPendingConfig((prev) => {
            if (newAuthMethod === SnowflakeAuthMethods.Password) {
                return {
                    ...prev,
                    metadata: {
                        authMethod: SnowflakeAuthMethods.Password,
                        accountName: prev.metadata.accountName,
                        username: '',
                        password: '',
                        warehouse: prev.metadata.warehouse,
                        database: prev.metadata.database,
                        role: prev.metadata.role
                    }
                };
            } else {
                return {
                    ...prev,
                    metadata: {
                        authMethod: SnowflakeAuthMethods.ServiceAccountKeyPair,
                        accountName: prev.metadata.accountName,
                        username: '',
                        privateKey: '',
                        warehouse: prev.metadata.warehouse,
                        database: prev.metadata.database,
                        role: prev.metadata.role
                    }
                };
            }
        });
    };

    const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => {
            if (
                prev.metadata.authMethod === SnowflakeAuthMethods.Password ||
                prev.metadata.authMethod === SnowflakeAuthMethods.ServiceAccountKeyPair
            ) {
                return {
                    ...prev,
                    metadata: {
                        ...prev.metadata,
                        username: value
                    }
                };
            }
            return prev;
        });
    };

    const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => {
            if (prev.metadata.authMethod === SnowflakeAuthMethods.Password) {
                return {
                    ...prev,
                    metadata: {
                        ...prev.metadata,
                        password: value
                    }
                };
            }
            return prev;
        });
    };

    const handlePrivateKeyChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => {
            if (prev.metadata.authMethod === SnowflakeAuthMethods.ServiceAccountKeyPair) {
                return {
                    ...prev,
                    metadata: {
                        ...prev.metadata,
                        privateKey: value
                    }
                };
            }
            return prev;
        });
    };

    const handlePrivateKeyPassphraseChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => {
            if (prev.metadata.authMethod === SnowflakeAuthMethods.ServiceAccountKeyPair) {
                return {
                    ...prev,
                    metadata: {
                        ...prev.metadata,
                        privateKeyPassphrase: value
                    }
                };
            }
            return prev;
        });
    };

    const handleDatabaseChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({
            ...prev,
            metadata: {
                ...prev.metadata,
                database: value || undefined
            }
        }));
    };

    const handleWarehouseChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({
            ...prev,
            metadata: {
                ...prev.metadata,
                warehouse: value || undefined
            }
        }));
    };

    const handleRoleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPendingConfig((prev) => ({
            ...prev,
            metadata: {
                ...prev.metadata,
                role: value || undefined
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
                <label htmlFor="name">{getLocString('integrationsSnowflakeNameLabel', 'Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={pendingConfig.name}
                    onChange={handleNameChange}
                    placeholder={getLocString('integrationsSnowflakeNamePlaceholder', 'My Snowflake Database')}
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
                    value={pendingConfig.metadata.accountName}
                    onChange={handleAccountChange}
                    placeholder={getLocString('integrationsSnowflakeAccountPlaceholder', 'abcd.us-east-1')}
                    autoComplete="off"
                    required
                    pattern=".*\S.*"
                />
            </div>

            <div className="form-group">
                <label htmlFor="authMethod">
                    {getLocString('integrationsSnowflakeAuthMethodLabel', 'Authentication')}
                </label>
                <select id="authMethod" value={pendingConfig.metadata.authMethod} onChange={handleAuthMethodChange}>
                    <option value={SnowflakeAuthMethods.Password}>
                        {getLocString('integrationsSnowflakeAuthMethodUsernamePassword', 'Username & password')}
                    </option>
                    <option value={SnowflakeAuthMethods.ServiceAccountKeyPair}>
                        {getLocString('integrationsSnowflakeAuthMethodKeyPair', 'Key-pair (service account)')}
                    </option>
                </select>
            </div>

            {pendingConfig.metadata.authMethod === SnowflakeAuthMethods.Password ? (
                <>
                    <div className="form-group">
                        <label htmlFor="username">
                            {getLocString('integrationsSnowflakeUsernameLabel', 'Username')}{' '}
                            <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                        </label>
                        <input
                            type="text"
                            id="username"
                            value={usernameValue}
                            onChange={handleUsernameChange}
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
                            value={passwordValue}
                            onChange={handlePasswordChange}
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
                            value={usernameValue}
                            onChange={handleUsernameChange}
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
                            value={privateKeyValue}
                            onChange={handlePrivateKeyChange}
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
                            value={privateKeyPassphraseValue}
                            onChange={handlePrivateKeyPassphraseChange}
                            autoComplete="off"
                            aria-describedby="privateKeyPassphrase-help"
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
                    value={pendingConfig.metadata.database || ''}
                    onChange={handleDatabaseChange}
                    placeholder={getLocString('integrationsSnowflakeDatabasePlaceholder', '')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="role">{getLocString('integrationsSnowflakeRoleLabel', 'Role (optional)')}</label>
                <input
                    type="text"
                    id="role"
                    value={pendingConfig.metadata.role || ''}
                    onChange={handleRoleChange}
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
                    value={pendingConfig.metadata.warehouse || ''}
                    onChange={handleWarehouseChange}
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
