import type { Workspace } from '@deepnote/cloud';
import { ApiError, findSyncManifestRoot } from '@deepnote/cloud-sync';
import { assert } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as sinon from 'sinon';
import { anything, capture, deepEqual, instance, mock, verify, when } from 'ts-mockito';
import { Extension, ExtensionKind, InputBoxOptions, Uri, WorkspaceFolder } from 'vscode';

import { Commands, NotebookCellScheme } from '../../../platform/common/constants';
import { IExtensionContext } from '../../../platform/common/types';
import { DeepnoteCloud } from '../../../platform/common/utils/localize';
import * as path from '../../../platform/vscode-path/path';
import { extUriBiasedIgnorePathCase, extUriIgnorePathCase } from '../../../platform/vscode-path/resources';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { DeepnoteApiTokenService } from './deepnoteApiTokenService.node';

class TestableService extends DeepnoteApiTokenService {
    public readonly fetchWorkspaceStub = sinon.stub<[string, string], Promise<Workspace | undefined>>();
    public readonly isIgnoredByGitStub = sinon.stub<[Uri], Promise<boolean | undefined>>();

    protected override fetchWorkspace(baseUrl: string, token: string): Promise<Workspace | undefined> {
        return this.fetchWorkspaceStub(baseUrl, token);
    }

    protected override isIgnoredByGit(envUri: Uri): Promise<boolean | undefined> {
        return this.isIgnoredByGitStub(envUri);
    }
}

class GitProbe extends DeepnoteApiTokenService {
    public isIgnored(envUri: Uri): Promise<boolean | undefined> {
        return this.isIgnoredByGit(envUri);
    }
}

suite('DeepnoteApiTokenService', () => {
    let tmp: string;
    let ws: string;
    let service: TestableService;
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

    function exists(file: string): Promise<boolean> {
        return fs.promises.access(file).then(
            () => true,
            () => false
        );
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

    function verifyError(message: string): void {
        verify(win().showErrorMessage(message)).once();
    }

    function verifyNoInputBox(): void {
        verify(win().showInputBox(anything())).never();
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
            'A .deepnote-sync.json above the temp dir would redirect token writes outside it'
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

        service = new TestableService({ subscriptions: [] } as unknown as IExtensionContext);
        service.fetchWorkspaceStub.resolves({ id: 'w1', name: 'Acme' });
        service.isIgnoredByGitStub.resolves(true);
        service.activate();
    });

    teardown(async () => {
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

        test('stops at the workspace folder root when the sync root is below it', async () => {
            const syncRoot = path.join(ws, 'sync');
            await createSyncManifest(syncRoot);
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=at-workspace\n');
            await writeFile(path.join(tmp, '.env'), 'DEEPNOTE_TOKEN=above-everything\n');

            assert.strictEqual(
                await service.getToken(Uri.file(path.join(syncRoot, 'P', 'nb.deepnote'))),
                'at-workspace'
            );
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

        test('reads up to a workspace folder matched in another path case, past a sync root below it', async () => {
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
            await createSyncManifest(path.join(ws, 'sync'));
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=at-workspace\n');

            assert.strictEqual(
                await service.getToken(Uri.file(path.join(ws, 'sync', 'P', 'nb.deepnote'))),
                'at-workspace'
            );
        });

        test('resolves undefined for a non-file URI without touching the disk', async () => {
            const stat = sandbox.spy(fs.promises, 'stat');
            const read = sandbox.spy(fs.promises, 'readFile');

            assert.isUndefined(await service.getToken(Uri.parse('vscode-vfs://github/o/r/nb.deepnote')));
            assert.isTrue(stat.notCalled);
            assert.isTrue(read.notCalled);
        });

        test('resolves undefined in an untrusted workspace without reading a file', async () => {
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=t\n');
            when(wsp().isTrusted).thenReturn(false);
            const read = sandbox.spy(fs.promises, 'readFile');

            assert.isUndefined(await service.getToken(Uri.file(path.join(ws, 'nb.deepnote'))));
            assert.isTrue(read.notCalled);
        });

        test('reads the last real assignment, not one inside a quoted multi-line value', async () => {
            await writeFile(
                path.join(ws, '.env'),
                'CERT="-----BEGIN\nDEEPNOTE_TOKEN=fake\n-----END"\nDEEPNOTE_TOKEN=real\n'
            );

            assert.strictEqual(await service.getToken(Uri.file(path.join(ws, 'nb.deepnote'))), 'real');
        });
    });

    suite('getOrPromptToken', () => {
        const notebook = () => Uri.file(path.join(ws, 'a', 'nb.deepnote'));

        test('returns the stored token without prompting', async () => {
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=stored\n');

            assert.strictEqual(await service.getOrPromptToken(notebook()), 'stored');
            verifyNoInputBox();
        });

        test('prompts, saves and returns a new token when none is stored', async () => {
            enterToken('fresh');

            assert.strictEqual(await service.getOrPromptToken(notebook()), 'fresh');
            assert.strictEqual(await readFile(path.join(ws, '.env')), 'DEEPNOTE_TOKEN=fresh\n');
        });

        test('resolves undefined and writes nothing when the prompt is cancelled', async () => {
            enterToken(undefined);

            assert.isUndefined(await service.getOrPromptToken(notebook()));
            assert.isFalse(await exists(path.join(ws, '.env')));
            assert.isTrue(service.fetchWorkspaceStub.notCalled);
        });

        test('tells the user about local files and does not prompt for a non-file URI', async () => {
            assert.isUndefined(await service.getOrPromptToken(Uri.parse('vscode-vfs://github/o/r/nb.deepnote')));

            verifyError(DeepnoteCloud.localFilesOnly);
            verifyNoInputBox();
        });

        test('tells the user to trust the workspace and does not prompt when untrusted', async () => {
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=t\n');
            when(wsp().isTrusted).thenReturn(false);

            assert.isUndefined(await service.getOrPromptToken(notebook()));

            verifyError(DeepnoteCloud.workspaceNotTrusted);
            verifyNoInputBox();
        });
    });

    suite('Set API Token', () => {
        const NEW_TOKEN = 'new';

        setup(() => {
            activeFile(path.join(ws, 'a', 'b', 'nb.deepnote'));
            enterToken(NEW_TOKEN);
        });

        test('creates the .env at the workspace root and names the Deepnote workspace', async () => {
            await setApiToken();

            assert.strictEqual(await readFile(path.join(ws, '.env')), 'DEEPNOTE_TOKEN=new\n');
            verify(win().showInformationMessage(DeepnoteCloud.apiTokenSavedForWorkspace('Acme', '.env'))).once();
        });

        test('confirms without a workspace name when the API returns none', async () => {
            service.fetchWorkspaceStub.resolves(undefined);

            await setApiToken();

            verify(win().showInformationMessage(DeepnoteCloud.apiTokenSaved('.env'))).once();
        });

        test('checks the token against the API of the configured domain', async () => {
            await setApiToken();
            assert.deepStrictEqual(service.fetchWorkspaceStub.lastCall.args, ['https://api.deepnote.com', NEW_TOKEN]);

            const notebookUri = Uri.file(path.join(ws, 'a', 'b', 'nb.deepnote')).toString();
            when(wsp().getConfiguration('deepnote', anything())).thenCall((_section: string, resource?: Uri) => ({
                get: (key: string, fallback: unknown) =>
                    key === 'domain' && resource?.toString() === notebookUri ? 'example.test' : fallback
            }));
            await setApiToken();
            assert.deepStrictEqual(service.fetchWorkspaceStub.lastCall.args, ['https://api.example.test', NEW_TOKEN]);
        });

        test('replaces the first assignment, drops the others, and keeps every other line', async () => {
            await writeFile(path.join(ws, '.env'), 'A=1\nexport DEEPNOTE_TOKEN=old\nB=2\nDEEPNOTE_TOKEN=older\n');

            await setApiToken();

            assert.strictEqual(await readFile(path.join(ws, '.env')), 'A=1\nDEEPNOTE_TOKEN=new\nB=2\n');
        });

        test('keeps CRLF line endings', async () => {
            await writeFile(path.join(ws, '.env'), 'A=1\r\nDEEPNOTE_TOKEN=old\r\n');

            await setApiToken();

            assert.strictEqual(await readFile(path.join(ws, '.env')), 'A=1\r\nDEEPNOTE_TOKEN=new\r\n');
        });

        test('appends after a last line that has no line ending', async () => {
            await writeFile(path.join(ws, '.env'), 'A=1');

            await setApiToken();

            assert.strictEqual(await readFile(path.join(ws, '.env')), 'A=1\nDEEPNOTE_TOKEN=new\n');
        });

        test('rewrites the nearest .env that already assigns the token, not the workspace root', async () => {
            await writeFile(path.join(ws, 'a', 'b', '.env'), 'A=1\nDEEPNOTE_TOKEN: old\n');

            await setApiToken();

            assert.strictEqual(await readFile(path.join(ws, 'a', 'b', '.env')), 'A=1\nDEEPNOTE_TOKEN=new\n');
            assert.isFalse(await exists(path.join(ws, '.env')));
        });

        test('rewrites an .env that assigns an empty token', async () => {
            await writeFile(path.join(ws, 'a', '.env'), 'DEEPNOTE_TOKEN=\n');

            await setApiToken();

            assert.strictEqual(await readFile(path.join(ws, 'a', '.env')), 'DEEPNOTE_TOKEN=new\n');
            assert.isFalse(await exists(path.join(ws, '.env')));
        });

        test('writes to the sync root, not a folder in between, when no .env assigns the token', async () => {
            const project = path.join(ws, 'sync', 'P');
            await createSyncManifest(path.join(ws, 'sync'));
            await writeFile(path.join(project, 'nb.deepnote'), '');
            activeFile(path.join(project, 'nb.deepnote'));

            await setApiToken();

            assert.strictEqual(await readFile(path.join(ws, 'sync', '.env')), 'DEEPNOTE_TOKEN=new\n');
            assert.isFalse(await exists(path.join(project, '.env')));
            assert.isFalse(await exists(path.join(ws, '.env')));
        });

        test('rewrites the .env next to the file even when a sync root is above it', async () => {
            const project = path.join(ws, 'sync', 'P');
            await createSyncManifest(path.join(ws, 'sync'));
            await writeFile(path.join(project, '.env'), 'DEEPNOTE_TOKEN=stale');
            activeFile(path.join(project, 'nb.deepnote'));

            await setApiToken();

            assert.strictEqual(await readFile(path.join(project, '.env')), 'DEEPNOTE_TOKEN=new\n');
            assert.isFalse(await exists(path.join(ws, 'sync', '.env')));
        });

        test('writes to the workspace root when the sync manifest is a symbolic link', async () => {
            const project = path.join(ws, 'sync', 'P');
            await fs.promises.mkdir(project, { recursive: true });
            await writeFile(path.join(tmp, 'real-manifest.json'), '{}');
            await fs.promises.symlink(
                path.join(tmp, 'real-manifest.json'),
                path.join(ws, 'sync', '.deepnote-sync.json')
            );
            activeFile(path.join(project, 'nb.deepnote'));

            await setApiToken();

            assert.strictEqual(await readFile(path.join(ws, '.env')), 'DEEPNOTE_TOKEN=new\n');
            assert.isFalse(await exists(path.join(ws, 'sync', '.env')));
        });

        test('rewrites only the nearest of several .env files that assign the token', async () => {
            await writeFile(path.join(ws, 'a', 'b', '.env'), 'DEEPNOTE_TOKEN=old\n');
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=root\n');

            await setApiToken();

            assert.strictEqual(await readFile(path.join(ws, 'a', 'b', '.env')), 'DEEPNOTE_TOKEN=new\n');
            assert.strictEqual(await readFile(path.join(ws, '.env')), 'DEEPNOTE_TOKEN=root\n');
        });

        test('keeps a variable whose name only starts with DEEPNOTE_TOKEN', async () => {
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN_BACKUP=keep\nDEEPNOTE_TOKEN=old\n');

            await setApiToken();

            assert.strictEqual(
                await readFile(path.join(ws, '.env')),
                'DEEPNOTE_TOKEN_BACKUP=keep\nDEEPNOTE_TOKEN=new\n'
            );
        });

        test('replaces a first-line assignment after a UTF-8 byte order mark and keeps the mark', async () => {
            await writeFile(path.join(ws, '.env'), '\uFEFFDEEPNOTE_TOKEN=old\nB=2\n');

            await setApiToken();

            assert.strictEqual(await readFile(path.join(ws, '.env')), '\uFEFFDEEPNOTE_TOKEN=new\nB=2\n');
        });

        test('leaves an .env that is not UTF-8 byte-for-byte unchanged', async () => {
            const latin1 = Buffer.from('DB_PASSWORD=p\xe4ss\nDEEPNOTE_TOKEN=old\n', 'latin1');
            await fs.promises.writeFile(path.join(ws, '.env'), latin1);

            await setApiToken();

            assert.deepStrictEqual(await fs.promises.readFile(path.join(ws, '.env')), latin1);
            verifyError(DeepnoteCloud.envEditFailed('.env'));
            verify(win().showInformationMessage(anything())).never();
        });

        test('does not overwrite an .env it cannot read with just the token', async () => {
            const content = 'A=1\nDEEPNOTE_TOKEN=old\n';
            await writeFile(path.join(ws, '.env'), content);
            const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
            sandbox.stub(fs.promises, 'readFile').rejects(denied);
            const write = sandbox.spy(fs.promises, 'writeFile');

            await setApiToken();

            sandbox.restore();
            assert.isTrue(write.notCalled);
            assert.strictEqual(await readFile(path.join(ws, '.env')), content);
            verifyError(DeepnoteCloud.envEditFailed('.env'));
        });

        test('does not overwrite an .env above a workspace folder that is missing on disk', async () => {
            const missing = path.join(tmp, 'projects', 'foo');
            openWorkspaceFolder(missing);
            when(win().activeTextEditor).thenReturn(undefined);
            await writeFile(path.join(tmp, 'projects', '.env'), 'DEEPNOTE_TOKEN=other-project\n');

            await setApiToken();

            assert.strictEqual(await readFile(path.join(tmp, 'projects', '.env')), 'DEEPNOTE_TOKEN=other-project\n');
        });

        test('keeps a workspace name from the API from forming a command link in the confirmation', async () => {
            service.fetchWorkspaceStub.resolves({ id: 'w1', name: 'X [y](command:foo) [z](command:bar)' });

            await setApiToken();

            verify(
                win().showInformationMessage(
                    DeepnoteCloud.apiTokenSavedForWorkspace('X [y] (command:foo) [z] (command:bar)', '.env')
                )
            ).once();
        });

        test('shows a workspace name with ordinary brackets and parentheses unchanged', async () => {
            service.fetchWorkspaceStub.resolves({ id: 'w1', name: 'Acme [EU] (prod)' });

            await setApiToken();

            verify(
                win().showInformationMessage(DeepnoteCloud.apiTokenSavedForWorkspace('Acme [EU] (prod)', '.env'))
            ).once();
        });

        test('uses the command argument over the active editor', async () => {
            await writeFile(path.join(ws, 'other', '.env'), 'DEEPNOTE_TOKEN=old\n');
            await writeFile(path.join(ws, 'a', 'b', '.env'), 'DEEPNOTE_TOKEN=untouched\n');

            await setApiToken(Uri.file(path.join(ws, 'other', 'nb.deepnote')));

            assert.strictEqual(await readFile(path.join(ws, 'other', '.env')), 'DEEPNOTE_TOKEN=new\n');
            assert.strictEqual(await readFile(path.join(ws, 'a', 'b', '.env')), 'DEEPNOTE_TOKEN=untouched\n');
        });

        test('starts from the active notebook, ignoring its query and fragment', async () => {
            when(win().activeTextEditor).thenReturn(undefined);
            when(win().activeNotebookEditor).thenReturn({
                notebook: { uri: Uri.file(path.join(ws, 'n', 'nb.deepnote')).with({ query: 'id=1', fragment: 'x' }) }
            } as any);
            await writeFile(path.join(ws, 'n', '.env'), 'DEEPNOTE_TOKEN=old\n');

            await setApiToken();

            assert.strictEqual(await readFile(path.join(ws, 'n', '.env')), 'DEEPNOTE_TOKEN=new\n');
        });

        test('starts from the active notebook, not the focused cell editor inside it', async () => {
            const notebookUri = Uri.file(path.join(ws, 'n', 'nb.deepnote')).with({ query: 'id=1' });
            when(win().activeNotebookEditor).thenReturn({ notebook: { uri: notebookUri } } as any);
            when(win().activeTextEditor).thenReturn({
                document: { uri: notebookUri.with({ scheme: NotebookCellScheme, fragment: 'cell-1' }) }
            } as any);
            await writeFile(path.join(ws, 'n', '.env'), 'DEEPNOTE_TOKEN=old\n');

            await setApiToken();

            assert.strictEqual(await readFile(path.join(ws, 'n', '.env')), 'DEEPNOTE_TOKEN=new\n');
            assert.isFalse(await exists(path.join(ws, '.env')));
        });

        test('falls back to the only workspace folder when no file is open', async () => {
            when(win().activeTextEditor).thenReturn(undefined);

            await setApiToken();

            assert.strictEqual(await readFile(path.join(ws, '.env')), 'DEEPNOTE_TOKEN=new\n');
        });

        test('falls back to the workspace folder when the active file is not a local file', async () => {
            when(win().activeTextEditor).thenReturn({ document: { uri: Uri.parse('untitled:Untitled-1') } } as any);

            await setApiToken();

            assert.strictEqual(await readFile(path.join(ws, '.env')), 'DEEPNOTE_TOKEN=new\n');
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

            await setApiToken();

            assert.strictEqual(await readFile(path.join(second, '.env')), 'DEEPNOTE_TOKEN=new\n');
            assert.isFalse(await exists(path.join(ws, '.env')));
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

        test('writes nothing when the prompt is cancelled or blank', async () => {
            enterToken(undefined);
            await setApiToken();
            enterToken('   ');
            await setApiToken();

            assert.isTrue(service.fetchWorkspaceStub.notCalled);
            assert.isFalse(await exists(path.join(ws, '.env')));
        });

        test('trims the token before checking and saving it', async () => {
            enterToken('  padded  ');

            await setApiToken();

            assert.strictEqual(service.fetchWorkspaceStub.lastCall.args[1], 'padded');
            assert.strictEqual(await readFile(path.join(ws, '.env')), 'DEEPNOTE_TOKEN=padded\n');
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

        test('writes nothing and says so when Deepnote rejects the token with 401', async () => {
            service.fetchWorkspaceStub.rejects(new ApiError(401, 'Unauthorized'));

            await setApiToken();

            assert.isFalse(await exists(path.join(ws, '.env')));
            verifyError(DeepnoteCloud.apiTokenRejected);
        });

        test('writes nothing and shows the reason when the check fails with 403', async () => {
            service.fetchWorkspaceStub.rejects(new ApiError(403, 'Failed to fetch Deepnote workspace: HTTP 403'));

            await setApiToken();

            assert.isFalse(await exists(path.join(ws, '.env')));
            verifyError(DeepnoteCloud.apiTokenCheckFailed('Failed to fetch Deepnote workspace: HTTP 403'));
        });

        test('writes nothing and shows the reason when the check fails for any other reason', async () => {
            service.fetchWorkspaceStub.rejects(new Error('fetch failed'));

            await setApiToken();

            assert.isFalse(await exists(path.join(ws, '.env')));
            verifyError(DeepnoteCloud.apiTokenCheckFailed('fetch failed'));
        });

        test('leaves an .env byte-for-byte unchanged when the edit would corrupt another variable', async () => {
            const content = 'CERT="-----BEGIN\nDEEPNOTE_TOKEN=fake\n-----END"\nDEEPNOTE_TOKEN=real\n';
            await writeFile(path.join(ws, '.env'), content);

            await setApiToken();

            assert.strictEqual(await readFile(path.join(ws, '.env')), content);
            verifyError(DeepnoteCloud.envEditFailed('.env'));
            verify(win().showInformationMessage(anything())).never();
        });

        test('leaves the file unchanged when the token would not read back as typed', async () => {
            enterToken('`quoted`');
            await writeFile(path.join(ws, '.env'), 'A=1\n');

            await setApiToken();

            assert.strictEqual(await readFile(path.join(ws, '.env')), 'A=1\n');
            verifyError(DeepnoteCloud.envEditFailed('.env'));
        });

        test('reports a .env it cannot read or write instead of throwing', async () => {
            await fs.promises.mkdir(path.join(ws, '.env'));

            await setApiToken();

            verifyError(DeepnoteCloud.envEditFailed('.env'));
            verify(win().showInformationMessage(anything())).never();
        });

        test('stops for an untrusted workspace before any prompt, read, write or request', async () => {
            when(wsp().isTrusted).thenReturn(false);
            const read = sandbox.spy(fs.promises, 'readFile');
            const write = sandbox.spy(fs.promises, 'writeFile');

            await setApiToken();

            verifyError(DeepnoteCloud.workspaceNotTrusted);
            verifyNoInputBox();
            assert.isTrue(service.fetchWorkspaceStub.notCalled);
            assert.isTrue(read.notCalled);
            assert.isTrue(write.notCalled);
        });

        suite('.gitignore offer', () => {
            const offerAccepted = () =>
                when(win().showWarningMessage(anything(), anything(), anything())).thenResolve(
                    DeepnoteCloud.addToGitignore as any
                );

            test('adds .env to a new .gitignore next to the written .env when git does not ignore it', async () => {
                service.isIgnoredByGitStub.resolves(false);
                offerAccepted();

                await setApiToken();

                verify(
                    win().showWarningMessage(
                        DeepnoteCloud.envNotIgnored('.env'),
                        deepEqual({ modal: true }),
                        DeepnoteCloud.addToGitignore
                    )
                ).once();
                assert.strictEqual(await readFile(path.join(ws, '.gitignore')), '.env\n');
            });

            test('appends to an existing .gitignore using its line endings', async () => {
                service.isIgnoredByGitStub.resolves(false);
                offerAccepted();
                await writeFile(path.join(ws, '.gitignore'), 'node_modules\r\nout');

                await setApiToken();

                assert.strictEqual(await readFile(path.join(ws, '.gitignore')), 'node_modules\r\nout\r\n.env\r\n');
            });

            test('puts the .gitignore in the folder of an .env found below the workspace root', async () => {
                service.isIgnoredByGitStub.resolves(false);
                offerAccepted();
                await writeFile(path.join(ws, 'a', 'b', '.env'), 'DEEPNOTE_TOKEN=old\n');

                await setApiToken();

                assert.strictEqual(await readFile(path.join(ws, 'a', 'b', '.gitignore')), '.env\n');
                assert.isFalse(await exists(path.join(ws, '.gitignore')));
            });

            test('leaves .gitignore alone when the offer is dismissed', async () => {
                service.isIgnoredByGitStub.resolves(false);

                await setApiToken();

                assert.isFalse(await exists(path.join(ws, '.gitignore')));
                assert.strictEqual(await readFile(path.join(ws, '.env')), 'DEEPNOTE_TOKEN=new\n');
            });

            test('appends .env to a .gitignore that is not UTF-8 and keeps its other bytes', async () => {
                service.isIgnoredByGitStub.resolves(false);
                offerAccepted();
                const latin1 = Buffer.from('# \xdc \xe9 docs\nnode_modules\n', 'latin1');
                await fs.promises.writeFile(path.join(ws, '.gitignore'), latin1);

                await setApiToken();

                assert.deepStrictEqual(
                    await fs.promises.readFile(path.join(ws, '.gitignore')),
                    Buffer.concat([latin1, Buffer.from('.env\n')])
                );
                verify(win().showInformationMessage(DeepnoteCloud.apiTokenSavedForWorkspace('Acme', '.env'))).once();
            });

            test('shows no offer when git already ignores the file', async () => {
                service.isIgnoredByGitStub.resolves(true);

                await setApiToken();

                verify(win().showWarningMessage(anything(), anything(), anything())).never();
            });

            test('shows no offer, and still confirms, when the Git extension gives no answer', async () => {
                service.isIgnoredByGitStub.resolves(undefined);

                await setApiToken();

                verify(win().showWarningMessage(anything(), anything(), anything())).never();
                verify(win().showInformationMessage(DeepnoteCloud.apiTokenSavedForWorkspace('Acme', '.env'))).once();
            });

            test('still confirms when the .gitignore cannot be written', async () => {
                service.isIgnoredByGitStub.resolves(false);
                offerAccepted();
                await fs.promises.mkdir(path.join(ws, '.gitignore'));

                await setApiToken();

                verify(win().showInformationMessage(DeepnoteCloud.apiTokenSavedForWorkspace('Acme', '.env'))).once();
            });

            test('asks the Git extension about the written file', async () => {
                await setApiToken();

                assert.strictEqual(
                    service.isIgnoredByGitStub.lastCall.args[0].fsPath,
                    Uri.file(path.join(ws, '.env')).fsPath
                );
            });
        });
    });

    suite('Clear API Token', () => {
        setup(() => {
            activeFile(path.join(ws, 'sync', 'P', 'nb.deepnote'));
        });

        test('removes the assignment from every .env on the path and keeps the other lines', async () => {
            await createSyncManifest(path.join(ws, 'sync'));
            await writeFile(path.join(ws, 'sync', 'P', '.env'), 'A=1\nDEEPNOTE_TOKEN=near\nB=2\n');
            await writeFile(path.join(ws, '.env'), 'export DEEPNOTE_TOKEN=root\nC=3\n');

            await clearApiToken();

            assert.strictEqual(await readFile(path.join(ws, 'sync', 'P', '.env')), 'A=1\nB=2\n');
            assert.strictEqual(await readFile(path.join(ws, '.env')), 'C=3\n');
            assert.isUndefined(await service.getToken(Uri.file(path.join(ws, 'sync', 'P', 'nb.deepnote'))));
            verify(win().showInformationMessage(DeepnoteCloud.apiTokenCleared)).once();
        });

        test('clears the `KEY: value` form', async () => {
            await writeFile(path.join(ws, 'sync', 'P', '.env'), 'A=1\nDEEPNOTE_TOKEN: old\n');

            await clearApiToken();

            assert.strictEqual(await readFile(path.join(ws, 'sync', 'P', '.env')), 'A=1\n');
            assert.isUndefined(await service.getToken(Uri.file(path.join(ws, 'sync', 'P', 'nb.deepnote'))));
            verify(win().showInformationMessage(DeepnoteCloud.apiTokenCleared)).once();
        });

        test('keeps CRLF line endings', async () => {
            await writeFile(path.join(ws, '.env'), 'A=1\r\nDEEPNOTE_TOKEN=t\r\nB=2\r\n');

            await clearApiToken();

            assert.strictEqual(await readFile(path.join(ws, '.env')), 'A=1\r\nB=2\r\n');
        });

        test('never deletes a file, even when nothing else is left in it', async () => {
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=t\n');

            await clearApiToken();

            assert.strictEqual(await readFile(path.join(ws, '.env')), '');
        });

        test('says so when no .env assigns the token', async () => {
            await writeFile(path.join(ws, '.env'), 'A=1\n');

            await clearApiToken();

            assert.strictEqual(await readFile(path.join(ws, '.env')), 'A=1\n');
            verify(win().showInformationMessage(DeepnoteCloud.noApiTokenFound)).once();
            verify(win().showInformationMessage(DeepnoteCloud.apiTokenCleared)).never();
        });

        test('leaves an .env it cannot edit safely unchanged and names it', async () => {
            const content = 'CERT="-----BEGIN\nDEEPNOTE_TOKEN=fake\n-----END"\nDEEPNOTE_TOKEN=real\n';
            await writeFile(path.join(ws, '.env'), content);

            await clearApiToken();

            assert.strictEqual(await readFile(path.join(ws, '.env')), content);
            verifyError(DeepnoteCloud.envEditFailed('.env'));
            verify(win().showInformationMessage(DeepnoteCloud.apiTokenCleared)).never();
        });

        test('carries on with the next .env after one it cannot edit, and past a later one', async () => {
            // Clear visits .env files nearest first: a failure before the editable file checks that it carries on, and
            // one after it checks that the later failure does not hide the earlier success.
            const unsafe = 'CERT="-----BEGIN\nDEEPNOTE_TOKEN=fake\n-----END"\nDEEPNOTE_TOKEN=real\n';
            await writeFile(path.join(ws, 'sync', 'P', '.env'), unsafe);
            await writeFile(path.join(ws, 'sync', '.env'), 'A=1\nDEEPNOTE_TOKEN=mid\n');
            await writeFile(path.join(ws, '.env'), unsafe);

            await clearApiToken();

            assert.strictEqual(await readFile(path.join(ws, 'sync', 'P', '.env')), unsafe);
            assert.strictEqual(await readFile(path.join(ws, 'sync', '.env')), 'A=1\n');
            assert.strictEqual(await readFile(path.join(ws, '.env')), unsafe);
            verifyError(DeepnoteCloud.envEditFailed(path.join('sync', 'P', '.env')));
            verifyError(DeepnoteCloud.envEditFailed('.env'));
            verify(win().showInformationMessage(DeepnoteCloud.apiTokenCleared)).once();
        });

        test('keeps a variable whose name only starts with DEEPNOTE_TOKEN', async () => {
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN_BACKUP=keep\nDEEPNOTE_TOKEN=old\n');

            await clearApiToken();

            assert.strictEqual(await readFile(path.join(ws, '.env')), 'DEEPNOTE_TOKEN_BACKUP=keep\n');
        });

        test('clears a first-line assignment after a UTF-8 byte order mark and keeps the mark', async () => {
            await writeFile(path.join(ws, '.env'), '\uFEFFDEEPNOTE_TOKEN=t\nA=1\n');

            await clearApiToken();

            assert.strictEqual(await readFile(path.join(ws, '.env')), '\uFEFFA=1\n');
            verify(win().showInformationMessage(DeepnoteCloud.apiTokenCleared)).once();
        });

        test('leaves an .env that is not UTF-8 byte-for-byte unchanged and names it', async () => {
            const latin1 = Buffer.from('DB_PASSWORD=p\xe4ss\nDEEPNOTE_TOKEN=old\n', 'latin1');
            await fs.promises.writeFile(path.join(ws, '.env'), latin1);

            await clearApiToken();

            assert.deepStrictEqual(await fs.promises.readFile(path.join(ws, '.env')), latin1);
            verifyError(DeepnoteCloud.envEditFailed('.env'));
            verify(win().showInformationMessage(DeepnoteCloud.apiTokenCleared)).never();
        });

        test('leaves an .env above a workspace folder that is missing on disk unchanged', async () => {
            const missing = path.join(tmp, 'projects', 'foo');
            openWorkspaceFolder(missing);
            when(win().activeTextEditor).thenReturn(undefined);
            await writeFile(path.join(tmp, 'projects', '.env'), 'DEEPNOTE_TOKEN=other-project\nA=1\n');

            await clearApiToken();

            assert.strictEqual(
                await readFile(path.join(tmp, 'projects', '.env')),
                'DEEPNOTE_TOKEN=other-project\nA=1\n'
            );
            verify(win().showInformationMessage(DeepnoteCloud.noApiTokenFound)).once();
        });

        test('leaves an .env above a workspace folder matched in another path case unchanged', async () => {
            when(wsp().getWorkspaceFolder(anything())).thenReturn({
                uri: Uri.file(path.join(tmp, 'WS')),
                name: 'WS',
                index: 0
            });
            await writeFile(path.join(tmp, '.env'), 'DEEPNOTE_TOKEN=above-workspace\n');

            await clearApiToken();

            assert.strictEqual(await readFile(path.join(tmp, '.env')), 'DEEPNOTE_TOKEN=above-workspace\n');
        });

        test('clears the .env of the workspace folder when no file is open', async () => {
            when(win().activeTextEditor).thenReturn(undefined);
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=t\nA=1\n');

            await clearApiToken();

            assert.strictEqual(await readFile(path.join(ws, '.env')), 'A=1\n');
        });

        test('does nothing but tell the user in an untrusted workspace', async () => {
            await writeFile(path.join(ws, '.env'), 'DEEPNOTE_TOKEN=t\n');
            when(wsp().isTrusted).thenReturn(false);

            await clearApiToken();

            assert.strictEqual(await readFile(path.join(ws, '.env')), 'DEEPNOTE_TOKEN=t\n');
            verifyError(DeepnoteCloud.workspaceNotTrusted);
        });
    });
});

suite('DeepnoteApiTokenService.isIgnoredByGit', () => {
    // A drive letter makes fsPath, which the service passes to git, differ from uri.path on every platform.
    const envUri = Uri.parse('file:///C:/repo/.env');
    const envPath = envUri.fsPath;
    let probe: GitProbe;

    // Like VS Code, reading the exports of an extension that is not active yet throws.
    function installGit(getAPI: () => unknown, isActive = true): void {
        const exports = { getAPI };
        let active = isActive;
        const extension: Extension<unknown> = {
            id: 'vscode.git',
            extensionUri: Uri.file('/git'),
            extensionPath: '/git',
            get isActive() {
                return active;
            },
            packageJSON: {},
            extensionKind: ExtensionKind.Workspace,
            get exports() {
                if (!active) {
                    throw new Error("Extension 'vscode.git' is not known or not activated");
                }

                return exports;
            },
            activate: () => {
                active = true;

                return Promise.resolve(exports);
            }
        };
        when(mockedVSCodeNamespaces.extensions.getExtension('vscode.git')).thenReturn(extension);
    }

    function apiIgnoring(ignoredPaths: string[]): () => unknown {
        return () => ({
            getRepository: () => ({
                checkIgnore: (paths: string[]) =>
                    Promise.resolve(new Set(paths.filter((candidate) => ignoredPaths.includes(candidate))))
            })
        });
    }

    setup(() => {
        resetVSCodeMocks();
        probe = new GitProbe(instance(mock<IExtensionContext>()));
    });

    test('is undefined when the Git extension is not installed', async () => {
        when(mockedVSCodeNamespaces.extensions.getExtension('vscode.git')).thenReturn(undefined);

        assert.isUndefined(await probe.isIgnored(envUri));
    });

    test('is undefined when the Git extension is not set up', async () => {
        installGit(() => {
            throw new Error('Git model not found');
        });

        assert.isUndefined(await probe.isIgnored(envUri));
    });

    test('is undefined outside an open repository and without checkIgnore', async () => {
        installGit(() => ({ getRepository: () => null }));
        assert.isUndefined(await probe.isIgnored(envUri));

        installGit(() => ({ getRepository: () => ({}) }));
        assert.isUndefined(await probe.isIgnored(envUri));
    });

    test('is true when git ignores the file and false when it does not', async () => {
        installGit(apiIgnoring([envPath]));
        assert.isTrue(await probe.isIgnored(envUri));

        installGit(apiIgnoring([]));
        assert.isFalse(await probe.isIgnored(envUri));
    });

    test('activates an inactive Git extension to get its API', async () => {
        installGit(apiIgnoring([envPath]), false);

        assert.isTrue(await probe.isIgnored(envUri));
    });
});
