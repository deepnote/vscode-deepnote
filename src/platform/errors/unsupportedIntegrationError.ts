// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { BaseError } from './types';

/**
 * Error thrown when an unsupported integration type is encountered.
 *
 * Cause:
 * An integration configuration has a type that is not supported by the SQL integration system,
 * or an integration uses an authentication method that is not supported in VSCode.
 *
 * Handled by:
 * Callers should handle this error and inform the user that the integration type or
 * authentication method is not supported.
 */
export class UnsupportedIntegrationError extends BaseError {
    constructor(message: string) {
        super('unknown', message);
    }
}
