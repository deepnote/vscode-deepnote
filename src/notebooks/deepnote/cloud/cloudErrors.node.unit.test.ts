import { getWorkspace } from '@deepnote/cloud';
import { HttpError, startMockDeepnoteCloud } from '@deepnote/cloud-mock';
import { ApiError } from '@deepnote/cloud-sync';
import { assert } from 'chai';
import { anything, verify, when } from 'ts-mockito';
import { Uri } from 'vscode';

import { DeepnoteCloud } from '../../../platform/common/utils/localize';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { isRejectedTokenError, showCloudError } from './cloudErrors.node';

suite('cloudErrors', () => {
    setup(() => {
        resetVSCodeMocks();
        when(mockedVSCodeNamespaces.commands.executeCommand(anything(), anything())).thenResolve(undefined);
    });

    suite('isRejectedTokenError', () => {
        test('is true for an ApiError with status 401', () => {
            assert.isTrue(isRejectedTokenError(new ApiError(401, 'Unauthorized')));
        });

        // `@deepnote/cloud` throws the `ApiError` that `@deepnote/cloud-sync` exports only while both resolve the same
        // copy of `@deepnote/database-integrations`.
        test('is true for a 401 from the @deepnote/cloud HTTP client', async () => {
            const cloud = await startMockDeepnoteCloud({
                onRequest: () => {
                    throw new HttpError(401, 'Invalid token');
                }
            });
            try {
                const error = await getWorkspace(cloud.url, 'revoked-token').then(
                    () => undefined,
                    (e: unknown) => e
                );

                assert.isTrue(isRejectedTokenError(error));
            } finally {
                await cloud.stop();
            }
        });

        test('is false for an ApiError with another status, including 403', () => {
            assert.isFalse(isRejectedTokenError(new ApiError(403, 'Forbidden')));
            assert.isFalse(isRejectedTokenError(new ApiError(500, 'Boom')));
        });

        test('is false for errors that are not an ApiError', () => {
            assert.isFalse(isRejectedTokenError(new Error('offline')));
            assert.isFalse(isRejectedTokenError({ statusCode: 401 }));
            assert.isFalse(isRejectedTokenError('401'));
            assert.isFalse(isRejectedTokenError(undefined));
        });
    });

    suite('showCloudError', () => {
        test('offers Set API Token for a rejected token, and runs the command for the resource when chosen', async () => {
            const resource = Uri.file('/r');
            when(
                mockedVSCodeNamespaces.window.showErrorMessage(
                    DeepnoteCloud.apiTokenRejectedForRequest,
                    DeepnoteCloud.setApiToken
                )
            ).thenResolve(DeepnoteCloud.setApiToken as any);

            await showCloudError(
                'Sync failed',
                new ApiError(401, 'Authentication failed. Please check your API token.'),
                resource
            );

            verify(
                mockedVSCodeNamespaces.window.showErrorMessage(
                    DeepnoteCloud.apiTokenRejectedForRequest,
                    DeepnoteCloud.setApiToken
                )
            ).once();
            verify(mockedVSCodeNamespaces.commands.executeCommand('deepnote.setApiToken', resource)).once();
            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).never();
        });

        test('does not run the command when the rejected-token prompt is dismissed', async () => {
            await showCloudError('Sync failed', new ApiError(401, 'Unauthorized'), Uri.file('/r'));

            verify(mockedVSCodeNamespaces.commands.executeCommand(anything(), anything())).never();
            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).never();
        });

        test('shows the server message without a button for a 403', async () => {
            await showCloudError('Publish failed', new ApiError(403, 'Insufficient permissions to publish this app.'));

            verify(
                mockedVSCodeNamespaces.window.showErrorMessage(
                    'Publish failed: Insufficient permissions to publish this app.'
                )
            ).once();
            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything(), anything())).never();
        });

        test('shows the message of any other ApiError', async () => {
            await showCloudError('Sync failed', new ApiError(500, 'Boom'));

            verify(mockedVSCodeNamespaces.window.showErrorMessage('Sync failed: Boom')).once();
        });

        test('shows the message of a plain Error without a button', async () => {
            await showCloudError('Sync failed', new Error('offline'));

            verify(mockedVSCodeNamespaces.window.showErrorMessage('Sync failed: offline')).once();
            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything(), anything())).never();
        });

        test('stringifies a thrown value that is not an Error', async () => {
            await showCloudError('Sync failed', 'timed out');

            verify(mockedVSCodeNamespaces.window.showErrorMessage('Sync failed: timed out')).once();
        });
    });
});
