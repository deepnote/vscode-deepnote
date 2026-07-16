import { assert } from 'chai';
import { anything, capture, instance, mock, verify, when } from 'ts-mockito';
import { Disposable, NotebookDocument, Uri } from 'vscode';

import { DEEPNOTE_NOTEBOOK_TYPE } from '../../../kernels/deepnote/types';
import { IDisposable } from '../../../platform/common/types';
import { dispose } from '../../../platform/common/utils/lifecycle';
import { ISqlIntegrationEnvVarsProvider } from '../../../platform/notebooks/deepnote/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { IntegrationsEnvVarsEndpoint } from './integrationsEnvVarsEndpoint.node';

suite('IntegrationsEnvVarsEndpoint', () => {
    let endpoint: IntegrationsEnvVarsEndpoint;
    let provider: ISqlIntegrationEnvVarsProvider;
    let disposables: IDisposable[];

    setup(() => {
        resetVSCodeMocks();
        disposables = [new Disposable(() => resetVSCodeMocks())];
        provider = mock<ISqlIntegrationEnvVarsProvider>();

        endpoint = new IntegrationsEnvVarsEndpoint(instance(provider), disposables);
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
                throw new Error('IntegrationsEnvVarsEndpoint did not start listening in time');
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        return endpoint.baseUrl;
    }

    function envVarsUrl(baseUrl: string, projectId: string): string {
        return `${baseUrl}/userpod-api/${projectId}/integrations/environment-variables`;
    }

    test('returns the provider env map as [{name,value}] for a matching open deepnote notebook', async () => {
        const notebook = createMockNotebook('project-1', Uri.file('/ws/app.deepnote'));
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(provider.getEnvironmentVariables(anything())).thenResolve({ FOO: 'bar', BAZ: 'qux' });

        endpoint.activate();
        const baseUrl = await waitForBaseUrl();

        const response = await fetch(envVarsUrl(baseUrl, 'project-1'));

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

        const response = await fetch(envVarsUrl(baseUrl, 'project-1'));

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

        const response = await fetch(envVarsUrl(baseUrl, 'project-two'));
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

        const response = await fetch(envVarsUrl(baseUrl, 'project-1'));

        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(await response.json(), []);
        verify(provider.getEnvironmentVariables(anything())).never();
    });

    test('ignores non-Deepnote notebooks even when their projectId matches', async () => {
        const notebook = createMockNotebook('project-1', Uri.file('/ws/app.ipynb'), 'jupyter-notebook');
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        endpoint.activate();
        const baseUrl = await waitForBaseUrl();

        const response = await fetch(envVarsUrl(baseUrl, 'project-1'));

        assert.deepStrictEqual(await response.json(), []);
        verify(provider.getEnvironmentVariables(anything())).never();
    });

    test('responds 500 with an empty array when the provider rejects', async () => {
        const notebook = createMockNotebook('project-1', Uri.file('/ws/app.deepnote'));
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(provider.getEnvironmentVariables(anything())).thenReject(new Error('resolution failed'));

        endpoint.activate();
        const baseUrl = await waitForBaseUrl();

        const response = await fetch(envVarsUrl(baseUrl, 'project-1'));

        assert.strictEqual(response.status, 500);
        assert.deepStrictEqual(await response.json(), []);
    });
});
