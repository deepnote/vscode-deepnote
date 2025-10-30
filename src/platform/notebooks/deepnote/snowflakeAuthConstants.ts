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

export type SnowflakeAuthMethod = (typeof SnowflakeAuthMethods)[keyof typeof SnowflakeAuthMethods];

/**
 * Supported auth methods that we can configure in VSCode
 */
export const SUPPORTED_SNOWFLAKE_AUTH_METHODS = [
    null, // Legacy username+password (no authMethod field)
    SnowflakeAuthMethods.PASSWORD,
    SnowflakeAuthMethods.SERVICE_ACCOUNT_KEY_PAIR
] as const;

export type SupportedSnowflakeAuthMethod = (typeof SUPPORTED_SNOWFLAKE_AUTH_METHODS)[number];

/**
 * Type guard to check if a value is a supported Snowflake auth method
 * @param value The value to check
 * @returns true if the value is one of the supported auth methods
 */
export function isSupportedSnowflakeAuthMethod(value: unknown): value is SupportedSnowflakeAuthMethod {
    return (SUPPORTED_SNOWFLAKE_AUTH_METHODS as readonly unknown[]).includes(value);
}
