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
        return new https.Agent({
            rejectUnauthorized: false
        });
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

    const agent = createHttpsAgent();
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            fileName,
            fileSize
        }),
        agent
    });

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
}

/**
 * Uploads a file to the presigned S3 URL using XMLHttpRequest for progress tracking
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
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();

        // Track upload progress
        if (onProgress) {
            xhr.upload.addEventListener('progress', (event) => {
                if (event.lengthComputable) {
                    const percentComplete = Math.round((event.loaded / event.total) * 100);
                    onProgress(percentComplete);
                }
            });
        }

        // Handle completion
        xhr.addEventListener('load', () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve();
            } else {
                logger.error(`Upload failed - Status: ${xhr.status}, Response: ${xhr.responseText}, URL: ${uploadUrl}`);
                const error: ApiError = {
                    message: xhr.responseText || 'Upload failed',
                    statusCode: xhr.status
                };
                reject(error);
            }
        });

        // Handle errors
        xhr.addEventListener('error', () => {
            logger.error(`Network error during upload to: ${uploadUrl}`);
            const error: ApiError = {
                message: 'Network error during upload',
                statusCode: 0
            };
            reject(error);
        });

        xhr.addEventListener('abort', () => {
            const error: ApiError = {
                message: 'Upload aborted',
                statusCode: 0
            };
            reject(error);
        });

        // Start upload
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');

        // Convert Buffer to Uint8Array then Blob for XMLHttpRequest
        const uint8Array = new Uint8Array(
            fileBuffer.buffer as ArrayBuffer,
            fileBuffer.byteOffset,
            fileBuffer.byteLength
        );
        const blob = new Blob([uint8Array], { type: 'application/octet-stream' });
        xhr.send(blob);
    });
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
