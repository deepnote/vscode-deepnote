// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { BaseError } from './types';

/**
 * Error thrown when a Deepnote server handle cannot be resolved.
 *
 * Cause:
 * The requested Deepnote server handle was not found in the registered servers.
 * This typically happens when trying to resolve a server that hasn't been registered yet
 * or has been removed from the registry.
 *
 * Handled by:
 * The error should be logged and the user should be notified that the server connection
 * could not be established.
 */
export class DeepnoteServerNotFoundError extends BaseError {
    constructor(serverId: string) {
        super('deepnoteserver', `Deepnote server not found: ${serverId}`);
    }
}
