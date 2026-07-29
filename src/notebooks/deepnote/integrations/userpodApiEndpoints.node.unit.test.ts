import * as http from 'http';

import { assert } from 'chai';
import { anything, capture, instance, mock, verify, when } from 'ts-mockito';
import { Disposable, NotebookDocument, Uri } from 'vscode';

import { DEEPNOTE_NOTEBOOK_TYPE } from '../../../kernels/deepnote/types';
import { IDisposable } from '../../../platform/common/types';
import { dispose } from '../../../platform/common/utils/lifecycle';
import { ISqlIntegrationEnvVarsProvider } from '../../../platform/notebooks/deepnote/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { UserpodApiEndpoints } from './userpodApiEndpoints.node';

suite('UserpodApiEndpoints', () => {
    let endpoint: UserpodApiEndpoints;
    let provider: ISqlIntegrationEnvVarsProvider;
    let disposables: IDisposable[];

    setup(() => {
        resetVSCodeMocks();
        disposables = [new Disposable(() => resetVSCodeMocks())];
        provider = mock<ISqlIntegrationEnvVarsProvider>();

        endpoint = new UserpodApiEndpoints(instance(provider), disposables);
    });

    teardown(() => {
        // Disposing tears down the HTTP server (a dispose handler is pushed into `disposables` at start).
        disposables = dispose(disposables);
    });

    function createMockNotebook(
        projectId: string | undefined,
        uri: Uri,
        notebookType: string = DEEPNOTE_NOTEBOOK_TYPE
    ): NotebookDocument {
        const notebook = mock<NotebookDocument>();
        when(notebook.notebookType).thenReturn(notebookType);
        when(notebook.metadata).thenReturn(projectId === undefined ? {} : { deepnoteProjectId: projectId });
        when(notebook.uri).thenReturn(uri);

        return instance(notebook);
    }

    /** `activate()` is fire-and-forget; poll `baseUrl` until the server has bound a port. */
    async function waitForBaseUrl(timeoutMs = 3000): Promise<string> {
        const start = Date.now();
        while (endpoint.baseUrl === undefined) {
            if (Date.now() - start > timeoutMs) {
                throw new Error('UserpodApiEndpoints did not start listening in time');
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        return endpoint.baseUrl;
    }

    function envVarsUrl(baseUrl: string, projectId: string): string {
        return `${baseUrl}/userpod-api/${projectId}/integrations/environment-variables`;
    }

    /** GET the endpoint carrying the per-project bearer token it requires. */
    function authedFetch(url: string, projectId: string): Promise<Response> {
        return fetch(url, { headers: { Authorization: `Bearer ${endpoint.getAuthToken(projectId)}` } });
    }

    test('returns the provider env map as [{name,value}] for a matching open deepnote notebook', async () => {
        const notebook = createMockNotebook('project-1', Uri.file('/ws/app.deepnote'));
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(provider.getEnvironmentVariables(anything())).thenResolve({ FOO: 'bar', BAZ: 'qux' });

        endpoint.activate();
        const baseUrl = await waitForBaseUrl();

        const response = await authedFetch(envVarsUrl(baseUrl, 'project-1'), 'project-1');

        assert.strictEqual(response.status, 200);
        const body = await response.json();
        assert.deepStrictEqual(body, [
            { name: 'FOO', value: 'bar' },
            { name: 'BAZ', value: 'qux' }
        ]);
    });

    test('returns an empty array when the matching notebook has no integration env vars', async () => {
        const notebook = createMockNotebook('project-1', Uri.file('/ws/app.deepnote'));
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(provider.getEnvironmentVariables(anything())).thenResolve({});

        endpoint.activate();
        const baseUrl = await waitForBaseUrl();

        const response = await authedFetch(envVarsUrl(baseUrl, 'project-1'), 'project-1');

        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(await response.json(), []);
    });

    test('routes by projectId: queries only the notebook whose metadata matches the URL param', async () => {
        const uriTwo = Uri.file('/ws/two.deepnote');
        const notebookOne = createMockNotebook('project-one', Uri.file('/ws/one.deepnote'));
        const notebookTwo = createMockNotebook('project-two', uriTwo);
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookOne, notebookTwo]);
        when(provider.getEnvironmentVariables(anything())).thenResolve({ FROM: 'two' });

        endpoint.activate();
        const baseUrl = await waitForBaseUrl();

        const response = await authedFetch(envVarsUrl(baseUrl, 'project-two'), 'project-two');
        const body = await response.json();

        assert.deepStrictEqual(body, [{ name: 'FROM', value: 'two' }]);
        // The endpoint must resolve env vars for the matching notebook's uri, not the other project's.
        verify(provider.getEnvironmentVariables(anything())).once();
        const [uriArg] = capture(provider.getEnvironmentVariables).last();
        assert.strictEqual((uriArg as Uri).toString(), uriTwo.toString());
    });

    test('returns an empty array and never queries the provider when no notebook matches the projectId', async () => {
        const notebook = createMockNotebook('some-other-project', Uri.file('/ws/app.deepnote'));
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        endpoint.activate();
        const baseUrl = await waitForBaseUrl();

        const response = await authedFetch(envVarsUrl(baseUrl, 'project-1'), 'project-1');

        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(await response.json(), []);
        verify(provider.getEnvironmentVariables(anything())).never();
    });

    test('ignores non-Deepnote notebooks even when their projectId matches', async () => {
        const notebook = createMockNotebook('project-1', Uri.file('/ws/app.ipynb'), 'jupyter-notebook');
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        endpoint.activate();
        const baseUrl = await waitForBaseUrl();

        const response = await authedFetch(envVarsUrl(baseUrl, 'project-1'), 'project-1');

        assert.deepStrictEqual(await response.json(), []);
        verify(provider.getEnvironmentVariables(anything())).never();
    });

    test('responds 500 when the provider rejects', async () => {
        const notebook = createMockNotebook('project-1', Uri.file('/ws/app.deepnote'));
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(provider.getEnvironmentVariables(anything())).thenReject(new Error('resolution failed'));

        endpoint.activate();
        const baseUrl = await waitForBaseUrl();

        const response = await authedFetch(envVarsUrl(baseUrl, 'project-1'), 'project-1');

        assert.strictEqual(response.status, 500);
    });

    test('responds 401 and never queries the provider when the bearer token is missing or wrong', async () => {
        const notebook = createMockNotebook('project-1', Uri.file('/ws/app.deepnote'));
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        endpoint.activate();
        const baseUrl = await waitForBaseUrl();

        const noHeader = await fetch(envVarsUrl(baseUrl, 'project-1'));
        assert.strictEqual(noHeader.status, 401);

        const wrongToken = await fetch(envVarsUrl(baseUrl, 'project-1'), {
            headers: { Authorization: 'Bearer wrong-token' }
        });
        assert.strictEqual(wrongToken.status, 401);

        verify(provider.getEnvironmentVariables(anything())).never();
    });

    test('responds 401 for a wrong token of the SAME length (exercises the constant-time compare path)', async () => {
        const notebook = createMockNotebook('project-1', Uri.file('/ws/app.deepnote'));
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        endpoint.activate();
        const baseUrl = await waitForBaseUrl();

        // Issue the project's token, then present a DIFFERENT value of the same byte length — timingSafeEqual must reject it.
        const realToken = endpoint.getAuthToken('project-1');
        const sameLengthWrong = `Bearer ${'x'.repeat(realToken.length)}`;
        const response = await fetch(envVarsUrl(baseUrl, 'project-1'), {
            headers: { Authorization: sameLengthWrong }
        });

        assert.strictEqual(response.status, 401);
        verify(provider.getEnvironmentVariables(anything())).never();
    });

    test('cross-project: a token issued for one project cannot read another project', async () => {
        const notebookA = createMockNotebook('project-a', Uri.file('/ws/a.deepnote'));
        const notebookB = createMockNotebook('project-b', Uri.file('/ws/b.deepnote'));
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookA, notebookB]);

        endpoint.activate();
        const baseUrl = await waitForBaseUrl();

        // Issue tokens for both projects, then use project A's token against project B's URL.
        const tokenA = endpoint.getAuthToken('project-a');
        endpoint.getAuthToken('project-b');

        const response = await fetch(envVarsUrl(baseUrl, 'project-b'), {
            headers: { Authorization: `Bearer ${tokenA}` }
        });

        assert.strictEqual(response.status, 401, "project A's token must not authorize a read of project B");
        verify(provider.getEnvironmentVariables(anything())).never();
    });

    test('ready resolves once the server is listening', async () => {
        endpoint.activate();

        await endpoint.ready;

        assert.isString(endpoint.baseUrl, 'baseUrl must be set once ready resolves');
    });

    test('prompts the user to recover when the initial bind fails, and never advertises a base URL', async () => {
        when(mockedVSCodeNamespaces.window.showErrorMessage(anything(), anything())).thenResolve(undefined as never);

        endpoint.activate();

        // `start()` assigns the server synchronously before its first await, so the bind failure can be
        // simulated here — while `isListening` is still false, i.e. the initial-bind path.
        const server = (endpoint as unknown as { server: http.Server }).server;
        server.emit('error', new Error('EADDRINUSE'));

        await endpoint.ready;

        assert.strictEqual(endpoint.baseUrl, undefined, 'a failed bind must not advertise a base URL');
        verify(mockedVSCodeNamespaces.window.showErrorMessage(anything(), anything())).once();
    });

    test('logs and prompts the user to recover when the server errors after startup, without crashing', async () => {
        const notebook = createMockNotebook('project-1', Uri.file('/ws/app.deepnote'));
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(mockedVSCodeNamespaces.window.showErrorMessage(anything(), anything())).thenResolve(undefined as never);

        endpoint.activate();
        await waitForBaseUrl();

        // Reach the running server to simulate a post-listen failure (e.g. an accept error under fd exhaustion).
        const server = (endpoint as unknown as { server: http.Server }).server;
        server.emit('error', new Error('accept failed'));

        assert.strictEqual(endpoint.baseUrl, undefined, 'a crashed endpoint must stop advertising its base URL');
        verify(mockedVSCodeNamespaces.window.showErrorMessage(anything(), anything())).once();
    });
});
