// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as assert from 'assert';
import { getErrorMessage, MAX_FILE_SIZE, ApiError } from './importClient.node';

suite('ImportClient', () => {
    suite('getErrorMessage', () => {
        test('should return rate limit error for 429 status', () => {
            const error: ApiError = {
                message: 'Too many requests',
                statusCode: 429
            };

            const result = getErrorMessage(error);

            assert.strictEqual(result, 'Too many requests. Please try again in a few minutes.');
        });

        test('should return server message for 400 status', () => {
            const error: ApiError = {
                message: 'Bad request',
                statusCode: 400
            };

            const result = getErrorMessage(error);

            assert.strictEqual(result, 'Bad request');
        });

        test('should return server message for 401 status', () => {
            const error: ApiError = {
                message: 'Unauthorized',
                statusCode: 401
            };

            const result = getErrorMessage(error);

            assert.strictEqual(result, 'Unauthorized');
        });

        test('should return server message for 403 status', () => {
            const error: ApiError = {
                message: 'Forbidden',
                statusCode: 403
            };

            const result = getErrorMessage(error);

            assert.strictEqual(result, 'Forbidden');
        });

        test('should return server message for 413 status', () => {
            const error: ApiError = {
                message: 'File too large',
                statusCode: 413
            };

            const result = getErrorMessage(error);

            assert.strictEqual(result, 'File too large');
        });

        test('should return server message for 500 status', () => {
            const error: ApiError = {
                message: 'Internal server error',
                statusCode: 500
            };

            const result = getErrorMessage(error);

            assert.strictEqual(result, 'Internal server error');
        });

        test('should return server message for 502 status', () => {
            const error: ApiError = {
                message: 'Bad gateway',
                statusCode: 502
            };

            const result = getErrorMessage(error);

            assert.strictEqual(result, 'Bad gateway');
        });

        test('should return server message for 503 status', () => {
            const error: ApiError = {
                message: 'Service unavailable',
                statusCode: 503
            };

            const result = getErrorMessage(error);

            assert.strictEqual(result, 'Service unavailable');
        });

        test('should return server message for 504 status', () => {
            const error: ApiError = {
                message: 'Gateway timeout',
                statusCode: 504
            };

            const result = getErrorMessage(error);

            assert.strictEqual(result, 'Gateway timeout');
        });

        test('should return default message when no message provided', () => {
            const error: ApiError = {
                message: '',
                statusCode: 400
            };

            const result = getErrorMessage(error);

            assert.strictEqual(result, 'An error occurred. Please try again.');
        });

        test('should return generic error for Error without fetch message', () => {
            const error = new Error('Something went wrong');

            const result = getErrorMessage(error);

            assert.strictEqual(result, 'Something went wrong');
        });

        test('should return connection error for Error with fetch message', () => {
            const error = new Error('fetch failed');

            const result = getErrorMessage(error);

            assert.strictEqual(result, 'Failed to connect. Check your connection and try again.');
        });

        test('should return connection error for Error with Network message', () => {
            const error = new Error('Network error occurred');

            const result = getErrorMessage(error);

            assert.strictEqual(result, 'Failed to connect. Check your connection and try again.');
        });

        test('should return unknown error for non-Error objects', () => {
            const error = 'string error';

            const result = getErrorMessage(error);

            assert.strictEqual(result, 'An unknown error occurred');
        });

        test('should return unknown error for null', () => {
            const error = null;

            const result = getErrorMessage(error);

            assert.strictEqual(result, 'An unknown error occurred');
        });
    });

    suite('MAX_FILE_SIZE', () => {
        test('should be 100MB', () => {
            assert.strictEqual(MAX_FILE_SIZE, 100 * 1024 * 1024);
        });
    });

    // Note: initImport and uploadFile tests would require mocking fetch
    // which is beyond the scope of a simple unit test suite.
    // These would typically be tested with integration tests or by mocking
    // the global fetch function.
});
