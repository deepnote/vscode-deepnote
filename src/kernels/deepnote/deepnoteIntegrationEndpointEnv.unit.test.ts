import { assert } from 'chai';
import { anything, verify } from 'ts-mockito';
import { Uri } from 'vscode';

import { serializeDeepnoteFile } from '@deepnote/blocks';

import { createDeepnoteFile, createDeepnoteProject } from '../../notebooks/deepnote/deepnoteTestHelpers';
import { IUserpodApiEndpoints } from '../../platform/notebooks/deepnote/types';
import { stubReadFile } from '../../test/mocks/vscodeFs';
import { resetVSCodeMocks } from '../../test/vscode-mock';
import { applyIntegrationEndpointEnv } from './deepnoteIntegrationEndpointEnv';

/**
 * The five integration env vars are only injected when the loopback endpoint is listening AND the
 * file resolves to a project id; every other path leaves `extraEnv` unchanged.
 */
suite('applyIntegrationEndpointEnv', () => {
    const projectFileUri = Uri.file('/workspace/project/notebook-a.deepnote');
    const baseUrl = 'http://127.0.0.1:5555';
    // A pre-seeded key stands in for env a caller may already hold; the helper must add to it, not replace it.
    const sqlEnvKey = 'SQL_DEEPNOTE_INTEGRATION_ABC';
    const sqlEnvValue = 'postgres://localhost:5432/db';

    setup(() => {
        resetVSCodeMocks();
    });

    function createEndpoint(endpointBaseUrl: string | undefined): IUserpodApiEndpoints {
        return {
            baseUrl: endpointBaseUrl,
            ready: Promise.resolve(),
            getAuthToken: () => 'endpoint-token'
        };
    }

    function serializeProjectFile(projectId: string): string {
        return serializeDeepnoteFile(createDeepnoteFile({ project: createDeepnoteProject({ id: projectId }) }));
    }

    test('injects all five integration env vars (preserving pre-existing keys) when the endpoint is listening and the file has a project id', async () => {
        const mockFs = stubReadFile(serializeProjectFile('the-project-id'));
        const extraEnv: Record<string, string> = { [sqlEnvKey]: sqlEnvValue };

        await applyIntegrationEndpointEnv({
            deepnoteFileUri: projectFileUri,
            endpoint: createEndpoint(baseUrl),
            extraEnv
        });

        assert.deepStrictEqual(extraEnv, {
            [sqlEnvKey]: sqlEnvValue,
            DEEPNOTE_RUNTIME__ENV_INTEGRATION_ENABLED: 'true',
            DEEPNOTE_RUNTIME__RUNNING_IN_DETACHED_MODE: 'true',
            DEEPNOTE_RUNTIME__WEBAPP_URL: baseUrl,
            DEEPNOTE_RUNTIME__PROJECT_SECRET: 'endpoint-token',
            DEEPNOTE_PROJECT_ID: 'the-project-id'
        });
        // The enabled path must resolve the project id from the file.
        verify(mockFs.readFile(anything())).once();
    });

    test('injects nothing and does NOT read the file when the endpoint has no baseUrl', async () => {
        const mockFs = stubReadFile(serializeProjectFile('the-project-id'));
        const extraEnv: Record<string, string> = { [sqlEnvKey]: sqlEnvValue };

        await applyIntegrationEndpointEnv({
            deepnoteFileUri: projectFileUri,
            endpoint: createEndpoint(undefined),
            extraEnv
        });

        assert.deepStrictEqual(extraEnv, { [sqlEnvKey]: sqlEnvValue });
        // A missing baseUrl short-circuits BEFORE resolving the project id — no file read.
        verify(mockFs.readFile(anything())).never();
    });

    test('injects nothing when the endpoint is listening but the file resolves to no project id', async () => {
        // A schema-valid `.deepnote` whose project.id is empty — `resolveProjectIdForFile` yields a falsy id.
        stubReadFile(serializeProjectFile(''));
        const extraEnv: Record<string, string> = { [sqlEnvKey]: sqlEnvValue };

        await applyIntegrationEndpointEnv({
            deepnoteFileUri: projectFileUri,
            endpoint: createEndpoint(baseUrl),
            extraEnv
        });

        assert.deepStrictEqual(extraEnv, { [sqlEnvKey]: sqlEnvValue });
    });
});
