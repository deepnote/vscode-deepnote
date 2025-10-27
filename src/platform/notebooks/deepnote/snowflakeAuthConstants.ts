/**
 * Snowflake authentication methods
 */
export const SnowflakeAuthMethods = {
    PASSWORD: 'PASSWORD',
    OKTA: 'OKTA',
    NATIVE_SNOWFLAKE: 'NATIVE_SNOWFLAKE',
    AZURE_AD: 'AZURE_AD',
    KEY_PAIR: 'KEY_PAIR',
    SERVICE_ACCOUNT_KEY_PAIR: 'SERVICE_ACCOUNT_KEY_PAIR'
} as const;

export type SnowflakeAuthMethod = (typeof SnowflakeAuthMethods)[keyof typeof SnowflakeAuthMethods] | null;

/**
 * Supported auth methods that we can configure in VSCode
 */
export const SUPPORTED_SNOWFLAKE_AUTH_METHODS = [
    null, // Legacy username+password (no authMethod field)
    SnowflakeAuthMethods.PASSWORD,
    SnowflakeAuthMethods.SERVICE_ACCOUNT_KEY_PAIR
] as const;

