import { assert } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as sinon from 'sinon';
import { anything, capture, deepEqual, instance, mock, verify, when } from 'ts-mockito';
import { Uri, ViewColumn, type WorkspaceConfiguration, type WorkspaceFolder } from 'vscode';

import { Commands } from '../../../platform/common/constants';
import { IDisposable, IExtensionContext } from '../../../platform/common/types';
import { dispose } from '../../../platform/common/utils/lifecycle';
import * as path from '../../../platform/vscode-path/path';
import { stubWorkspaceFsOnDisk } from '../../../test/mocks/vscodeFs';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { serializeProjectFile } from '../deepnoteTestHelpers';
import { AppPreviewCommandHandler } from './appPreviewCommandHandler.node';
import { AppPreviewSession } from './appPreviewSession.node';
import type { IAppPreviewRunner } from './types';

const HOSTED = 'https://deepnote.com/static/app-client/v1.js';
const SIMPLE_BROWSER_OPEN = 'simpleBrowser.api.open';
const INTEGRATED_BROWSER_OPEN = 'workbench.action.browser.open';
const BOTH_BROWSERS = [SIMPLE_BROWSER_OPEN, INTEGRATED_BROWSER_OPEN];

suite('AppPreviewCommandHandler', () => {
    let tmp: string;
    let appFolder: string;
    let disposables: IDisposable[];
    let previewApp: (arg?: unknown) => Promise<void>;
    let simpleBrowserConfig: WorkspaceConfiguration;

    const win = () => mockedVSCodeNamespaces.window;
    const commands = () => mockedVSCodeNamespaces.commands;
    const env = () => mockedVSCodeNamespaces.env;
    const executedCommands = () => capture<string, Uri, unknown>(commands().executeCommand);

    function serverUrl(): string {
        return capture(env().asExternalUri).last()[0].toString(true);
    }

    async function page(urlPath = '/'): Promise<string> {
        const response = await fetch(`${serverUrl()}${urlPath.slice(1)}`);

        return response.text();
    }

    async function requestToken(): Promise<{ token: string; projectId?: string }> {
        const url = serverUrl();
        const response = await fetch(`${url}__deepnote/api-token`, {
            method: 'POST',
            headers: { origin: new URL(url).origin }
        });
        assert.strictEqual(response.status, 200);

        return (await response.json()) as { token: string; projectId?: string };
    }

    setup(async () => {
        resetVSCodeMocks();
        stubWorkspaceFsOnDisk();
        tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deepnote-app-preview-handler-'));
        appFolder = path.join(tmp, 'project', 'app');
        await fs.promises.mkdir(appFolder, { recursive: true });
        await fs.promises.writeFile(
            path.join(appFolder, 'index.html'),
            `<h1>app</h1><script src="${HOSTED}"></script>`
        );
        const extensionResources = path.join(tmp, 'extension', 'resources', 'appPreview');
        await fs.promises.mkdir(extensionResources, { recursive: true });
        await fs.promises.writeFile(path.join(extensionResources, 'v1.js'), '/* client */');

        const workspaceFolder: WorkspaceFolder = { uri: Uri.file(tmp), name: 'tmp', index: 0 };
        when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder]);
        when(mockedVSCodeNamespaces.workspace.getWorkspaceFolder(anything())).thenReturn(workspaceFolder);

        when(env().asExternalUri(anything())).thenCall((uri: Uri) => Promise.resolve(uri));
        when(env().openExternal(anything())).thenReturn(Promise.resolve(true));
        when(commands().executeCommand(SIMPLE_BROWSER_OPEN, anything(), anything())).thenResolve(undefined);
        when(commands().executeCommand(INTEGRATED_BROWSER_OPEN, anything())).thenResolve(undefined);
        when(commands().getCommands(anything())).thenReturn(Promise.resolve([]));
        simpleBrowserConfig = mock<WorkspaceConfiguration>();
        when(simpleBrowserConfig.inspect('useIntegratedBrowser')).thenReturn({
            key: 'simpleBrowser.useIntegratedBrowser'
        });
        when(simpleBrowserConfig.get('useIntegratedBrowser', anything())).thenCall(
            (_section: string, defaultValue: boolean) => defaultValue
        );
        when(mockedVSCodeNamespaces.workspace.getConfiguration('simpleBrowser')).thenReturn(
            instance(simpleBrowserConfig)
        );
        when(commands().registerCommand(Commands.PreviewApp, anything())).thenReturn({ dispose: () => undefined });

        disposables = [];
        const context = mock<IExtensionContext>();
        when(context.subscriptions).thenReturn([]);
        when(context.extensionUri).thenReturn(Uri.file(path.join(tmp, 'extension')));
        new AppPreviewCommandHandler(instance(context), disposables, instance(mock<IAppPreviewRunner>())).activate();
        const [command, handler] = capture(commands().registerCommand).last();
        assert.strictEqual(command, Commands.PreviewApp);
        previewApp = handler;
    });

    teardown(async () => {
        sinon.restore();
        disposables = dispose(disposables);
        resetVSCodeMocks();
        await fs.promises.rm(tmp, { recursive: true, force: true });
    });

    test('previews the folder from the Explorer in the Simple Browser beside the editor, where there is no integrated browser', async () => {
        when(commands().getCommands(anything())).thenReturn(Promise.resolve([SIMPLE_BROWSER_OPEN]));

        await previewApp(Uri.file(appFolder));

        verify(
            commands().executeCommand(
                SIMPLE_BROWSER_OPEN,
                anything(),
                deepEqual({ viewColumn: ViewColumn.Beside, preserveFocus: true })
            )
        ).once();
        assert.strictEqual(executedCommands().last()[1].toString(true), serverUrl());
        assert.include(await page(), '<h1>app</h1>');
        verify(env().openExternal(anything())).never();
    });

    test('previews the folder in the integrated browser, in the tab already showing its server if there is one', async () => {
        when(commands().getCommands(anything())).thenReturn(Promise.resolve(BOTH_BROWSERS));
        when(env().asExternalUri(anything())).thenReturn(Promise.resolve(Uri.parse('http://localhost:1111/')));

        await previewApp(Uri.file(appFolder));

        verify(
            commands().executeCommand(
                INTEGRATED_BROWSER_OPEN,
                deepEqual({ url: 'http://localhost:1111/', reuseUrlFilter: 'http://localhost:1111/**' })
            )
        ).once();
        verify(commands().executeCommand(SIMPLE_BROWSER_OPEN, anything(), anything())).never();
        assert.include(await page(), '<h1>app</h1>');
    });

    test('previews the folder in the Simple Browser when simpleBrowser.useIntegratedBrowser is off', async () => {
        when(commands().getCommands(anything())).thenReturn(Promise.resolve(BOTH_BROWSERS));
        when(simpleBrowserConfig.inspect('useIntegratedBrowser')).thenReturn({
            key: 'simpleBrowser.useIntegratedBrowser',
            defaultValue: true,
            globalValue: false
        });
        when(simpleBrowserConfig.get('useIntegratedBrowser', anything())).thenReturn(false);

        await previewApp(Uri.file(appFolder));

        verify(commands().executeCommand(INTEGRATED_BROWSER_OPEN, anything())).never();
        verify(commands().executeCommand(SIMPLE_BROWSER_OPEN, anything(), anything())).once();
    });

    test('ignores a simpleBrowser.useIntegratedBrowser left in the settings by a VS Code version that registered it', async () => {
        when(commands().getCommands(anything())).thenReturn(Promise.resolve(BOTH_BROWSERS));
        when(simpleBrowserConfig.inspect('useIntegratedBrowser')).thenReturn({
            key: 'simpleBrowser.useIntegratedBrowser',
            globalValue: false
        });
        when(simpleBrowserConfig.get('useIntegratedBrowser', anything())).thenReturn(false);

        await previewApp(Uri.file(appFolder));

        verify(commands().executeCommand(INTEGRATED_BROWSER_OPEN, anything())).once();
        verify(commands().executeCommand(SIMPLE_BROWSER_OPEN, anything(), anything())).never();
    });

    test('asks for the folder when the command has none', async () => {
        when(win().showOpenDialog(anything())).thenReturn(Promise.resolve([Uri.file(appFolder)]));

        await previewApp();

        const dialog = capture(win().showOpenDialog).last()[0];
        assert.deepStrictEqual(
            { ...dialog, defaultUri: dialog?.defaultUri?.fsPath },
            {
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                defaultUri: Uri.file(tmp).fsPath,
                title: 'Choose the app folder to preview',
                openLabel: 'Preview'
            }
        );
        verify(commands().executeCommand(SIMPLE_BROWSER_OPEN, anything(), anything())).once();
        assert.include(await page(), '<h1>app</h1>');
    });

    test('does nothing when the folder dialog is dismissed', async () => {
        when(win().showOpenDialog(anything())).thenReturn(Promise.resolve(undefined));

        await previewApp();

        verify(env().asExternalUri(anything())).never();
        verify(commands().executeCommand(SIMPLE_BROWSER_OPEN, anything(), anything())).never();
        verify(env().openExternal(anything())).never();
    });

    test('starts the session with the project of the .deepnote file in a folder above the app', async () => {
        await fs.promises.writeFile(path.join(tmp, 'project', 'analysis.deepnote'), serializeProjectFile('p-first'));

        await previewApp(Uri.file(appFolder));

        assert.strictEqual((await requestToken()).projectId, 'p-first');
    });

    test('reuses the session on a second run, with the project and forwarded URL resolved again', async () => {
        when(env().asExternalUri(anything())).thenReturn(
            Promise.resolve(Uri.parse('http://localhost:1111/')),
            Promise.resolve(Uri.parse('http://localhost:2222/'))
        );
        await previewApp(Uri.file(appFolder));
        const server = serverUrl();
        assert.notProperty(await requestToken(), 'projectId');

        await fs.promises.writeFile(path.join(tmp, 'project', 'analysis.deepnote'), serializeProjectFile('p-added'));
        await previewApp(Uri.file(appFolder));

        verify(env().asExternalUri(anything())).twice();
        assert.strictEqual(serverUrl(), server);
        const browserOpens = executedCommands();
        assert.deepStrictEqual(
            [browserOpens.first()[1].toString(true), browserOpens.second()[1].toString(true)],
            ['http://localhost:1111/', 'http://localhost:2222/']
        );
        assert.strictEqual((await requestToken()).projectId, 'p-added');
    });

    test('starts one server when the command runs again while the first run is starting', async () => {
        await Promise.all([previewApp(Uri.file(appFolder)), previewApp(Uri.file(appFolder))]);

        const forwarded = capture(env().asExternalUri);
        assert.strictEqual(forwarded.second()[0].toString(true), forwarded.first()[0].toString(true));
        verify(commands().executeCommand(SIMPLE_BROWSER_OPEN, anything(), anything())).twice();
    });

    test('opens the server URL in the system browser when the built-in browser command is missing', async () => {
        when(commands().executeCommand(SIMPLE_BROWSER_OPEN, anything(), anything())).thenReject(
            new Error("command 'simpleBrowser.api.open' not found")
        );
        when(env().asExternalUri(anything())).thenReturn(Promise.resolve(Uri.parse('http://localhost:4567/')));

        await previewApp(Uri.file(appFolder));

        verify(env().openExternal(anything())).once();
        assert.strictEqual(capture(env().openExternal).last()[0].toString(true), serverUrl());
    });

    test('opens the server URL in the system browser when the integrated browser rejects', async () => {
        when(commands().getCommands(anything())).thenReturn(Promise.resolve(BOTH_BROWSERS));
        when(commands().executeCommand(INTEGRATED_BROWSER_OPEN, anything())).thenReject(
            new Error('the integrated browser failed')
        );

        await previewApp(Uri.file(appFolder));

        verify(env().openExternal(anything())).once();
        assert.strictEqual(capture(env().openExternal).last()[0].toString(true), serverUrl());
    });

    test('shows why the preview could not start, and starts afresh on the next run', async () => {
        const start = sinon.stub(AppPreviewSession.prototype, 'start').rejects(new Error('listen EACCES'));

        await previewApp(Uri.file(appFolder));

        verify(win().showErrorMessage('Could not start the app preview: listen EACCES')).once();
        verify(commands().executeCommand(SIMPLE_BROWSER_OPEN, anything(), anything())).never();
        verify(env().openExternal(anything())).never();

        start.restore();
        await previewApp(Uri.file(appFolder));

        verify(commands().executeCommand(SIMPLE_BROWSER_OPEN, anything(), anything())).once();
        assert.include(await page(), '<h1>app</h1>');
    });

    test('warns once per unsupported operation, naming the operation and the folder', async () => {
        await previewApp(Uri.file(appFolder));
        const { token } = await requestToken();
        const api = (urlPath: string, method = 'GET') =>
            fetch(`${serverUrl()}v2${urlPath}`, {
                method,
                headers: { authorization: `Bearer ${token}` }
            });

        assert.strictEqual((await api('/notebooks/nb-1/app-data')).status, 501);
        assert.strictEqual((await api('/projects/project-1/dataframes/sales')).status, 501);
        assert.strictEqual((await api('/projects/project-1/dataframes/sales')).status, 501);

        verify(
            win().showWarningMessage('The app in app called appData(), which the local preview does not support yet.')
        ).once();
        verify(
            win().showWarningMessage('The app in app called dataframe(), which the local preview does not support yet.')
        ).once();
    });
});
