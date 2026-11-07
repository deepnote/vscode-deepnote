import type { SyncProject } from '@deepnote/cloud';
import {
    findSyncManifestRoot,
    PublishDivergedError,
    PublishError,
    type ProjectSyncOutcome,
    type PublishAppOptions,
    type PublishAppResult,
    type WorkspaceSyncResult
} from '@deepnote/cloud-sync';
import { assert } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as sinon from 'sinon';
import { anything, capture, instance, mock, verify, when } from 'ts-mockito';
import { MessageItem, QuickPickItem, Uri, WorkspaceFolder } from 'vscode';

import { Commands } from '../../../platform/common/constants';
import { IExtensionContext } from '../../../platform/common/types';
import { createDeferred } from '../../../platform/common/utils/async';
import * as path from '../../../platform/vscode-path/path';
import { MockMemento } from '../../../test/mocks/mementos';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { DeepnoteCloudOperationLock } from './deepnoteCloudOperationLock';
import { PublishAppCommandHandler } from './publishAppCommandHandler.node';
import { IDeepnoteApiTokenService } from './types';

class TestableHandler extends PublishAppCommandHandler {
    public readonly listProjectsStub = sinon.stub<[string, string], Promise<SyncProject[]>>();
    public readonly runPublishAppStub = sinon.stub<[PublishAppOptions], Promise<PublishAppResult>>();

    protected override listProjects(baseUrl: string, token: string): Promise<SyncProject[]> {
        return this.listProjectsStub(baseUrl, token);
    }

    protected override runPublishApp(options: PublishAppOptions): Promise<PublishAppResult> {
        return this.runPublishAppStub(options);
    }
}

type Severity = 'Information' | 'Warning' | 'Error';
type Answer = string | undefined | (() => string | undefined);

const PROJECTS: SyncProject[] = [
    { id: 'p-ops', name: 'Ops', folder: null },
    {
        id: 'p-sales',
        name: 'Sales',
        folder: {
            id: 'f-q3',
            name: 'Q3',
            path: [
                { id: 'f-team', name: 'Team' },
                { id: 'f-q3', name: 'Q3' }
            ]
        }
    },
    { id: 'p-alpha', name: 'Alpha' }
];

const API_ACCESS_ON_DETAIL =
    'The app calls Deepnote with a 15-minute, viewer-scoped token that can read notebook inputs and start runs. Never your personal token.';
const CHOOSE_PROJECT = 'Choose the Deepnote project to publish to';
const CHOOSE_API_ACCESS = 'Should the app be able to call the Deepnote API?';
const DIVERGED = '1 app file(s) changed in Deepnote since the last sync: _deepnote_static/a.js';
const MISSED_APP_FILES =
    "The sync did not download Deepnote's changed app files for Sales, and nothing was published. Fix any errors or skipped conflicts the sync reported, then publish again and choose Sync First.";

function published(overrides: Partial<PublishAppResult> = {}): PublishAppResult {
    return {
        projectId: 'p',
        targetPath: '_deepnote_static',
        totalFiles: 1,
        uploaded: 1,
        pruned: 0,
        errors: [],
        mirrorUpdated: false,
        ...overrides
    };
}

suite('PublishAppCommandHandler', () => {
    let tmp: string;
    let appFolder: string;
    let syncedAppFolder: string;
    let handler: TestableHandler;
    let tokenService: IDeepnoteApiTokenService;
    let lock: DeepnoteCloudOperationLock;
    let workspaceState: MockMemento;
    let commandHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
    let shown: { severity: Severity; args: unknown[] }[];
    let answers: Map<string, Answer>;
    let picks: Map<string, string | undefined>;
    let quickPicks: { items: QuickPickItem[]; placeHolder: string }[];
    let syncResult: WorkspaceSyncResult | undefined;
    let syncTargets: unknown[];

    const win = () => mockedVSCodeNamespaces.window;

    function messages(severity: Severity): unknown[] {
        return shown.filter((message) => message.severity === severity).map((message) => message.args[0]);
    }

    function respond([message, ...items]: unknown[]): unknown {
        const answer = answers.get(message as string);
        const choice = typeof answer === 'function' ? answer() : answer;

        return items.find((item) => item === choice || (item as MessageItem | undefined)?.title === choice);
    }

    function quickPick(placeHolder: string): QuickPickItem[] {
        const found = quickPicks.find((entry) => entry.placeHolder === placeHolder);
        assert.isDefined(found, `no quick pick "${placeHolder}" was shown`);

        return found!.items;
    }

    function publishCalls(): PublishAppOptions[] {
        return handler.runPublishAppStub.getCalls().map((call) => call.args[0]);
    }

    function publish(folder?: string): Promise<unknown> {
        return commandHandlers.get(Commands.PublishApp)!(folder === undefined ? undefined : Uri.file(folder));
    }

    function saveSettings(folder: string, settings: { projectId: string; projectName: string; apiAccess: boolean }) {
        return workspaceState.update('deepnote.publishApp.folderSettings', { [Uri.file(folder).toString()]: settings });
    }

    function syncFirstWith(projects: ProjectSyncOutcome[], success = true): void {
        handler.runPublishAppStub
            .onFirstCall()
            .rejects(new PublishDivergedError(path.join(tmp, 'root'), ['_deepnote_static/a.js']));
        answers.set(DIVERGED, 'Sync First');
        syncResult = { success, root: path.join(tmp, 'root'), dryRun: false, projects, untrackedFiles: [] };
    }

    setup(async () => {
        resetVSCodeMocks();
        tmp = Uri.file(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deepnote-publish-'))).fsPath;
        assert.isUndefined(
            await findSyncManifestRoot(tmp),
            'A .deepnote-sync.json above the temp dir would make every folder synced'
        );
        appFolder = path.join(tmp, 'app');
        syncedAppFolder = path.join(tmp, 'root', 'Team', 'Sales', 'app');
        await fs.promises.mkdir(syncedAppFolder, { recursive: true });
        await fs.promises.writeFile(
            path.join(tmp, 'root', '.deepnote-sync.json'),
            JSON.stringify({ version: 1, projects: { p1: { dir: 'Team/Sales', notebooks: [], contentHash: 'x' } } })
        );

        const folder: WorkspaceFolder = { uri: Uri.file(tmp), name: 'tmp', index: 0 };
        when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([folder]);
        when(mockedVSCodeNamespaces.workspace.asRelativePath(anything())).thenCall((uri: Uri) =>
            path.relative(tmp, uri.fsPath).split(path.sep).join('/')
        );
        when(mockedVSCodeNamespaces.workspace.getConfiguration('deepnote', anything())).thenReturn({
            get: (_key: string, fallback: unknown) => fallback
        } as any);

        shown = [];
        answers = new Map();
        for (const severity of ['Information', 'Warning', 'Error'] as const) {
            for (let arity = 1; arity <= 4; arity++) {
                const matchers = Array.from({ length: arity }, () => anything());
                when((win() as any)[`show${severity}Message`](...matchers)).thenCall(async (...args: unknown[]) => {
                    shown.push({ severity, args });

                    return respond(args);
                });
            }
        }

        picks = new Map([
            [CHOOSE_PROJECT, 'Sales'],
            [CHOOSE_API_ACCESS, 'API access on']
        ]);
        quickPicks = [];
        when(win().showQuickPick(anything(), anything())).thenCall(
            async (items: QuickPickItem[], options: { placeHolder: string }) => {
                quickPicks.push({ items, placeHolder: options.placeHolder });
                const label = picks.get(options.placeHolder);

                return items.find((item) => item.label === label);
            }
        );

        commandHandlers = new Map();
        when(mockedVSCodeNamespaces.commands.registerCommand(anything(), anything())).thenCall(
            (id: string, commandHandler: (...args: unknown[]) => Promise<unknown>) => {
                commandHandlers.set(id, commandHandler);

                return { dispose: () => undefined };
            }
        );
        syncResult = undefined;
        syncTargets = [];
        when(mockedVSCodeNamespaces.commands.executeCommand(Commands.SyncWithDeepnoteCloud, anything())).thenCall(
            async (_command: string, target: unknown) => {
                syncTargets.push(target);

                return syncResult;
            }
        );

        tokenService = mock<IDeepnoteApiTokenService>();
        when(tokenService.getOrPromptToken(anything())).thenResolve('tok');

        lock = new DeepnoteCloudOperationLock();
        workspaceState = new MockMemento();
        handler = new TestableHandler(instance(tokenService), lock, {
            subscriptions: [],
            workspaceState
        } as unknown as IExtensionContext);
        handler.listProjectsStub.resolves(PROJECTS);
        handler.runPublishAppStub.resolves(published());
        handler.activate();
    });

    teardown(async () => {
        resetVSCodeMocks();
        await fs.promises.rm(tmp, { recursive: true, force: true });
    });

    suite('choosing the folder and the settings', () => {
        test('asks for the folder when the command has none', async () => {
            when(win().showOpenDialog(anything())).thenCall(async () => [Uri.file(appFolder)]);

            await publish();

            const dialog = capture(win().showOpenDialog).last()[0];
            assert.deepStrictEqual(
                { ...dialog, defaultUri: dialog?.defaultUri?.fsPath },
                {
                    canSelectFolders: true,
                    canSelectFiles: false,
                    canSelectMany: false,
                    defaultUri: Uri.file(tmp).fsPath,
                    title: 'Choose the app folder to publish',
                    openLabel: 'Publish'
                }
            );
            assert.strictEqual(publishCalls()[0].dir, appFolder);
        });

        test('does nothing when the folder dialog is dismissed', async () => {
            await publish();

            verify(tokenService.getOrPromptToken(anything())).never();
            assert.isTrue(handler.runPublishAppStub.notCalled);
        });

        test('publishes nothing when no token is available', async () => {
            when(tokenService.getOrPromptToken(anything())).thenResolve(undefined);

            await publish(appFolder);

            assert.deepStrictEqual(quickPicks, []);
            assert.isTrue(handler.runPublishAppStub.notCalled);
        });

        test('asks for the project and API access on a first publish, saves them and publishes the folder', async () => {
            await publish(appFolder);

            assert.strictEqual(handler.listProjectsStub.lastCall.args[0], 'https://api.deepnote.com');
            assert.deepStrictEqual(
                quickPick(CHOOSE_PROJECT).map(({ label, description }) => ({ label, description })),
                [
                    { label: 'Alpha', description: undefined },
                    { label: 'Ops', description: undefined },
                    { label: 'Sales', description: 'Team / Q3' }
                ]
            );
            assert.deepStrictEqual(
                quickPick(CHOOSE_API_ACCESS).map(({ label, detail }) => ({ label, detail })),
                [
                    { label: 'API access off', detail: 'The app cannot call the Deepnote API.' },
                    { label: 'API access on', detail: API_ACCESS_ON_DETAIL }
                ]
            );
            const { onEvent, ...options } = publishCalls()[0];
            assert.deepStrictEqual(options, {
                dir: appFolder,
                projectId: 'p-sales',
                baseUrl: 'https://api.deepnote.com',
                token: 'tok',
                apiAccess: true,
                force: false
            });
            assert.isFunction(onEvent);
            assert.deepStrictEqual(workspaceState.get('deepnote.publishApp.folderSettings'), {
                [Uri.file(appFolder).toString()]: { projectId: 'p-sales', projectName: 'Sales', apiAccess: true }
            });
        });

        test('saves nothing and publishes nothing when the API-access pick is dismissed', async () => {
            picks.set(CHOOSE_API_ACCESS, undefined);

            await publish(appFolder);

            assert.isUndefined(workspaceState.get('deepnote.publishApp.folderSettings'));
            assert.isTrue(handler.runPublishAppStub.notCalled);
        });

        test('reports a failed project listing and publishes nothing', async () => {
            handler.listProjectsStub.rejects(new Error('boom'));

            await publish(appFolder);

            assert.deepStrictEqual(messages('Error'), ['Could not load Deepnote projects: boom']);
            assert.isTrue(handler.runPublishAppStub.notCalled);
        });

        test('uses the synced project that holds the folder without listing projects', async () => {
            await publish(syncedAppFolder);

            assert.isTrue(handler.listProjectsStub.notCalled);
            assert.strictEqual(publishCalls()[0].projectId, 'p1');
            assert.deepStrictEqual(workspaceState.get('deepnote.publishApp.folderSettings'), {
                [Uri.file(syncedAppFolder).toString()]: { projectId: 'p1', projectName: 'Sales', apiAccess: true }
            });
        });

        test('lists the projects for a folder in Team/SalesArchive, beside the synced Team/Sales', async () => {
            const besideSynced = path.join(tmp, 'root', 'Team', 'SalesArchive', 'app');
            await fs.promises.mkdir(besideSynced, { recursive: true });

            await publish(besideSynced);

            assert.isTrue(handler.listProjectsStub.calledOnce);
            assert.strictEqual(publishCalls()[0].projectId, 'p-sales');
        });

        test('lists the projects when the sync manifest above the folder cannot be read', async () => {
            await fs.promises.writeFile(path.join(tmp, 'root', '.deepnote-sync.json'), '{');

            await publish(syncedAppFolder);

            assert.isTrue(handler.listProjectsStub.calledOnce);
            assert.strictEqual(publishCalls()[0].projectId, 'p-sales');
        });

        test('republishes with the saved settings after one confirmation', async () => {
            await saveSettings(appFolder, { projectId: 'p-sales', projectName: 'Sales', apiAccess: true });
            answers.set('Publish app to Sales?', 'Publish');

            await publish(appFolder);

            assert.deepStrictEqual(shown[0].args, [
                'Publish app to Sales?',
                { modal: true, detail: 'API access: on.' },
                'Publish',
                'Change Settings…'
            ]);
            assert.deepStrictEqual(quickPicks, []);
            assert.isTrue(handler.runPublishAppStub.calledOnce);
            assert.strictEqual(publishCalls()[0].projectId, 'p-sales');
        });

        test('lists the current choices first when changing the saved settings', async () => {
            await saveSettings(appFolder, { projectId: 'p-sales', projectName: 'Sales', apiAccess: true });
            answers.set('Publish app to Sales?', 'Change Settings…');
            picks.set(CHOOSE_PROJECT, 'Ops');
            picks.set(CHOOSE_API_ACCESS, 'API access off');

            await publish(appFolder);

            assert.deepStrictEqual(
                quickPick(CHOOSE_PROJECT).map(({ label, detail }) => ({ label, detail })),
                [
                    { label: 'Sales', detail: 'Current choice' },
                    { label: 'Alpha', detail: undefined },
                    { label: 'Ops', detail: undefined }
                ]
            );
            assert.deepStrictEqual(
                quickPick(CHOOSE_API_ACCESS).map(({ label, detail }) => ({ label, detail })),
                [
                    { label: 'API access on', detail: `Current choice. ${API_ACCESS_ON_DETAIL}` },
                    { label: 'API access off', detail: 'The app cannot call the Deepnote API.' }
                ]
            );
            assert.deepStrictEqual(workspaceState.get('deepnote.publishApp.folderSettings'), {
                [Uri.file(appFolder).toString()]: { projectId: 'p-ops', projectName: 'Ops', apiAccess: false }
            });
            assert.include(publishCalls()[0], { projectId: 'p-ops', apiAccess: false });
        });

        test('publishes nothing when the saved-settings confirmation is dismissed', async () => {
            await saveSettings(appFolder, { projectId: 'p-sales', projectName: 'Sales', apiAccess: false });

            await publish(appFolder);

            assert.deepStrictEqual(quickPicks, []);
            assert.isTrue(handler.runPublishAppStub.notCalled);
        });
    });

    suite('one operation at a time', () => {
        test('publishes a folder outside any sync root while the lock is held', async () => {
            const lease = lock.tryAcquire()!;

            await publish(appFolder);

            assert.isTrue(handler.runPublishAppStub.calledOnce);
            lease.dispose();
        });

        test('refuses to publish into a synced folder while the lock is held', async () => {
            const lease = lock.tryAcquire()!;

            await publish(syncedAppFolder);

            assert.deepStrictEqual(messages('Information'), [
                'A sync or app publish with Deepnote Cloud is already in progress.'
            ]);
            assert.isTrue(handler.runPublishAppStub.notCalled);
            lease.dispose();
        });

        test('holds the lock while publishing into a synced folder, and releases it once the publish settles', async () => {
            let lockHeldDuringPublish = false;
            handler.runPublishAppStub.callsFake(async () => {
                const lease = lock.tryAcquire();
                lockHeldDuringPublish = lease === undefined;
                lease?.dispose();

                return published();
            });

            await publish(syncedAppFolder);

            assert.isTrue(lockHeldDuringPublish, 'the lock must be held while publishing');
            assert.isDefined(lock.tryAcquire(), 'the lock must be released once the publish settles');
        });
    });

    suite('results', () => {
        test('reports upload progress', async () => {
            const reports: unknown[] = [];
            when(win().withProgress(anything(), anything())).thenCall((_options, task) =>
                task({ report: (value: unknown) => reports.push(value) }, undefined)
            );
            handler.runPublishAppStub.callsFake(async ({ onEvent }) => {
                onEvent?.({ kind: 'publishing', fileCount: 2, targetPath: '_deepnote_static', projectId: 'p' });
                onEvent?.({ kind: 'file-uploaded', path: 'index.html' });
                onEvent?.({ kind: 'file-uploaded', path: 'main.js' });

                return published();
            });

            await publish(appFolder);

            assert.deepStrictEqual(reports, [
                { message: '1 of 2 files uploaded', increment: 50 },
                { message: '2 of 2 files uploaded', increment: 50 }
            ]);
        });

        test('shows the app URL with Open and Copy, and Copy copies it', async () => {
            const url = 'https://deepnote.com/app/x';
            handler.runPublishAppStub.resolves(published({ appUrl: url }));
            const copied = createDeferred<string>();
            when(mockedVSCodeNamespaces.env.clipboard).thenReturn({
                writeText: async (text: string) => copied.resolve(text)
            } as any);
            answers.set(`App published: ${url}`, 'Copy');

            await publish(appFolder);

            assert.deepStrictEqual(shown[shown.length - 1].args, [`App published: ${url}`, 'Open', 'Copy']);
            assert.strictEqual(await copied.promise, url);
            verify(win().setStatusBarMessage('App URL copied', 3000)).once();
        });

        test('opens the app URL in the browser', async () => {
            const url = 'https://deepnote.com/app/x';
            handler.runPublishAppStub.resolves(published({ appUrl: url }));
            const opened = createDeferred<Uri>();
            when(mockedVSCodeNamespaces.env.openExternal(anything())).thenCall(async (uri: Uri) => {
                opened.resolve(uri);

                return true;
            });
            answers.set(`App published: ${url}`, 'Open');

            await publish(appFolder);

            assert.strictEqual((await opened.promise).toString(), url);
        });

        test('reports failed file operations with Show Log and no URL', async () => {
            handler.runPublishAppStub.resolves(
                published({ errors: [{ path: 'index.html', message: 'upload failed' }], appUrl: undefined })
            );
            answers.set('1 file operation(s) failed, so the app was not shared. See the log for details.', 'Show Log');
            const logShown = createDeferred<void>();
            when(mockedVSCodeNamespaces.commands.executeCommand(Commands.ViewJupyterOutput)).thenCall(async () =>
                logShown.resolve()
            );

            await publish(appFolder);

            assert.deepStrictEqual(shown[shown.length - 1], {
                severity: 'Warning',
                args: ['1 file operation(s) failed, so the app was not shared. See the log for details.', 'Show Log']
            });
            assert.deepStrictEqual(messages('Information'), []);
            await logShown.promise;
        });

        test('warns after the URL when the synced copy could not be fully updated', async () => {
            handler.runPublishAppStub.callsFake(async ({ onEvent }) => {
                onEvent?.({ kind: 'mirror-incomplete', syncRoot: '/sync', failures: ['index.html — EACCES'] });

                return published({ appUrl: 'https://deepnote.com/app/x' });
            });

            await publish(appFolder);

            assert.deepStrictEqual(
                shown.map(({ severity, args }) => [severity, args[0]]),
                [
                    ['Information', 'App published: https://deepnote.com/app/x'],
                    [
                        'Warning',
                        'The app was published, but the synced copy in /sync could not be fully updated. Sync again to refresh it.'
                    ]
                ]
            );
        });

        test('reports a refused publish', async () => {
            handler.runPublishAppStub.rejects(new PublishError('invalid-input', 'Refusing to publish ".env"'));

            await publish(appFolder);

            assert.deepStrictEqual(messages('Error'), ['Publishing the app failed: Refusing to publish ".env"']);
            assert.deepStrictEqual(messages('Information'), []);
        });
    });

    suite('app files changed in Deepnote', () => {
        setup(() => {
            handler.runPublishAppStub
                .onFirstCall()
                .rejects(new PublishDivergedError(path.join(tmp, 'root'), ['_deepnote_static/a.js']));
        });

        test('asks once the lock is released, and Force publishes again with force', async () => {
            let lockFreeDuringModal = false;
            answers.set(DIVERGED, () => {
                const lease = lock.tryAcquire();
                lockFreeDuringModal = lease !== undefined;
                lease?.dispose();

                return 'Force';
            });

            await publish(syncedAppFolder);

            assert.deepStrictEqual(shown[0], {
                severity: 'Warning',
                args: [
                    DIVERGED,
                    {
                        modal: true,
                        detail: "Sync First syncs the whole synced folder, including the working files of every project, so you can merge Deepnote's versions into your app. Force overwrites them in Deepnote."
                    },
                    'Sync First',
                    'Force'
                ]
            });
            assert.isTrue(lockFreeDuringModal);
            assert.deepStrictEqual(
                publishCalls().map(({ force }) => force),
                [false, true]
            );
        });

        for (const { name, count, message } of [
            {
                name: 'lists all of ten changed paths',
                count: 10,
                message:
                    '10 app file(s) changed in Deepnote since the last sync: f0, f1, f2, f3, f4, f5, f6, f7, f8, f9'
            },
            {
                name: 'lists ten of twelve changed paths and counts the rest',
                count: 12,
                message:
                    '12 app file(s) changed in Deepnote since the last sync: f0, f1, f2, f3, f4, f5, f6, f7, f8, f9 …and 2 more'
            }
        ]) {
            test(name, async () => {
                const paths = Array.from({ length: count }, (_, i) => `f${i}`);
                handler.runPublishAppStub
                    .onFirstCall()
                    .rejects(new PublishDivergedError(path.join(tmp, 'root'), paths));

                await publish(syncedAppFolder);

                assert.strictEqual(messages('Warning')[0], message);
            });
        }

        test('leaves everything as it is when the question is dismissed', async () => {
            await publish(syncedAppFolder);

            assert.isTrue(handler.runPublishAppStub.calledOnce);
            assert.deepStrictEqual(syncTargets, []);
        });

        test('Sync First syncs the root with working files and names where the app files landed', async () => {
            syncFirstWith([
                { projectId: 'p1', name: 'Sales', path: 'Team/Sales', action: 'unchanged', filesDownloaded: 1 }
            ]);

            await publish(syncedAppFolder);

            const [target] = syncTargets as { root: Uri; allFiles: boolean }[];
            assert.deepStrictEqual(
                { ...target, root: target.root.fsPath },
                { root: path.join(tmp, 'root'), allFiles: true }
            );
            assert.isTrue(handler.runPublishAppStub.calledOnce);
            assert.deepStrictEqual(messages('Information'), [
                "Deepnote's versions of the changed app files are now in root/Team/Sales/.files/_deepnote_static. Merge them into your app, then publish again."
            ]);
        });

        test('Sync First warns when the project failed, even though another project downloaded files', async () => {
            syncFirstWith(
                [
                    { projectId: 'p1', name: 'Sales', path: 'Team/Sales', action: 'error', detail: 'export failed' },
                    { projectId: 'p2', name: 'Ops', path: 'Ops', action: 'pulled', filesDownloaded: 2 }
                ],
                false
            );

            await publish(syncedAppFolder);

            assert.deepStrictEqual(messages('Warning').slice(1), [MISSED_APP_FILES]);
            assert.deepStrictEqual(messages('Information'), []);
        });

        test('Sync First warns when the sync succeeded but pushed the project instead of downloading it', async () => {
            syncFirstWith([{ projectId: 'p1', name: 'Sales', path: 'Team/Sales', action: 'pushed', filesUploaded: 0 }]);

            await publish(syncedAppFolder);

            assert.deepStrictEqual(messages('Warning').slice(1), [MISSED_APP_FILES]);
        });

        test('Sync First keeps a project name from Deepnote from becoming a link in its warning', async () => {
            const folder = path.join(tmp, 'root', 'site');
            handler.listProjectsStub.resolves([{ id: 'p-x', name: 'X [Show Log](command:evil)' }]);
            picks.set(CHOOSE_PROJECT, 'X [Show Log](command:evil)');
            syncFirstWith([{ projectId: 'p-x', name: 'X', path: 'X', action: 'pushed' }]);

            await publish(folder);

            assert.deepStrictEqual(messages('Warning').slice(1), [
                "The sync did not download Deepnote's changed app files for X [Show Log] (command:evil), and nothing was published. Fix any errors or skipped conflicts the sync reported, then publish again and choose Sync First."
            ]);
        });

        test('Sync First shows nothing more when the sync stopped', async () => {
            syncFirstWith([]);
            syncResult = undefined;

            await publish(syncedAppFolder);

            assert.deepStrictEqual(messages('Warning'), [DIVERGED]);
            assert.deepStrictEqual(messages('Information'), []);
            assert.isTrue(handler.runPublishAppStub.calledOnce);
        });
    });
});
