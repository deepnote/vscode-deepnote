// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { workspace } from 'vscode';
import { logger } from '../../platform/logging';
import * as https from 'https';
import fetch from 'node-fetch';

/**
 * Response from the import initialization endpoint
 */
export interface InitImportResponse {
    importId: string;
    uploadUrl: string;
    expiresAt: string;
}

/**
 * Error response from the API
 */
export interface ApiError {
    message: string;
    statusCode: number;
}

/**
 * Maximum file size for uploads (100MB)
 */
export const MAX_FILE_SIZE = 100 * 1024 * 1024;

/**
 * Gets the API endpoint from configuration
 */
function getApiEndpoint(): string {
    const config = workspace.getConfiguration('deepnote');
    return config.get<string>('apiEndpoint', 'https://api.deepnote.com');
}

/**
 * Checks if SSL verification should be disabled
 */
function shouldDisableSSLVerification(): boolean {
    const config = workspace.getConfiguration('deepnote');
    return config.get<boolean>('disableSSLVerification', false);
}

/**
 * Creates an HTTPS agent with optional SSL verification disabled
 */
function createHttpsAgent(): https.Agent | undefined {
    if (shouldDisableSSLVerification()) {
        logger.warn('SSL certificate verification is disabled. This should only be used in development.');
        // Create agent with options that bypass both certificate and hostname verification
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const agentOptions: any = {
            rejectUnauthorized: false,
            checkServerIdentity: () => {
                // Return undefined to indicate the check passed
                return undefined;
            }
        };
        return new https.Agent(agentOptions);
    }
    return undefined;
}

/**
 * Initializes an import by requesting a presigned upload URL
 *
 * @param fileName - Name of the file to import
 * @param fileSize - Size of the file in bytes
 * @returns Promise with import ID, upload URL, and expiration time
 * @throws ApiError if the request fails
 */
export async function initImport(fileName: string, fileSize: number): Promise<InitImportResponse> {
    const apiEndpoint = getApiEndpoint();
    const url = `${apiEndpoint}/v1/import/init`;

    // Temporarily disable SSL verification at the process level if configured
    const originalEnvValue = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (shouldDisableSSLVerification()) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        logger.debug('Set NODE_TLS_REJECT_UNAUTHORIZED=0');
    }

    try {
        const agent = createHttpsAgent();
        logger.debug(`SSL verification disabled: ${shouldDisableSSLVerification()}`);
        logger.debug(`Agent created: ${!!agent}`);
        if (agent) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            logger.debug(`Agent rejectUnauthorized: ${(agent as any).options?.rejectUnauthorized}`);
        }

        interface FetchOptions {
            method: string;
            headers: Record<string, string>;
            body: string;
            agent?: https.Agent;
        }

        const options: FetchOptions = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                fileName,
                fileSize
            })
        };

        if (agent) {
            options.agent = agent;
            logger.debug('Agent attached to request');
            logger.debug(`Options agent set: ${!!options.agent}`);
        }

        const response = await fetch(url, options);

        if (!response.ok) {
            const responseBody = await response.text();
            logger.error(`Init import failed - Status: ${response.status}, URL: ${url}, Body: ${responseBody}`);

            const error: ApiError = {
                message: responseBody,
                statusCode: response.status
            };
            throw error;
        }

        return await response.json();
    } finally {
        // Restore original SSL verification setting
        if (shouldDisableSSLVerification()) {
            if (originalEnvValue === undefined) {
                delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
            } else {
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalEnvValue;
            }
        }
    }
}

/**
 * Uploads a file to the presigned S3 URL using node-fetch
 *
 * @param uploadUrl - Presigned S3 URL for uploading
 * @param fileBuffer - File contents as a Buffer
 * @param onProgress - Optional callback for upload progress (0-100)
 * @returns Promise that resolves when upload is complete
 * @throws ApiError if the upload fails
 */
export async function uploadFile(
    uploadUrl: string,
    fileBuffer: Buffer,
    onProgress?: (progress: number) => void
): Promise<void> {
    // Note: Progress tracking is limited in Node.js without additional libraries
    // For now, we'll report 50% at start and 100% at completion
    if (onProgress) {
        onProgress(50);
    }

    const response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': fileBuffer.length.toString()
        },
        body: fileBuffer
    });

    if (!response.ok) {
        const responseText = await response.text();
        logger.error(`Upload failed - Status: ${response.status}, Response: ${responseText}, URL: ${uploadUrl}`);
        const error: ApiError = {
            message: responseText || 'Upload failed',
            statusCode: response.status
        };
        throw error;
    }

    if (onProgress) {
        onProgress(100);
    }
}

/**
 * Gets a user-friendly error message for an API error
 * Logs the full error details for debugging
 *
 * @param error - The error object
 * @returns A user-friendly error message
 */
export function getErrorMessage(error: unknown): string {
    // Log the full error details for debugging
    logger.error('Import error details:', error);

    if (typeof error === 'object' && error !== null && 'statusCode' in error) {
        const apiError = error as ApiError;

        // Log API error specifics
        logger.error(`API Error - Status: ${apiError.statusCode}, Message: ${apiError.message}`);

        // Handle rate limiting specifically
        if (apiError.statusCode === 429) {
            return 'Too many requests. Please try again in a few minutes.';
        }

        // All other API errors return the message from the server
        if (apiError.statusCode >= 400) {
            return apiError.message || 'An error occurred. Please try again.';
        }
    }

    if (error instanceof Error) {
        logger.error(`Error message: ${error.message}`, error.stack);
        if (error.message.includes('fetch') || error.message.includes('Network')) {
            return 'Failed to connect. Check your connection and try again.';
        }
        return error.message;
    }

    logger.error('Unknown error type:', typeof error, error);
    return 'An unknown error occurred';
}
