import { assert } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as sinon from 'sinon';
import { anything, capture, instance, mock, when } from 'ts-mockito';
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

const HOSTED = 'https://deepnote.com/static/app-client/v1.js';

suite('AppPreviewCommandHandler', () => {
    let tmp: string;
    let appFolder: string;
    let disposables: IDisposable[];
    let previewApp: (arg?: unknown) => Promise<void>;
    let forwarded: string[];
    let externalUriRequests: string[];
    let opened: { uri: string; options: unknown }[];
    let openedInIntegratedBrowser: unknown[];
    let commandIds: string[];
    let useIntegratedBrowser: { registered: boolean; value?: boolean };
    let openedExternally: string[];
    let browserFailure: Error | undefined;
    let warnings: string[];
    let errors: string[];

    const win = () => mockedVSCodeNamespaces.window;

    /** Answers `env.asExternalUri` with the given URLs in turn, then with the URL asked for. */
    function forwardTo(...urls: string[]): void {
        forwarded = urls;
    }

    async function page(urlPath = '/'): Promise<string> {
        const response = await fetch(`${externalUriRequests[externalUriRequests.length - 1]}${urlPath.slice(1)}`);

        return response.text();
    }

    async function requestToken(): Promise<{ token: string; projectId?: string }> {
        const url = externalUriRequests[externalUriRequests.length - 1];
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

        forwarded = [];
        externalUriRequests = [];
        when(mockedVSCodeNamespaces.env.asExternalUri(anything())).thenCall((uri: Uri) => {
            externalUriRequests.push(uri.toString(true));

            return Promise.resolve(forwarded.length > 0 ? Uri.parse(forwarded.shift()!) : uri);
        });

        opened = [];
        browserFailure = undefined;
        when(mockedVSCodeNamespaces.commands.executeCommand('simpleBrowser.api.open', anything(), anything())).thenCall(
            async (_command: string, uri: Uri, options: unknown) => {
                if (browserFailure) {
                    throw browserFailure;
                }
                opened.push({ uri: uri.toString(true), options });
            }
        );
        openedInIntegratedBrowser = [];
        when(mockedVSCodeNamespaces.commands.executeCommand('workbench.action.browser.open', anything())).thenCall(
            async (_command: string, options: unknown) => {
                if (browserFailure) {
                    throw browserFailure;
                }
                openedInIntegratedBrowser.push(options);
            }
        );
        commandIds = [];
        when(mockedVSCodeNamespaces.commands.getCommands(anything())).thenCall(async () => commandIds);
        useIntegratedBrowser = { registered: false };
        const simpleBrowserConfig = mock<WorkspaceConfiguration>();
        when(simpleBrowserConfig.inspect('useIntegratedBrowser')).thenCall(() => ({
            key: 'simpleBrowser.useIntegratedBrowser',
            defaultValue: useIntegratedBrowser.registered ? true : undefined,
            globalValue: useIntegratedBrowser.value
        }));
        when(simpleBrowserConfig.get('useIntegratedBrowser', anything())).thenCall(
            (_section: string, defaultValue: boolean) => useIntegratedBrowser.value ?? defaultValue
        );
        when(mockedVSCodeNamespaces.workspace.getConfiguration('simpleBrowser')).thenReturn(
            instance(simpleBrowserConfig)
        );
        openedExternally = [];
        when(mockedVSCodeNamespaces.env.openExternal(anything())).thenCall(async (uri: Uri) => {
            openedExternally.push(uri.toString(true));

            return true;
        });

        warnings = [];
        errors = [];
        when(win().showWarningMessage(anything())).thenCall(async (message: string) => {
            warnings.push(message);
        });
        when(win().showErrorMessage(anything())).thenCall(async (message: string) => {
            errors.push(message);
        });

        when(mockedVSCodeNamespaces.commands.registerCommand(Commands.PreviewApp, anything())).thenCall(
            (_id: string, handler: (arg?: unknown) => Promise<void>) => {
                previewApp = handler;

                return { dispose: () => undefined };
            }
        );

        disposables = [];
        const context = mock<IExtensionContext>();
        when(context.subscriptions).thenReturn([]);
        when(context.extensionUri).thenReturn(Uri.file(path.join(tmp, 'extension')));
        new AppPreviewCommandHandler(instance(context), disposables).activate();
    });

    teardown(async () => {
        sinon.restore();
        disposables = dispose(disposables);
        resetVSCodeMocks();
        await fs.promises.rm(tmp, { recursive: true, force: true });
    });

    test('previews the folder from the Explorer in the Simple Browser beside the editor, where there is no integrated browser', async () => {
        commandIds = ['simpleBrowser.api.open'];

        await previewApp(Uri.file(appFolder));

        assert.strictEqual(opened.length, 1);
        assert.deepStrictEqual(opened[0].options, { viewColumn: ViewColumn.Beside, preserveFocus: true });
        assert.strictEqual(opened[0].uri, externalUriRequests[0]);
        assert.include(await page(), '<h1>app</h1>');
        assert.deepStrictEqual(openedExternally, []);
    });

    test('previews the folder in the integrated browser, in the tab already showing its server if there is one', async () => {
        commandIds = ['simpleBrowser.api.open', 'workbench.action.browser.open'];
        forwardTo('http://localhost:1111/');

        await previewApp(Uri.file(appFolder));

        assert.deepStrictEqual(openedInIntegratedBrowser, [
            { url: 'http://localhost:1111/', reuseUrlFilter: 'http://localhost:1111/**' }
        ]);
        assert.deepStrictEqual(opened, []);
        assert.include(await page(), '<h1>app</h1>');
    });

    test('previews the folder in the Simple Browser when simpleBrowser.useIntegratedBrowser is off', async () => {
        commandIds = ['simpleBrowser.api.open', 'workbench.action.browser.open'];
        useIntegratedBrowser = { registered: true, value: false };

        await previewApp(Uri.file(appFolder));

        assert.deepStrictEqual(openedInIntegratedBrowser, []);
        assert.strictEqual(opened.length, 1);
    });

    test('ignores a simpleBrowser.useIntegratedBrowser left in the settings by a VS Code version that registered it', async () => {
        commandIds = ['simpleBrowser.api.open', 'workbench.action.browser.open'];
        useIntegratedBrowser = { registered: false, value: false };

        await previewApp(Uri.file(appFolder));

        assert.strictEqual(openedInIntegratedBrowser.length, 1);
        assert.deepStrictEqual(opened, []);
    });

    test('asks for the folder when the command has none', async () => {
        when(win().showOpenDialog(anything())).thenCall(async () => [Uri.file(appFolder)]);

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
        assert.strictEqual(opened.length, 1);
        assert.include(await page(), '<h1>app</h1>');
    });

    test('does nothing when the folder dialog is dismissed', async () => {
        when(win().showOpenDialog(anything())).thenCall(async () => undefined);

        await previewApp();

        assert.deepStrictEqual(externalUriRequests, []);
        assert.deepStrictEqual(opened, []);
        assert.deepStrictEqual(openedExternally, []);
    });

    test('starts the session with the project of the .deepnote file in a folder above the app', async () => {
        await fs.promises.writeFile(path.join(tmp, 'project', 'analysis.deepnote'), serializeProjectFile('p-first'));

        await previewApp(Uri.file(appFolder));

        assert.strictEqual((await requestToken()).projectId, 'p-first');
    });

    test('reuses the session on a second run, with the project and forwarded URL resolved again', async () => {
        forwardTo('http://localhost:1111/', 'http://localhost:2222/');
        await previewApp(Uri.file(appFolder));
        const server = externalUriRequests[0];
        assert.notProperty(await requestToken(), 'projectId');

        await fs.promises.writeFile(path.join(tmp, 'project', 'analysis.deepnote'), serializeProjectFile('p-added'));
        await previewApp(Uri.file(appFolder));

        assert.deepStrictEqual(externalUriRequests, [server, server]);
        assert.deepStrictEqual(
            opened.map(({ uri }) => uri),
            ['http://localhost:1111/', 'http://localhost:2222/']
        );
        assert.strictEqual((await requestToken()).projectId, 'p-added');
    });

    test('starts one server when the command runs again while the first run is starting', async () => {
        await Promise.all([previewApp(Uri.file(appFolder)), previewApp(Uri.file(appFolder))]);

        assert.strictEqual(new Set(externalUriRequests).size, 1);
        assert.strictEqual(opened.length, 2);
    });

    test('opens the server URL in the system browser when the built-in browser command is missing', async () => {
        browserFailure = new Error("command 'simpleBrowser.api.open' not found");
        forwardTo('http://localhost:4567/');

        await previewApp(Uri.file(appFolder));

        assert.deepStrictEqual(opened, []);
        assert.deepStrictEqual(openedExternally, [externalUriRequests[0]]);
    });

    test('opens the server URL in the system browser when the integrated browser rejects', async () => {
        commandIds = ['simpleBrowser.api.open', 'workbench.action.browser.open'];
        browserFailure = new Error('the integrated browser failed');

        await previewApp(Uri.file(appFolder));

        assert.deepStrictEqual(openedExternally, [externalUriRequests[0]]);
    });

    test('shows why the preview could not start, and starts afresh on the next run', async () => {
        const start = sinon.stub(AppPreviewSession.prototype, 'start').rejects(new Error('listen EACCES'));

        await previewApp(Uri.file(appFolder));

        assert.deepStrictEqual(errors, ['Could not start the app preview: listen EACCES']);
        assert.deepStrictEqual(opened, []);
        assert.deepStrictEqual(openedExternally, []);

        start.restore();
        await previewApp(Uri.file(appFolder));

        assert.strictEqual(opened.length, 1);
        assert.include(await page(), '<h1>app</h1>');
    });

    test('warns once per unsupported operation, naming the operation and the folder', async () => {
        await previewApp(Uri.file(appFolder));
        const { token } = await requestToken();
        const api = (urlPath: string, method = 'GET') =>
            fetch(`${externalUriRequests[0]}v2${urlPath}`, {
                method,
                headers: { authorization: `Bearer ${token}` }
            });

        assert.strictEqual((await api('/notebooks/nb-1/app-data')).status, 501);
        assert.strictEqual((await api('/notebooks/nb-1/app-data')).status, 501);
        assert.strictEqual((await api('/runs', 'POST')).status, 501);
        assert.strictEqual((await api('/runs/run-1')).status, 501);

        assert.deepStrictEqual(warnings, [
            'The app in app called appData(), which the local preview does not support yet.',
            'The app in app called run(), which the local preview does not support yet.'
        ]);
    });
});
