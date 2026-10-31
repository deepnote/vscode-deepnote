import type { Workspace } from '@deepnote/cloud';
import { ApiError, findSyncManifestRoot } from '@deepnote/cloud-sync';
import { assert } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as sinon from 'sinon';
import { anything, capture, instance, mock, verify, when } from 'ts-mockito';
import { ExtensionMode, InputBoxOptions, Uri, WorkspaceFolder } from 'vscode';

import { EncryptedStorage } from '../../../platform/common/application/encryptedStorage';
import { IEncryptedStorage } from '../../../platform/common/application/types';
import { Commands, NotebookCellScheme } from '../../../platform/common/constants';
import { IExtensionContext } from '../../../platform/common/types';
import { DeepnoteCloud } from '../../../platform/common/utils/localize';
import * as path from '../../../platform/vscode-path/path';
import { extUriBiasedIgnorePathCase, extUriIgnorePathCase } from '../../../platform/vscode-path/resources';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { DeepnoteApiTokenService } from './deepnoteApiTokenService.node';

class TestableService extends DeepnoteApiTokenService {
    public readonly fetchWorkspaceStub = sinon.stub<[string, string], Promise<Workspace | undefined>>();

    protected override fetchWorkspace(baseUrl: string, token: string): Promise<Workspace | undefined> {
        return this.fetchWorkspaceStub(baseUrl, token);
    }
}

suite('DeepnoteApiTokenService', () => {
    const DEFAULT_API = 'https://api.deepnote.com';
    const PICKED_API = 'https://api.picked.test';

    let tmp: string;
    let ws: string;
    let service: TestableService;
    let encryptedStorage: IEncryptedStorage;
    let secrets: Map<string, string>;
    let sandbox: sinon.SinonSandbox;
    let commandHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;

    const win = () => mockedVSCodeNamespaces.window;
    const wsp = () => mockedVSCodeNamespaces.workspace;

    async function writeFile(file: string, content: string): Promise<void> {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, content);
    }

    function readFile(file: string): Promise<string> {
        return fs.promises.readFile(file, 'utf8');
    }

    function isInside(candidate: string, folder: string): boolean {
        return candidate === folder || candidate.startsWith(folder + path.sep);
    }

    function openWorkspaceFolder(folderPath: string): void {
        const folder: WorkspaceFolder = { uri: Uri.file(folderPath), name: path.basename(folderPath), index: 0 };
        when(wsp().workspaceFolders).thenReturn([folder]);
        // fsPath lower-cases a Windows drive letter, so compare against the folder's fsPath, not folderPath.
        when(wsp().getWorkspaceFolder(anything())).thenCall((uri: Uri) =>
            isInside(uri.fsPath, folder.uri.fsPath) ? folder : undefined
        );
        when(wsp().asRelativePath(anything())).thenCall((uri: Uri) => path.relative(folder.uri.fsPath, uri.fsPath));
    }

    function setDomain(folder: string, domain: string): void {
        const folderPath = Uri.file(folder).fsPath;
        when(wsp().getConfiguration('deepnote', anything())).thenCall((_section: string, resource?: Uri) => ({
            get: (key: string, fallback: unknown) =>
                key === 'domain' && resource && isInside(resource.fsPath, folderPath) ? domain : fallback
        }));
    }

    function activeFile(file: string): void {
        when(win().activeTextEditor).thenReturn({ document: { uri: Uri.file(file) } } as any);
    }

    function enterToken(token: string | undefined): void {
        when(win().showInputBox(anything())).thenResolve(token as any);
    }

    function setApiToken(resource?: Uri): Promise<unknown> {
        return commandHandlers.get(Commands.SetApiToken)!(resource);
    }

    function clearApiToken(): Promise<unknown> {
        return commandHandlers.get(Commands.ClearApiToken)!();
    }

    function inputBoxOptions(): InputBoxOptions {
        return capture(win().showInputBox).last()[0] as InputBoxOptions;
    }

    function secretKey(apiUrl: string): string {
        return `deepnote-api-token/${apiUrl}`;
    }

    function seedToken(apiUrl: string, token: string): void {
        secrets.set(secretKey(apiUrl), token);
    }

    function assertOnlyStored(apiUrl: string, token: string): void {
        assert.deepStrictEqual([...secrets], [[secretKey(apiUrl), token]]);
    }

    function verifyError(message: string): void {
        verify(win().showErrorMessage(message)).once();
    }

    function verifyNoInputBox(): void {
        verify(win().showInputBox(anything())).never();
    }

    function verifyNothingStored(): void {
        verify(encryptedStorage.store(anything(), anything(), anything())).never();
    }

    function verifyNoStorageAccess(): void {
        verifyNothingStored();
        verify(encryptedStorage.retrieve(anything(), anything())).never();
    }

    function createSyncManifest(folder: string): Promise<void> {
        return writeFile(path.join(folder, '.deepnote-sync.json'), '{}');
    }

    setup(async () => {
        resetVSCodeMocks();
        sandbox = sinon.createSandbox();
        tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deepnote-token-'));
        assert.isUndefined(
            await findSyncManifestRoot(tmp),
            'A .deepnote-sync.json above the temp dir would extend the token lookup outside it'
        );
        ws = path.join(tmp, 'ws');
        await fs.promises.mkdir(ws);

        openWorkspaceFolder(ws);
        when(wsp().getConfiguration('deepnote', anything())).thenReturn({
            get: (_key: string, fallback: unknown) => fallback
        } as any);

        commandHandlers = new Map();
        when(mockedVSCodeNamespaces.commands.registerCommand(anything(), anything())).thenCall(
            (id: string, handler: (...args: unknown[]) => Promise<unknown>) => {
                commandHandlers.set(id, handler);

                return { dispose: () => undefined };
            }
        );

        secrets = new Map();
        encryptedStorage = mock<IEncryptedStorage>();
        when(encryptedStorage.store(anything(), anything(), anything())).thenCall(
            async (storageService: string, key: string, value: string | undefined) => {
                if (value === undefined) {
                    secrets.delete(`${storageService}/${key}`);
                } else {
                    secrets.set(`${storageService}/${key}`, value);
                }
            }
        );
        when(encryptedStorage.retrieve(anything(), anything())).thenCall(async (storageService: string, key: string) =>
            secrets.get(`${storageService}/${key}`)
        );

        service = new TestableService(
            { subscriptions: [] } as unknown as IExtensionContext,
            instance(encryptedStorage)
        );
        service.fetchWorkspaceStub.resolves({ id: 'w1', name: 'Acme' });
        service.activate();
    });

    teardown(async () => {
        resetVSCodeMocks();
        sandbox.restore();
        await fs.promises.rm(tmp, { recursive: true, force: true });
    });

    suite('activate', () => {
        test('registers the Set and Clear commands', () => {
            assert.sameMembers([...commandHandlers.keys()], ['deepnote.setApiToken', 'deepnote.clearApiToken']);
        });
    });

    suite('getToken', () => {
        test('prefers the .env nearest the file over the one at the workspace root', async () => {
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=root\n');
            await writeFile(path.join(ws, 'a', 'b', '.env'), 'DEEPNOTE_TOKEN=near\n');

            assert.strictEqual(await service.getToken(Uri.file(path.join(ws, 'a', 'b', 'nb.deepnote'))), 'near');
        });

        test('skips a .env with an empty DEEPNOTE_TOKEN in favor of its parent', async () => {
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=root\n');
            await writeFile(path.join(ws, 'a', 'b', '.env'), 'DEEPNOTE_TOKEN=\n');

            assert.strictEqual(await service.getToken(Uri.file(path.join(ws, 'a', 'b', 'nb.deepnote'))), 'root');
        });

        test('trims the value and reads the `KEY: value` form and `export`', async () => {
            await writeFile(path.join(ws, 'a', '.env'), "DEEPNOTE_TOKEN: '  spaced  '\n");
            await writeFile(path.join(ws, 'b', '.env'), 'export DEEPNOTE_TOKEN=exported\n');

            assert.strictEqual(await service.getToken(Uri.file(path.join(ws, 'a', 'nb.deepnote'))), 'spaced');
            assert.strictEqual(await service.getToken(Uri.file(path.join(ws, 'b', 'nb.deepnote'))), 'exported');
        });

        test('is undefined when no .env on the path defines it', async () => {
            await writeFile(path.join(ws, '.env'), 'OTHER=1\n');
            await writeFile(path.join(tmp, '.env'), 'DEEPNOTE_TOKEN=outside\n');

            assert.isUndefined(await service.getToken(Uri.file(path.join(ws, 'a', 'nb.deepnote'))));
        });

        test('stops at the sync root, not the workspace folder root above it', async () => {
            const syncRoot = path.join(ws, 'sync');
            await createSyncManifest(syncRoot);
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=at-workspace\n');
            seedToken(DEFAULT_API, 'stored');

            assert.strictEqual(await service.getToken(Uri.file(path.join(syncRoot, 'P', 'nb.deepnote'))), 'stored');
        });

        test('searches up to the sync root when it is above the workspace folder', async () => {
            const syncRoot = path.join(ws, 'sync');
            const projectFolder = path.join(syncRoot, 'P');
            openWorkspaceFolder(projectFolder);
            await createSyncManifest(syncRoot);
            await writeFile(path.join(syncRoot, '.env'), 'DEEPNOTE_TOKEN=at-sync-root\n');
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=above-sync-root\n');

            assert.strictEqual(
                await service.getToken(Uri.file(path.join(projectFolder, 'nb.deepnote'))),
                'at-sync-root'
            );
        });

        test('treats a symbolic-link sync manifest as no sync root', async () => {
            const syncRoot = path.join(ws, 'sync');
            await fs.promises.mkdir(path.join(syncRoot, 'P'), { recursive: true });
            await writeFile(path.join(tmp, 'real-manifest.json'), '{}');
            await fs.promises.symlink(path.join(tmp, 'real-manifest.json'), path.join(syncRoot, '.deepnote-sync.json'));
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=at-workspace\n');

            assert.strictEqual(
                await service.getToken(Uri.file(path.join(syncRoot, 'P', 'nb.deepnote'))),
                'at-workspace'
            );
        });

        test('reads the folder itself when given a folder', async () => {
            await writeFile(path.join(ws, 'a', '.env'), 'DEEPNOTE_TOKEN=in-folder\n');

            assert.strictEqual(await service.getToken(Uri.file(path.join(ws, 'a'))), 'in-folder');
        });

        test('ignores the query and fragment of a notebook URI', async () => {
            await writeFile(path.join(ws, 'a', '.env'), 'DEEPNOTE_TOKEN=in-folder\n');

            assert.strictEqual(
                await service.getToken(
                    Uri.file(path.join(ws, 'a', 'nb.deepnote')).with({ query: 'id=1', fragment: 'x' })
                ),
                'in-folder'
            );
        });

        test('does not search above the workspace folder for a notebook URI with a query', async () => {
            await writeFile(path.join(tmp, '.env'), 'DEEPNOTE_TOKEN=above-workspace\n');

            assert.isUndefined(
                await service.getToken(
                    Uri.file(path.join(ws, 'a', 'nb.deepnote')).with({ query: 'id=1', fragment: 'x' })
                )
            );
        });

        test('does not search above a workspace folder that is missing on disk', async () => {
            const missing = path.join(tmp, 'projects', 'foo');
            openWorkspaceFolder(missing);
            await writeFile(path.join(tmp, 'projects', '.env'), 'DEEPNOTE_TOKEN=other-project\n');

            assert.isUndefined(await service.getToken(Uri.file(missing)));
        });

        test('does not search above the workspace folder for a folder URI with a trailing slash', async () => {
            await writeFile(path.join(tmp, '.env'), 'DEEPNOTE_TOKEN=above-workspace\n');

            assert.isUndefined(await service.getToken(Uri.file(ws + '/')));
        });

        test('stops at, and still reads, a workspace folder whose URI ends in a slash', async () => {
            const folder: WorkspaceFolder = { uri: Uri.parse(Uri.file(ws).toString() + '/'), name: 'ws', index: 0 };
            when(wsp().getWorkspaceFolder(anything())).thenReturn(folder);
            await writeFile(path.join(tmp, '.env'), 'DEEPNOTE_TOKEN=above-workspace\n');
            const notebook = Uri.file(path.join(ws, 'a', 'nb.deepnote'));

            assert.isUndefined(await service.getToken(notebook));
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=at-root\n');
            assert.strictEqual(await service.getToken(notebook), 'at-root');
        });

        test('does not search above a workspace folder matched in another path case', async () => {
            // VS Code matches file URIs to workspace folders case-insensitively on macOS and Windows.
            const folder: WorkspaceFolder = { uri: Uri.file(path.join(tmp, 'WS')), name: 'WS', index: 0 };
            when(wsp().getWorkspaceFolder(anything())).thenReturn(folder);
            await writeFile(path.join(tmp, '.env'), 'DEEPNOTE_TOKEN=above-workspace\n');

            assert.isUndefined(await service.getToken(Uri.file(path.join(ws, 'a', 'nb.deepnote'))));
        });

        test('reads the root of a workspace folder matched in another path case', async () => {
            // Path case is ignored only off Linux and CI runs on Linux, so apply the macOS and Windows comparison.
            sandbox
                .stub(extUriBiasedIgnorePathCase, 'isEqualOrParent')
                .callsFake((...args) => extUriIgnorePathCase.isEqualOrParent(...args));
            sandbox
                .stub(extUriBiasedIgnorePathCase, 'isEqual')
                .callsFake((...args) => extUriIgnorePathCase.isEqual(...args));
            when(wsp().getWorkspaceFolder(anything())).thenReturn({
                uri: Uri.file(path.join(tmp, 'WS')),
                name: 'WS',
                index: 0
            });
            await writeFile(path.join(tmp, '.env'), 'DEEPNOTE_TOKEN=above-workspace\n');
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=at-workspace\n');

            assert.strictEqual(await service.getToken(Uri.file(path.join(ws, 'a', 'nb.deepnote'))), 'at-workspace');
        });

        test('resolves undefined for a non-file URI without touching the disk or the stored token', async () => {
            seedToken(DEFAULT_API, 'stored');
            const stat = sandbox.spy(fs.promises, 'stat');
            const read = sandbox.spy(fs.promises, 'readFile');

            assert.isUndefined(await service.getToken(Uri.parse('vscode-vfs://github/o/r/nb.deepnote')));
            assert.isTrue(stat.notCalled);
            assert.isTrue(read.notCalled);
            verifyNoStorageAccess();
        });

        test('resolves undefined in an untrusted workspace without reading a file or the stored token', async () => {
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=t\n');
            seedToken(DEFAULT_API, 'stored');
            when(wsp().isTrusted).thenReturn(false);
            const read = sandbox.spy(fs.promises, 'readFile');

            assert.isUndefined(await service.getToken(Uri.file(path.join(ws, 'nb.deepnote'))));
            assert.isTrue(read.notCalled);
            verifyNoStorageAccess();
        });

        test('reads the last real assignment, not one inside a quoted multi-line value', async () => {
            await writeFile(
                path.join(ws, '.env'),
                'CERT="-----BEGIN\nDEEPNOTE_TOKEN=fake\n-----END"\nDEEPNOTE_TOKEN=real\n'
            );

            assert.strictEqual(await service.getToken(Uri.file(path.join(ws, 'nb.deepnote'))), 'real');
        });

        test('returns the stored token when no .env on the path has a non-empty one', async () => {
            await writeFile(path.join(ws, '.env'), 'OTHER=1\n');
            await writeFile(path.join(ws, 'a', '.env'), 'DEEPNOTE_TOKEN=\n');
            seedToken(DEFAULT_API, 'stored');

            assert.strictEqual(await service.getToken(Uri.file(path.join(ws, 'a', 'nb.deepnote'))), 'stored');
        });

        test('prefers the .env token over the stored token', async () => {
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=from-file\n');
            seedToken(DEFAULT_API, 'stored');

            assert.strictEqual(await service.getToken(Uri.file(path.join(ws, 'nb.deepnote'))), 'from-file');
        });

        test('treats an empty stored value as no token', async () => {
            seedToken(DEFAULT_API, '');

            assert.isUndefined(await service.getToken(Uri.file(path.join(ws, 'nb.deepnote'))));
        });

        test('returns the token saved by Set API Token for that Deepnote domain only', async () => {
            const notebook = Uri.file(path.join(ws, 'a', 'nb.deepnote'));
            enterToken('saved');
            await setApiToken(notebook);

            assert.strictEqual(await service.getToken(notebook), 'saved');

            setDomain(ws, 'example.com');
            assert.isUndefined(await service.getToken(notebook));
        });
    });

    suite('getOrPromptToken', () => {
        const notebook = () => Uri.file(path.join(ws, 'a', 'nb.deepnote'));

        test('returns the stored token without prompting', async () => {
            seedToken(DEFAULT_API, 'stored');

            assert.strictEqual(await service.getOrPromptToken(notebook()), 'stored');
            verifyNoInputBox();
        });

        test('prompts, saves and returns a new token when none is stored', async () => {
            enterToken('fresh');

            assert.strictEqual(await service.getOrPromptToken(notebook()), 'fresh');
            assertOnlyStored(DEFAULT_API, 'fresh');
        });

        test('resolves undefined and stores nothing when the prompt is cancelled', async () => {
            enterToken(undefined);

            assert.isUndefined(await service.getOrPromptToken(notebook()));
            verifyNothingStored();
            assert.isTrue(service.fetchWorkspaceStub.notCalled);
        });

        test('tells the user about local files and does not prompt for a non-file URI', async () => {
            assert.isUndefined(await service.getOrPromptToken(Uri.parse('vscode-vfs://github/o/r/nb.deepnote')));

            verifyError(DeepnoteCloud.localFilesOnly);
            verifyNoInputBox();
        });

        test('tells the user to trust the workspace and does not prompt when untrusted', async () => {
            seedToken(DEFAULT_API, 'stored');
            when(wsp().isTrusted).thenReturn(false);

            assert.isUndefined(await service.getOrPromptToken(notebook()));

            verifyError(DeepnoteCloud.workspaceNotTrusted);
            verifyNoInputBox();
            verifyNoStorageAccess();
            assert.isTrue(service.fetchWorkspaceStub.notCalled);
        });
    });

    suite('Set API Token', () => {
        const NEW_TOKEN = 'new';

        function assertCheckedAndStored(apiUrl: string): void {
            assert.deepStrictEqual(service.fetchWorkspaceStub.lastCall.args, [apiUrl, NEW_TOKEN]);
            assertOnlyStored(apiUrl, NEW_TOKEN);
        }

        setup(() => {
            activeFile(path.join(ws, 'a', 'b', 'nb.deepnote'));
            enterToken(NEW_TOKEN);
        });

        test('stores the token and names the Deepnote workspace', async () => {
            await setApiToken();

            assertOnlyStored(DEFAULT_API, NEW_TOKEN);
            verify(win().showInformationMessage(DeepnoteCloud.apiTokenSavedForWorkspace('Acme'))).once();
        });

        test('confirms without a workspace name when the API returns none', async () => {
            service.fetchWorkspaceStub.resolves(undefined);

            await setApiToken();

            assertOnlyStored(DEFAULT_API, NEW_TOKEN);
            verify(win().showInformationMessage(DeepnoteCloud.apiTokenSaved)).once();
        });

        test('creates, changes and deletes no file', async () => {
            await writeFile(path.join(ws, '.env'), 'A=1\n');
            await writeFile(path.join(ws, '.gitignore'), 'node_modules\n');

            await setApiToken();

            assertOnlyStored(DEFAULT_API, NEW_TOKEN);
            assert.deepStrictEqual((await fs.promises.readdir(tmp, { recursive: true })).sort(), [
                'ws',
                path.join('ws', '.env'),
                path.join('ws', '.gitignore')
            ]);
            assert.strictEqual(await readFile(path.join(ws, '.env')), 'A=1\n');
            assert.strictEqual(await readFile(path.join(ws, '.gitignore')), 'node_modules\n');
        });

        test('starts from the active text editor', async () => {
            setDomain(path.join(ws, 'a', 'b'), 'picked.test');

            await setApiToken();

            assertCheckedAndStored(PICKED_API);
        });

        test('stores the token under the host it checked when the domain changes during the check', async () => {
            let domainChanged = false;
            service.fetchWorkspaceStub.callsFake(async () => {
                setDomain(ws, 'example.test');
                domainChanged = true;

                return { id: 'w1', name: 'Acme' };
            });

            await setApiToken();

            assert.isTrue(domainChanged);
            assertCheckedAndStored(DEFAULT_API);
        });

        test('warns, and leaves the .env unchanged, when a .env on the path sets the token it overrides', async () => {
            const content = 'A=1\nDEEPNOTE_TOKEN=from-file\n';
            await writeFile(path.join(ws, '.env'), content);

            await setApiToken();

            assertOnlyStored(DEFAULT_API, NEW_TOKEN);
            verify(win().showWarningMessage(DeepnoteCloud.apiTokenOverriddenByEnv('.env'))).once();
            verify(win().showInformationMessage(anything())).never();
            assert.strictEqual(await readFile(path.join(ws, '.env')), content);
        });

        test('names the nearest .env that sets a non-empty token in the warning', async () => {
            await writeFile(path.join(ws, 'a', 'b', '.env'), 'DEEPNOTE_TOKEN=\n');
            await writeFile(path.join(ws, 'a', '.env'), 'DEEPNOTE_TOKEN=near\n');
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=root\n');

            await setApiToken();

            verify(win().showWarningMessage(DeepnoteCloud.apiTokenOverriddenByEnv(path.join('a', '.env')))).once();
        });

        test('reports a save that fails and resolves without a token', async () => {
            when(encryptedStorage.store(anything(), anything(), anything())).thenReject(new Error('keyring locked'));

            assert.isUndefined(await service.getOrPromptToken(Uri.file(path.join(ws, 'a', 'b', 'nb.deepnote'))));

            verifyError(DeepnoteCloud.apiTokenStoreFailed('keyring locked'));
            verify(win().showInformationMessage(anything())).never();
        });

        test('keeps a workspace name from the API from forming a command link in the confirmation', async () => {
            service.fetchWorkspaceStub.resolves({ id: 'w1', name: 'X [y](command:foo) [z](command:bar)' });

            await setApiToken();

            verify(
                win().showInformationMessage(
                    DeepnoteCloud.apiTokenSavedForWorkspace('X [y] (command:foo) [z] (command:bar)')
                )
            ).once();
        });

        test('shows a workspace name with ordinary brackets and parentheses unchanged', async () => {
            service.fetchWorkspaceStub.resolves({ id: 'w1', name: 'Acme [EU] (prod)' });

            await setApiToken();

            verify(win().showInformationMessage(DeepnoteCloud.apiTokenSavedForWorkspace('Acme [EU] (prod)'))).once();
        });

        test('uses the command argument over the active editor', async () => {
            setDomain(path.join(ws, 'other'), 'picked.test');

            await setApiToken(Uri.file(path.join(ws, 'other', 'nb.deepnote')));

            assertCheckedAndStored(PICKED_API);
        });

        test('starts from the active notebook, not the focused cell editor inside it', async () => {
            const notebookUri = Uri.file(path.join(ws, 'n', 'nb.deepnote')).with({ query: 'id=1' });
            when(win().activeNotebookEditor).thenReturn({ notebook: { uri: notebookUri } } as any);
            when(win().activeTextEditor).thenReturn({
                document: { uri: notebookUri.with({ scheme: NotebookCellScheme, fragment: 'cell-1' }) }
            } as any);
            setDomain(path.join(ws, 'n'), 'picked.test');

            await setApiToken();

            assertCheckedAndStored(PICKED_API);
        });

        test('falls back to the workspace folder when the active file is not a local file', async () => {
            when(win().activeTextEditor).thenReturn({ document: { uri: Uri.parse('untitled:Untitled-1') } } as any);
            setDomain(ws, 'picked.test');

            await setApiToken();

            assertCheckedAndStored(PICKED_API);
        });

        test('asks which workspace folder to use when there are several', async () => {
            const second = path.join(tmp, 'second');
            await fs.promises.mkdir(second);
            when(win().activeTextEditor).thenReturn(undefined);
            when(wsp().workspaceFolders).thenReturn([
                { uri: Uri.file(ws), name: 'ws', index: 0 },
                { uri: Uri.file(second), name: 'second', index: 1 }
            ]);
            when(win().showWorkspaceFolderPick()).thenResolve({
                uri: Uri.file(second),
                name: 'second',
                index: 1
            } as any);
            setDomain(second, 'picked.test');

            await setApiToken();

            assertCheckedAndStored(PICKED_API);
        });

        test('stops without a prompt when the folder pick is cancelled', async () => {
            when(win().activeTextEditor).thenReturn(undefined);
            when(wsp().workspaceFolders).thenReturn([
                { uri: Uri.file(ws), name: 'ws', index: 0 },
                { uri: Uri.file(tmp), name: 'tmp', index: 1 }
            ]);
            when(win().showWorkspaceFolderPick()).thenResolve(undefined);

            await setApiToken();

            verifyNoInputBox();
        });

        test('asks to open a folder when there is neither a file nor a workspace folder', async () => {
            when(win().activeTextEditor).thenReturn(undefined);
            when(wsp().workspaceFolders).thenReturn(undefined);

            await setApiToken();

            verifyError(DeepnoteCloud.openFolderFirst);
            verifyNoInputBox();
        });

        test('refuses a workspace folder that is not a local folder', async () => {
            when(win().activeTextEditor).thenReturn(undefined);
            when(wsp().workspaceFolders).thenReturn([
                { uri: Uri.parse('vscode-vfs://github/o/r'), name: 'r', index: 0 }
            ]);

            await setApiToken();

            verifyError(DeepnoteCloud.localFilesOnly);
            verifyNoInputBox();
        });

        test('stores nothing when the prompt is cancelled or blank', async () => {
            enterToken(undefined);
            await setApiToken();
            enterToken('   ');
            await setApiToken();

            assert.isTrue(service.fetchWorkspaceStub.notCalled);
            verifyNothingStored();
        });

        test('trims the token before checking and saving it', async () => {
            enterToken('  padded  ');

            await setApiToken();

            assert.strictEqual(service.fetchWorkspaceStub.lastCall.args[1], 'padded');
            assertOnlyStored(DEFAULT_API, 'padded');
        });

        test('asks the input box for a masked prompt that rejects whitespace, quotes, # and control characters', async () => {
            await setApiToken();

            const { validateInput, ...options } = inputBoxOptions();
            assert.deepStrictEqual(options, {
                password: true,
                ignoreFocusOut: true,
                prompt: DeepnoteCloud.apiTokenPrompt,
                placeHolder: DeepnoteCloud.apiTokenPlaceholder
            });
            for (const invalid of ['a b', 'a"b', "a'b", 'a#b', 'a\tb', 'a\u0000b', 'a\u007fb']) {
                assert.strictEqual(
                    validateInput!(invalid),
                    DeepnoteCloud.apiTokenInvalidCharacters,
                    JSON.stringify(invalid)
                );
            }
            assert.isUndefined(validateInput!('abc-123_XYZ.='));
            assert.isUndefined(validateInput!('  abc  '));
        });

        test('stores nothing and says so when Deepnote rejects the token with 401', async () => {
            service.fetchWorkspaceStub.rejects(new ApiError(401, 'Unauthorized'));

            await setApiToken();

            verifyNothingStored();
            verifyError(DeepnoteCloud.apiTokenRejected);
        });

        test('stores nothing and shows the reason when the check fails with 403', async () => {
            service.fetchWorkspaceStub.rejects(new ApiError(403, 'Failed to fetch Deepnote workspace: HTTP 403'));

            await setApiToken();

            verifyNothingStored();
            verifyError(DeepnoteCloud.apiTokenCheckFailed('Failed to fetch Deepnote workspace: HTTP 403'));
        });

        test('stops for an untrusted workspace before any prompt, read, storage access or request', async () => {
            when(wsp().isTrusted).thenReturn(false);
            const read = sandbox.spy(fs.promises, 'readFile');

            await setApiToken();

            verifyError(DeepnoteCloud.workspaceNotTrusted);
            verifyNoInputBox();
            verifyNoStorageAccess();
            assert.isTrue(service.fetchWorkspaceStub.notCalled);
            assert.isTrue(read.notCalled);
        });
    });

    suite('Clear API Token', () => {
        setup(() => {
            activeFile(path.join(ws, 'sync', 'P', 'nb.deepnote'));
        });

        test('removes only the token saved for the Deepnote host of the active file', async () => {
            setDomain(path.join(ws, 'sync', 'P'), 'picked.test');
            seedToken(PICKED_API, 'picked');
            seedToken(DEFAULT_API, 'default');

            await clearApiToken();

            assertOnlyStored(DEFAULT_API, 'default');
            verify(win().showInformationMessage(DeepnoteCloud.apiTokenCleared)).once();
            verify(win().showErrorMessage(anything())).never();
        });

        test('says so when no token is saved', async () => {
            await clearApiToken();

            verify(win().showInformationMessage(DeepnoteCloud.noApiTokenFound)).once();
            verify(win().showInformationMessage(DeepnoteCloud.apiTokenCleared)).never();
            verifyNothingStored();
        });

        test('reports a removal that fails instead of confirming it', async () => {
            const keyring = new Map<string, string>();
            const context = {
                subscriptions: [],
                extensionMode: ExtensionMode.Production,
                secrets: {
                    get: async (key: string) => keyring.get(key),
                    store: async (key: string, value: string) => {
                        keyring.set(key, value);
                    },
                    delete: async () => {
                        throw new Error('keyring locked');
                    }
                }
            } as unknown as IExtensionContext;
            const realStorage = new EncryptedStorage(context);
            await realStorage.store('deepnote-api-token', DEFAULT_API, 'saved');
            const failing = new TestableService(context, realStorage);
            failing.activate();

            await clearApiToken();

            verifyError(DeepnoteCloud.apiTokenClearFailed);
            verify(win().showInformationMessage(DeepnoteCloud.apiTokenCleared)).never();
        });

        test('warns, and leaves the file unchanged, when a .env on the path still sets the token', async () => {
            const content = 'A=1\nDEEPNOTE_TOKEN=t\n';
            await writeFile(path.join(ws, 'sync', '.env'), content);
            seedToken(DEFAULT_API, 'saved');

            await clearApiToken();

            assert.strictEqual(secrets.size, 0);
            verify(win().showInformationMessage(DeepnoteCloud.apiTokenCleared)).once();
            verify(win().showWarningMessage(DeepnoteCloud.apiTokenStillInEnv(path.join('sync', '.env')))).once();
            assert.strictEqual(await readFile(path.join(ws, 'sync', '.env')), content);
        });

        test('warns about a .env that sets the token even when none is saved', async () => {
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=t\n');

            await clearApiToken();

            verify(win().showInformationMessage(DeepnoteCloud.noApiTokenFound)).once();
            verify(win().showWarningMessage(DeepnoteCloud.apiTokenStillInEnv('.env'))).once();
        });

        test('does not warn about a .env above the sync root', async () => {
            await createSyncManifest(path.join(ws, 'sync'));
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=t\n');
            seedToken(DEFAULT_API, 'saved');

            await clearApiToken();

            verify(win().showWarningMessage(anything())).never();
        });

        test('removes the token saved for the workspace folder when no file is open', async () => {
            when(win().activeTextEditor).thenReturn(undefined);
            setDomain(ws, 'picked.test');
            seedToken(PICKED_API, 'picked');

            await clearApiToken();

            assert.strictEqual(secrets.size, 0);
            verify(win().showInformationMessage(DeepnoteCloud.apiTokenCleared)).once();
        });

        test('does nothing but tell the user in an untrusted workspace', async () => {
            seedToken(DEFAULT_API, 'saved');
            when(wsp().isTrusted).thenReturn(false);

            await clearApiToken();

            assertOnlyStored(DEFAULT_API, 'saved');
            verifyError(DeepnoteCloud.workspaceNotTrusted);
            verifyNoStorageAccess();
        });
    });
});
