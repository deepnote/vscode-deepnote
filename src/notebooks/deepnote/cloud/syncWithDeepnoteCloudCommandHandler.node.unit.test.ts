import {
    ApiError,
    findSyncManifestRoot,
    type ProjectSyncOutcome,
    type SyncConflict,
    type SyncEvent,
    type WorkspaceSyncOptions,
    type WorkspaceSyncResult
} from '@deepnote/cloud-sync';
import { assert, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as fs from 'fs';
import minimatch from 'minimatch';
import * as os from 'os';
import * as sinon from 'sinon';
import { anything, capture, instance, mock, verify, when } from 'ts-mockito';
import {
    MessageItem,
    NotebookDocument,
    QuickPickItem,
    RelativePattern,
    TextDocument,
    Uri,
    WorkspaceFolder
} from 'vscode';

import { Commands } from '../../../platform/common/constants';
import { IExtensionContext } from '../../../platform/common/types';
import { createDeferred } from '../../../platform/common/utils/async';
import { DeepnoteCloud } from '../../../platform/common/utils/localize';
import { logger } from '../../../platform/logging';
import * as path from '../../../platform/vscode-path/path';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { DeepnoteCloudOperationLock } from './deepnoteCloudOperationLock';
import { SyncWithDeepnoteCloudCommandHandler } from './syncWithDeepnoteCloudCommandHandler.node';
import { IDeepnoteApiTokenService } from './types';

use(chaiAsPromised);

class TestableHandler extends SyncWithDeepnoteCloudCommandHandler {
    public readonly runSyncWorkspaceStub = sinon.stub<[WorkspaceSyncOptions], Promise<WorkspaceSyncResult>>();

    protected override runSyncWorkspace(options: WorkspaceSyncOptions): Promise<WorkspaceSyncResult> {
        return this.runSyncWorkspaceStub(options);
    }
}

type Severity = 'Information' | 'Warning' | 'Error';

function outcome(action: ProjectSyncOutcome['action']): ProjectSyncOutcome {
    return { projectId: `id-${action}`, name: action, path: action, action };
}

const EMPTY_RESULT: WorkspaceSyncResult = {
    success: true,
    root: '',
    dryRun: false,
    projects: [],
    untrackedFiles: []
};

suite('SyncWithDeepnoteCloudCommandHandler', () => {
    let tmp: string;
    let ws: string;
    let handler: TestableHandler;
    let tokenService: IDeepnoteApiTokenService;
    let lock: DeepnoteCloudOperationLock;
    let commandHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
    let manifests: { file: string; hidden: boolean }[];
    let shown: { severity: Severity; args: unknown[] }[];
    let answers: Map<string, string | Promise<never>>;
    let sandbox: sinon.SinonSandbox;

    const win = () => mockedVSCodeNamespaces.window;
    const wsp = () => mockedVSCodeNamespaces.workspace;

    function isInside(candidate: string, folder: string): boolean {
        return candidate === folder || candidate.startsWith(folder + path.sep);
    }

    async function addManifest(folder: string, options: { hidden?: boolean } = {}): Promise<void> {
        const file = path.join(ws, folder, '.deepnote-sync.json');
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, '{}');
        manifests.push({ file, hidden: options.hidden ?? false });
    }

    async function addSymlinkManifest(folder: string): Promise<void> {
        const file = path.join(ws, folder, '.deepnote-sync.json');
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(path.join(tmp, 'real-manifest.json'), '{}');
        await fs.promises.symlink(path.join(tmp, 'real-manifest.json'), file);
        manifests.push({ file, hidden: false });
    }

    function findFiles(include: string | RelativePattern, exclude?: string | null, maxResults?: number): Uri[] {
        const base = typeof include === 'string' ? ws : include.baseUri.fsPath;
        const pattern = typeof include === 'string' ? include : include.pattern;

        return manifests
            .filter(({ file, hidden }) => (exclude === null || !hidden) && isInside(file, base))
            .filter(({ file }) =>
                minimatch(path.relative(base, file).split(path.sep).join('/'), pattern, { dot: true })
            )
            .slice(0, maxResults)
            .map(({ file }) => Uri.file(file));
    }

    function messages(severity: Severity): unknown[] {
        return shown.filter((message) => message.severity === severity).map((message) => message.args[0]);
    }

    function answer(message: string, choice: string | Promise<never>): void {
        answers.set(message, choice);
    }

    function respond([message, ...items]: unknown[]): unknown {
        const choice = answers.get(message as string);
        if (typeof choice !== 'string') {
            return choice;
        }

        return items.find((item) => item === choice || (item as MessageItem | undefined)?.title === choice);
    }

    function pick(label: string | undefined): void {
        when(win().showQuickPick(anything(), anything())).thenCall(async (items: QuickPickItem[]) =>
            items.find((item) => item.label === label)
        );
    }

    function pickedLabels(): string[] {
        return (capture(win().showQuickPick).last()[0] as QuickPickItem[]).map((item) => item.label);
    }

    function chooseInDialog(folder: string): void {
        when(win().showOpenDialog(anything())).thenCall(async () => [Uri.file(folder)]);
    }

    function sync(...args: unknown[]): Promise<unknown> {
        return commandHandlers.get(Commands.SyncWithDeepnoteCloud)!(...args);
    }

    function syncOptions(): WorkspaceSyncOptions {
        return handler.runSyncWorkspaceStub.lastCall.args[0];
    }

    function verifyNoTokenRequested(): void {
        verify(tokenService.getOrPromptToken(anything())).never();
        assert.isTrue(handler.runSyncWorkspaceStub.notCalled);
    }

    setup(async () => {
        resetVSCodeMocks();
        sandbox = sinon.createSandbox();
        tmp = Uri.file(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deepnote-sync-'))).fsPath;
        assert.isUndefined(
            await findSyncManifestRoot(tmp),
            'A .deepnote-sync.json above the temp dir would make every folder overlap it'
        );
        ws = path.join(tmp, 'ws');
        await fs.promises.mkdir(ws);

        const folder: WorkspaceFolder = { uri: Uri.file(ws), name: 'ws', index: 0 };
        when(wsp().workspaceFolders).thenReturn([folder]);
        when(wsp().getWorkspaceFolder(anything())).thenCall((uri: Uri) =>
            isInside(uri.fsPath, folder.uri.fsPath) ? folder : undefined
        );
        when(wsp().asRelativePath(anything())).thenCall((uri: Uri) =>
            path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/')
        );
        when(wsp().textDocuments).thenReturn([]);
        when(wsp().getConfiguration('deepnote', anything())).thenReturn({
            get: (_key: string, fallback: unknown) => fallback
        } as any);

        manifests = [];
        when(wsp().findFiles(anything(), anything())).thenCall(async (include, exclude) => findFiles(include, exclude));
        when(wsp().findFiles(anything(), anything(), anything())).thenCall(async (include, exclude, maxResults) =>
            findFiles(include, exclude, maxResults)
        );

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

        commandHandlers = new Map();
        when(mockedVSCodeNamespaces.commands.registerCommand(anything(), anything())).thenCall(
            (id: string, commandHandler: (...args: unknown[]) => Promise<unknown>) => {
                commandHandlers.set(id, commandHandler);

                return { dispose: () => undefined };
            }
        );

        tokenService = mock<IDeepnoteApiTokenService>();
        when(tokenService.getOrPromptToken(anything())).thenResolve('tok');

        lock = new DeepnoteCloudOperationLock();
        handler = new TestableHandler(instance(tokenService), lock, {
            subscriptions: []
        } as unknown as IExtensionContext);
        handler.runSyncWorkspaceStub.resolves(EMPTY_RESULT);
        handler.activate();
    });

    teardown(async () => {
        resetVSCodeMocks();
        sandbox.restore();
        await fs.promises.rm(tmp, { recursive: true, force: true });
    });

    suite('choosing the folder', () => {
        test('offers the synced folders, then another folder, and syncs the picked one', async () => {
            await addManifest('b');
            await addManifest('a');
            pick('b');
            when(wsp().getConfiguration('deepnote', anything())).thenCall((_section: string, resource?: Uri) => ({
                get: (key: string, fallback: unknown) =>
                    key === 'domain' && resource && isInside(resource.fsPath, path.join(ws, 'b'))
                        ? 'example.test'
                        : fallback
            }));

            await sync();

            assert.deepStrictEqual(pickedLabels(), ['a', 'b', 'Choose another folder…']);
            assert.deepStrictEqual(capture(win().showQuickPick).last()[1], {
                placeHolder: 'Choose the folder to sync with Deepnote Cloud'
            });
            assert.isTrue(handler.runSyncWorkspaceStub.calledOnce);
            const { onConflict, onEvent, ...rest } = syncOptions();
            assert.deepStrictEqual(rest, {
                rootDir: path.join(ws, 'b'),
                baseUrl: 'https://api.example.test',
                token: 'tok',
                allFiles: false
            });
            assert.isFunction(onConflict);
            assert.isFunction(onEvent);
        });

        test('does nothing when the pick is dismissed', async () => {
            await addManifest('a');
            pick(undefined);

            await sync();

            verify(win().showOpenDialog(anything())).never();
            assert.deepStrictEqual(shown, []);
            verifyNoTokenRequested();
        });

        test('does nothing when the folder dialog is dismissed', async () => {
            when(win().showOpenDialog(anything())).thenResolve(undefined);

            await sync();

            assert.deepStrictEqual(shown, []);
            verifyNoTokenRequested();
        });

        test('asks before a first sync and requests the token for the new folder', async () => {
            const folder = path.join(ws, 'new');
            chooseInDialog(folder);
            answer('Download every project of your Deepnote workspace into new?', 'Download Projects');

            await sync();

            verify(win().showQuickPick(anything(), anything())).never();
            const dialog = capture(win().showOpenDialog).last()[0];
            assert.deepStrictEqual(
                { ...dialog, defaultUri: dialog?.defaultUri?.fsPath },
                {
                    canSelectFolders: true,
                    canSelectFiles: false,
                    canSelectMany: false,
                    defaultUri: Uri.file(ws).fsPath,
                    title: 'Choose a folder for your Deepnote workspace',
                    openLabel: 'Sync Here'
                }
            );
            assert.strictEqual(capture(tokenService.getOrPromptToken).last()[0].fsPath, folder);
            assert.strictEqual(syncOptions().rootDir, folder);
        });

        test('does nothing when the first-sync confirmation is dismissed', async () => {
            chooseInDialog(path.join(ws, 'new'));

            await sync();

            assert.deepStrictEqual(shown, [
                {
                    severity: 'Information',
                    args: [
                        'Download every project of your Deepnote workspace into new?',
                        { modal: true },
                        'Download Projects'
                    ]
                }
            ]);
            verifyNoTokenRequested();
        });

        test('syncs the sync root of a folder chosen inside it, without the first-sync confirmation', async () => {
            await addManifest('a');
            pick('Choose another folder…');
            chooseInDialog(path.join(ws, 'a', 'Team', 'P'));

            await sync();

            assert.strictEqual(syncOptions().rootDir, path.join(ws, 'a'));
            assert.deepStrictEqual(messages('Information'), [
                'Sync finished: 0 pulled, 0 pushed, 0 unchanged, 0 skipped, 0 failed.'
            ]);
        });
    });

    suite('syncing a requested folder', () => {
        test('syncs the requested folder with working files, without asking for a folder', async () => {
            await addManifest('a');
            const result: WorkspaceSyncResult = { ...EMPTY_RESULT, root: path.join(ws, 'a') };
            handler.runSyncWorkspaceStub.resolves(result);

            const resolved = await sync({ root: Uri.file(path.join(ws, 'a')), allFiles: true });

            verify(win().showQuickPick(anything(), anything())).never();
            verify(win().showOpenDialog(anything())).never();
            assert.strictEqual(syncOptions().rootDir, path.join(ws, 'a'));
            assert.isTrue(syncOptions().allFiles);
            assert.strictEqual(resolved, result);
        });

        test('refuses a requested folder outside the workspace', async () => {
            const outside = path.join(tmp, 'outside');

            const resolved = await sync({ root: Uri.file(outside), allFiles: true });

            assert.deepStrictEqual(messages('Warning'), [
                `${outside} is outside the open workspace. Open it as a workspace folder to sync it with Deepnote Cloud.`
            ]);
            verifyNoTokenRequested();
            assert.isUndefined(resolved);
        });
    });

    suite('refused folders', () => {
        test('refuses a folder outside the workspace', async () => {
            const outside = path.join(tmp, 'outside');
            chooseInDialog(outside);

            await sync();

            assert.deepStrictEqual(messages('Warning'), [
                `${outside} is outside the open workspace. Open it as a workspace folder to sync it with Deepnote Cloud.`
            ]);
            verifyNoTokenRequested();
        });

        test('refuses a synced folder that contains another', async () => {
            await addManifest('a');
            await addManifest(path.join('a', 'inner'));
            pick('a');

            await sync();

            assert.deepStrictEqual(messages('Warning'), [
                "a can't be synced because it overlaps a/inner, which is also synced with Deepnote Cloud."
            ]);
            verifyNoTokenRequested();
        });

        test('refuses a synced folder inside another', async () => {
            await addManifest('a');
            await addManifest(path.join('a', 'inner'));
            pick('a/inner');

            await sync();

            assert.deepStrictEqual(messages('Warning'), [
                "a/inner can't be synced because it overlaps a, which is also synced with Deepnote Cloud."
            ]);
            verifyNoTokenRequested();
        });

        test('refuses a folder containing a synced folder that files.exclude hides', async () => {
            await addManifest(path.join('a', 'inner'), { hidden: true });
            chooseInDialog(path.join(ws, 'a'));

            await sync();

            verify(win().showQuickPick(anything(), anything())).never();
            assert.deepStrictEqual(messages('Warning'), [
                "a can't be synced because it overlaps a/inner, which is also synced with Deepnote Cloud."
            ]);
            verifyNoTokenRequested();
        });

        test('reports a picked folder whose manifest is a symbolic link and syncs nothing', async () => {
            await addSymlinkManifest('a');
            pick('a');

            await sync();

            const errors = messages('Error');
            assert.lengthOf(errors, 1);
            assert.match(errors[0] as string, /^Sync with Deepnote Cloud failed: /);
            verifyNoTokenRequested();
        });

        test('reports a failed sync-root lookup for a folder chosen in the dialog', async () => {
            await addSymlinkManifest('a');
            pick('Choose another folder…');
            chooseInDialog(path.join(ws, 'a', 'P'));

            await sync();

            const errors = messages('Error');
            assert.lengthOf(errors, 1);
            assert.match(errors[0] as string, /^Sync with Deepnote Cloud failed: /);
            verifyNoTokenRequested();
        });
    });

    suite('before syncing', () => {
        function openNotebook(notebookType: string, saves: boolean, calls: string[]): NotebookDocument {
            const notebook = {
                notebookType,
                isDirty: true,
                save: async () => {
                    calls.push('save');
                    notebook.isDirty = !saves;

                    return saves;
                }
            };

            return notebook as unknown as NotebookDocument;
        }

        function openTextFile(saves: boolean, calls: string[]): TextDocument {
            const document = {
                uri: Uri.file(path.join(ws, 'a', 'Project', 'notebook.deepnote')),
                isDirty: true,
                save: async () => {
                    calls.push('save');
                    document.isDirty = !saves;

                    return saves;
                }
            };

            return document as unknown as TextDocument;
        }

        setup(async () => {
            await addManifest('a');
            pick('a');
        });

        test('saves unsaved Deepnote notebooks before syncing', async () => {
            const calls: string[] = [];
            when(wsp().notebookDocuments).thenReturn([openNotebook('deepnote', true, calls)]);
            handler.runSyncWorkspaceStub.callsFake(async () => {
                calls.push('sync');

                return EMPTY_RESULT;
            });
            answer('1 Deepnote notebook(s) have unsaved changes. Save them before syncing?', 'Save and Sync');

            await sync();

            assert.deepStrictEqual(calls, ['save', 'sync']);
        });

        test('syncs nothing when a notebook stays unsaved', async () => {
            when(wsp().notebookDocuments).thenReturn([openNotebook('deepnote', false, [])]);
            answer('1 Deepnote notebook(s) have unsaved changes. Save them before syncing?', 'Save and Sync');

            await sync();

            assert.deepStrictEqual(shown, [
                {
                    severity: 'Warning',
                    args: [
                        '1 Deepnote notebook(s) have unsaved changes. Save them before syncing?',
                        { modal: true },
                        'Save and Sync'
                    ]
                },
                {
                    severity: 'Warning',
                    args: ['1 Deepnote notebook(s) still have unsaved changes, so nothing was synced.']
                }
            ]);
            assert.isTrue(handler.runSyncWorkspaceStub.notCalled);
        });

        test('syncs nothing when the save prompt is dismissed', async () => {
            const calls: string[] = [];
            when(wsp().notebookDocuments).thenReturn([openNotebook('deepnote', true, calls)]);

            await sync();

            assert.deepStrictEqual(calls, []);
            assert.isTrue(handler.runSyncWorkspaceStub.notCalled);
        });

        test('saves a .deepnote file with unsaved changes in the text editor before syncing', async () => {
            const calls: string[] = [];
            when(wsp().textDocuments).thenReturn([openTextFile(true, calls)]);
            handler.runSyncWorkspaceStub.callsFake(async () => {
                calls.push('sync');

                return EMPTY_RESULT;
            });
            answer('1 Deepnote notebook(s) have unsaved changes. Save them before syncing?', 'Save and Sync');

            await sync();

            assert.deepStrictEqual(calls, ['save', 'sync']);
        });

        test('syncs nothing when a .deepnote file in the text editor stays unsaved', async () => {
            when(wsp().textDocuments).thenReturn([openTextFile(false, [])]);
            answer('1 Deepnote notebook(s) have unsaved changes. Save them before syncing?', 'Save and Sync');

            await sync();

            assert.deepStrictEqual(messages('Warning'), [
                '1 Deepnote notebook(s) have unsaved changes. Save them before syncing?',
                '1 Deepnote notebook(s) still have unsaved changes, so nothing was synced.'
            ]);
            assert.isTrue(handler.runSyncWorkspaceStub.notCalled);
        });

        test('ignores unsaved notebook cells and other unsaved text files', async () => {
            const notebookPath = path.join(ws, 'a', 'Project', 'notebook.deepnote');
            when(wsp().textDocuments).thenReturn([
                { uri: Uri.file(notebookPath).with({ scheme: 'vscode-notebook-cell' }), isDirty: true },
                { uri: Uri.file(path.join(ws, 'a', 'notes.txt')), isDirty: true }
            ] as unknown as TextDocument[]);

            await sync();

            assert.deepStrictEqual(messages('Warning'), []);
            assert.isTrue(handler.runSyncWorkspaceStub.calledOnce);
        });

        test('ignores unsaved notebooks of other types', async () => {
            when(wsp().notebookDocuments).thenReturn([openNotebook('jupyter-notebook', true, [])]);

            await sync();

            assert.deepStrictEqual(messages('Warning'), []);
            assert.isTrue(handler.runSyncWorkspaceStub.calledOnce);
        });

        test('syncs nothing without a token', async () => {
            when(tokenService.getOrPromptToken(anything())).thenResolve(undefined);

            await sync();

            assert.isTrue(handler.runSyncWorkspaceStub.notCalled);
        });
    });

    suite('conflicts', () => {
        const PROJECT_DIR = 'Analytics/Sales report';

        async function getOnConflict(): Promise<(conflict: SyncConflict) => Promise<string>> {
            await addManifest('a');
            pick('a');
            await sync();

            const { onConflict } = syncOptions();
            if (typeof onConflict !== 'function') {
                assert.fail(`onConflict is ${String(onConflict)}, not a function`);
            }

            return onConflict;
        }

        const prompts: { conflict: SyncConflict; question: string; override: string }[] = [
            {
                conflict: { kind: 'cloud-changed-after-local-edit', projectId: 'p1', projectName: 'Sales' },
                question: '"Sales" changed in Deepnote after your last sync, so your local edits were not pushed.',
                override: 'Replace Deepnote Version with Local'
            },
            {
                conflict: {
                    kind: 'changed-on-both-sides',
                    projectId: 'p1',
                    projectName: 'Sales',
                    projectDir: PROJECT_DIR
                },
                question: '"Sales" changed both locally and in Deepnote since the last sync.',
                override: 'Use Deepnote Version, Discard Local Changes'
            },
            {
                conflict: {
                    kind: 'untracked-local-directory',
                    projectId: 'p1',
                    projectName: 'Sales',
                    projectDir: PROJECT_DIR
                },
                question:
                    'Analytics/Sales report already exists locally and differs from the Deepnote project "Sales".',
                override: 'Replace Local Files with Deepnote Version'
            }
        ];

        for (const { conflict, question, override } of prompts) {
            test(`asks about ${conflict.kind} and overrides only on its override button`, async () => {
                const onConflict = await getOnConflict();
                shown = [];

                answer(question, override);
                const afterOverride = await onConflict(conflict);
                answer(question, 'Skip');
                const afterSkip = await onConflict(conflict);
                answers.delete(question);
                const afterDismiss = await onConflict(conflict);

                assert.deepStrictEqual([afterOverride, afterSkip, afterDismiss], ['override', 'skip', 'skip']);
                const expectedArgs = [
                    question,
                    { modal: true },
                    { title: override },
                    { title: 'Skip', isCloseAffordance: true }
                ];
                assert.deepStrictEqual(shown, [
                    { severity: 'Warning', args: expectedArgs },
                    { severity: 'Warning', args: expectedArgs },
                    { severity: 'Warning', args: expectedArgs }
                ]);
            });
        }

        test('skips a working-files-changed conflict without asking', async () => {
            const onConflict = await getOnConflict();
            shown = [];

            const decision = await onConflict({
                kind: 'working-files-changed',
                projectId: 'p1',
                projectName: 'Sales',
                projectDir: PROJECT_DIR,
                files: []
            });

            assert.strictEqual(decision, 'skip');
            assert.deepStrictEqual(shown, []);
        });
    });

    suite('results', () => {
        setup(async () => {
            await addManifest('a');
            pick('a');
        });

        test('offers to set a new token when Deepnote rejects it', async () => {
            handler.runSyncWorkspaceStub.rejects(new ApiError(401, 'Unauthorized'));

            await sync();

            verify(win().showErrorMessage(DeepnoteCloud.apiTokenRejectedForRequest, DeepnoteCloud.setApiToken)).once();
        });

        test('summarizes the outcomes and shows the log on request', async () => {
            handler.runSyncWorkspaceStub.resolves({
                ...EMPTY_RESULT,
                projects: (
                    [
                        'pulled',
                        'pushed',
                        'pushed',
                        'unchanged',
                        'unchanged',
                        'unchanged',
                        'skipped-conflict',
                        'skipped-conflict',
                        'skipped-conflict',
                        'skipped-conflict',
                        'missing-in-cloud'
                    ] as const
                ).map((action) => outcome(action)),
                untrackedFiles: ['x.deepnote', 'y.deepnote']
            });
            const summary =
                'Sync finished: 1 pulled, 2 pushed, 3 unchanged, 4 skipped, 0 failed. ' +
                '1 project(s) no longer in Deepnote were kept locally. ' +
                '2 local .deepnote file(s) are not linked to a Deepnote project and were not uploaded.';
            answer(summary, 'Show Log');
            const logShown = createDeferred<string>();
            when(mockedVSCodeNamespaces.commands.executeCommand(anything())).thenCall(async (id: string) =>
                logShown.resolve(id)
            );

            await sync();

            assert.deepStrictEqual(shown, [{ severity: 'Information', args: [summary, 'Show Log'] }]);
            assert.strictEqual(await logShown.promise, 'deepnote.viewOutput');
        });

        test('summarizes failed projects as a warning', async () => {
            handler.runSyncWorkspaceStub.resolves({ ...EMPTY_RESULT, success: false, projects: [outcome('error')] });

            await sync();

            assert.deepStrictEqual(shown, [
                {
                    severity: 'Warning',
                    args: ['Sync finished: 0 pulled, 0 pushed, 0 unchanged, 0 skipped, 1 failed.', 'Show Log']
                }
            ]);
        });

        const logLines: { name: string; event: SyncEvent; level: 'info' | 'warn'; line: string }[] = [
            {
                name: 'a project outcome with its detail',
                event: {
                    kind: 'project-outcome',
                    outcome: { ...outcome('pulled'), path: 'Team/P', detail: 'moved from Old/P' }
                },
                level: 'info',
                line: 'pulled Team/P — moved from Old/P'
            },
            {
                name: 'a project outcome without a detail',
                event: { kind: 'project-outcome', outcome: { ...outcome('pulled'), path: 'Team/P' } },
                level: 'info',
                line: 'pulled Team/P'
            },
            {
                name: 'a warning',
                event: { kind: 'warning', message: 'Skipped Team/P/../x.csv, whose path is unsafe' },
                level: 'warn',
                line: 'Skipped Team/P/../x.csv, whose path is unsafe'
            }
        ];

        for (const { name, event, level, line } of logLines) {
            test(`logs ${name} at ${level} level`, async () => {
                const log = sandbox.stub(logger, level);

                await sync();
                syncOptions().onEvent!(event);

                sinon.assert.calledWithExactly(log, line);
            });
        }
    });

    suite('one sync at a time', () => {
        setup(async () => {
            await addManifest('a');
            pick('a');
        });

        test('refuses a second sync while one runs', async () => {
            const started = createDeferred<void>();
            const finish = createDeferred<WorkspaceSyncResult>();
            handler.runSyncWorkspaceStub.onFirstCall().callsFake(() => {
                started.resolve();

                return finish.promise;
            });

            const first = sync();
            await started.promise;
            await sync();

            assert.deepStrictEqual(messages('Information'), [
                'A sync or app publish with Deepnote Cloud is already in progress.'
            ]);
            verify(win().showQuickPick(anything(), anything())).once();
            assert.isTrue(handler.runSyncWorkspaceStub.calledOnce);

            finish.resolve(EMPTY_RESULT);
            await first;
        });

        test('refuses to sync while another operation holds the lock, and syncs once it is released', async () => {
            const lease = lock.tryAcquire()!;

            await sync();

            assert.deepStrictEqual(messages('Information'), [
                'A sync or app publish with Deepnote Cloud is already in progress.'
            ]);
            verify(win().showQuickPick(anything(), anything())).never();
            assert.isTrue(handler.runSyncWorkspaceStub.notCalled);

            lease.dispose();
            await sync();

            assert.isTrue(handler.runSyncWorkspaceStub.calledOnce);
        });

        test('does not wait for the summary to be dismissed', async () => {
            answer(
                'Sync finished: 0 pulled, 0 pushed, 0 unchanged, 0 skipped, 0 failed.',
                new Promise<never>(() => undefined)
            );

            await sync();
            await sync();

            assert.isTrue(handler.runSyncWorkspaceStub.calledTwice);
        });

        test('syncs again after the previous attempt threw', async () => {
            when(tokenService.getOrPromptToken(anything()))
                .thenReject(new Error('SecretStorage is unavailable'))
                .thenResolve('tok');

            await assert.isRejected(sync(), 'SecretStorage is unavailable');
            await sync();

            assert.isTrue(handler.runSyncWorkspaceStub.calledOnce);
        });
    });
});
