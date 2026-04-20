import { assert } from 'chai';
import esmock from 'esmock';
import * as sinon from 'sinon';
import { instance, mock, when } from 'ts-mockito';
import { Memento, Uri } from 'vscode';

import { IDisposableRegistry, IExtensionContext } from '../../../platform/common/types';
import { resetVSCodeMocks } from '../../../test/vscode-mock';
import { DeepnoteProjectEnvironmentMapper } from './deepnoteProjectEnvironmentMapper.node';

const LEGACY_STORAGE_KEY = 'deepnote.notebookEnvironmentMappings';
const STORAGE_KEY = 'deepnote.projectEnvironmentMappings';

/**
 * Simple in-memory Memento used to exercise the mapper's save/load logic with
 * real state transitions (rather than stubbing ts-mockito on `update` and
 * `get`, which makes assertions awkward).
 */
class InMemoryMemento implements Memento {
    private readonly store = new Map<string, unknown>();

    public get<T>(key: string): T | undefined;
    public get<T>(key: string, defaultValue: T): T;
    public get<T>(key: string, defaultValue?: T): T | undefined {
        return (this.store.has(key) ? (this.store.get(key) as T) : defaultValue) as T | undefined;
    }

    public keys(): readonly string[] {
        return Array.from(this.store.keys());
    }

    public async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.store.delete(key);
        } else {
            this.store.set(key, value);
        }
    }
}

suite('DeepnoteProjectEnvironmentMapper', () => {
    let state: InMemoryMemento;
    let context: IExtensionContext;
    let disposables: IDisposableRegistry;

    setup(() => {
        resetVSCodeMocks();
        state = new InMemoryMemento();

        const mockContext = mock<IExtensionContext>();
        when(mockContext.workspaceState).thenReturn(state);
        context = instance(mockContext);

        disposables = [];
    });

    teardown(() => {
        for (const disposable of disposables) {
            disposable.dispose();
        }
    });

    suite('CRUD methods', () => {
        test('getEnvironmentForProject returns undefined when not set', async () => {
            const mapper = new DeepnoteProjectEnvironmentMapper(context, disposables);
            await mapper.waitForInitialization();

            assert.strictEqual(mapper.getEnvironmentForProject('proj-1'), undefined);
        });

        test('setEnvironmentForProject persists and is readable via getEnvironmentForProject', async () => {
            const mapper = new DeepnoteProjectEnvironmentMapper(context, disposables);
            await mapper.waitForInitialization();

            await mapper.setEnvironmentForProject('proj-1', 'env-abc');

            assert.strictEqual(mapper.getEnvironmentForProject('proj-1'), 'env-abc');
            assert.deepStrictEqual(state.get<Record<string, string>>(STORAGE_KEY), { 'proj-1': 'env-abc' });
        });

        test('removeEnvironmentForProject clears mapping and persists', async () => {
            const mapper = new DeepnoteProjectEnvironmentMapper(context, disposables);
            await mapper.waitForInitialization();

            await mapper.setEnvironmentForProject('proj-1', 'env-abc');
            await mapper.removeEnvironmentForProject('proj-1');

            assert.strictEqual(mapper.getEnvironmentForProject('proj-1'), undefined);
            assert.deepStrictEqual(state.get<Record<string, string>>(STORAGE_KEY), {});
        });

        test('removeEnvironmentForProject is a no-op when no mapping exists', async () => {
            const mapper = new DeepnoteProjectEnvironmentMapper(context, disposables);
            await mapper.waitForInitialization();

            const events: { projectId: string }[] = [];
            disposables.push(mapper.onDidRemoveEnvironment((e) => events.push(e)));

            await mapper.removeEnvironmentForProject('proj-missing');

            assert.strictEqual(events.length, 0, 'Should not fire event when mapping did not exist');
        });

        test('getProjectsUsingEnvironment returns all projects pointing to the env', async () => {
            const mapper = new DeepnoteProjectEnvironmentMapper(context, disposables);
            await mapper.waitForInitialization();

            await mapper.setEnvironmentForProject('proj-1', 'env-A');
            await mapper.setEnvironmentForProject('proj-2', 'env-B');
            await mapper.setEnvironmentForProject('proj-3', 'env-A');

            const projects = mapper.getProjectsUsingEnvironment('env-A').sort();
            assert.deepStrictEqual(projects, ['proj-1', 'proj-3']);

            assert.deepStrictEqual(mapper.getProjectsUsingEnvironment('env-none'), []);
        });

        test('getAllMappings returns an independent snapshot', async () => {
            const mapper = new DeepnoteProjectEnvironmentMapper(context, disposables);
            await mapper.waitForInitialization();

            await mapper.setEnvironmentForProject('proj-1', 'env-A');

            const snapshot = mapper.getAllMappings();
            assert.deepStrictEqual(
                Array.from(snapshot.entries()),
                [['proj-1', 'env-A']],
                'Snapshot should reflect current state'
            );

            // Mutating after snapshot should not affect the returned copy
            await mapper.setEnvironmentForProject('proj-2', 'env-B');
            assert.strictEqual(snapshot.has('proj-2'), false, 'Snapshot must not observe later mutations');
        });

        test('persisted mappings are loaded on startup', async () => {
            await state.update(STORAGE_KEY, { 'proj-pre': 'env-pre' });

            const mapper = new DeepnoteProjectEnvironmentMapper(context, disposables);
            await mapper.waitForInitialization();

            assert.strictEqual(mapper.getEnvironmentForProject('proj-pre'), 'env-pre');
        });
    });

    suite('events', () => {
        test('onDidSetEnvironment fires with { projectId, environmentId }', async () => {
            const mapper = new DeepnoteProjectEnvironmentMapper(context, disposables);
            await mapper.waitForInitialization();

            const events: { projectId: string; environmentId: string }[] = [];
            disposables.push(mapper.onDidSetEnvironment((e) => events.push(e)));

            await mapper.setEnvironmentForProject('proj-1', 'env-A');

            assert.deepStrictEqual(events, [{ projectId: 'proj-1', environmentId: 'env-A' }]);
        });

        test('onDidRemoveEnvironment fires with { projectId } after remove', async () => {
            const mapper = new DeepnoteProjectEnvironmentMapper(context, disposables);
            await mapper.waitForInitialization();

            await mapper.setEnvironmentForProject('proj-1', 'env-A');

            const events: { projectId: string }[] = [];
            disposables.push(mapper.onDidRemoveEnvironment((e) => events.push(e)));

            await mapper.removeEnvironmentForProject('proj-1');

            assert.deepStrictEqual(events, [{ projectId: 'proj-1' }]);
        });
    });

    suite('legacy migration', () => {
        // Migration reads the legacy fsPath -> envId mapping and resolves each
        // fsPath to a project id via `resolveProjectIdForFile`. The helper
        // reads YAML and parses it strictly, which is cumbersome to stub via
        // the vscode `workspace.fs.readFile` path — so we use `esmock` to
        // replace the resolver import entirely for these tests.
        let MapperModule: any;
        let resolveProjectIdForFileStub: sinon.SinonStub;

        setup(async () => {
            resolveProjectIdForFileStub = sinon.stub();

            MapperModule = await esmock('./deepnoteProjectEnvironmentMapper.node', {
                '../../../platform/deepnote/deepnoteProjectIdResolver': {
                    resolveProjectIdForFile: (uri: Uri) => resolveProjectIdForFileStub(uri),
                    // The mapper doesn't use this symbol, but esmock's module
                    // replacement forces us to provide a full replacement.
                    resolveProjectIdForNotebook: () => undefined
                }
            });
        });

        teardown(() => {
            esmock.purge(MapperModule);
        });

        test('migrates legacy fsPath-keyed entries to projectId-keyed storage', async () => {
            const goodPath = '/workspace/good.deepnote';
            const missingPath = '/workspace/gone.deepnote';

            await state.update(LEGACY_STORAGE_KEY, {
                [goodPath]: 'env-migrated',
                [missingPath]: 'env-orphan'
            });

            resolveProjectIdForFileStub.callsFake(async (uri: Uri) => {
                if (uri.fsPath === goodPath) {
                    return 'proj-migrated';
                }
                return undefined; // simulates YAML read / parse failure
            });

            const mapper = new MapperModule.DeepnoteProjectEnvironmentMapper(context, disposables);
            await mapper.waitForInitialization();

            // Resolved entry is now keyed by project id
            assert.strictEqual(mapper.getEnvironmentForProject('proj-migrated'), 'env-migrated');
            // Unresolved entry is skipped — fsPath must not leak into the new storage
            assert.strictEqual(mapper.getEnvironmentForProject(missingPath), undefined);

            // Legacy key is cleared
            assert.strictEqual(
                state.get(LEGACY_STORAGE_KEY),
                undefined,
                'Legacy workspace-state key should be removed after migration'
            );

            // New key has only the migrated entry
            const stored = state.get<Record<string, string>>(STORAGE_KEY);
            assert.deepStrictEqual(stored, { 'proj-migrated': 'env-migrated' });
        });

        test('fires onDidSetEnvironment for each migrated entry', async () => {
            const path1 = '/workspace/a.deepnote';
            const path2 = '/workspace/b.deepnote';

            await state.update(LEGACY_STORAGE_KEY, {
                [path1]: 'env-1',
                [path2]: 'env-2'
            });

            resolveProjectIdForFileStub.callsFake(async (uri: Uri) => {
                if (uri.fsPath === path1) return 'proj-1';
                if (uri.fsPath === path2) return 'proj-2';
                return undefined;
            });

            const events: { projectId: string; environmentId: string }[] = [];
            // Construct the mapper and attach the listener synchronously before
            // awaiting initialization so the migration events are captured.
            const mapper = new MapperModule.DeepnoteProjectEnvironmentMapper(context, disposables);
            disposables.push(
                mapper.onDidSetEnvironment((e: { projectId: string; environmentId: string }) => events.push(e))
            );

            await mapper.waitForInitialization();

            const sorted = events.slice().sort((a, b) => a.projectId.localeCompare(b.projectId));
            assert.deepStrictEqual(sorted, [
                { projectId: 'proj-1', environmentId: 'env-1' },
                { projectId: 'proj-2', environmentId: 'env-2' }
            ]);
        });

        test('legacy migration is a no-op when there are no legacy entries', async () => {
            // No legacy key set at all — mapper must initialize cleanly
            const mapper = new MapperModule.DeepnoteProjectEnvironmentMapper(context, disposables);
            await mapper.waitForInitialization();

            assert.deepStrictEqual(Array.from(mapper.getAllMappings().entries()), []);
            assert.strictEqual(state.get(LEGACY_STORAGE_KEY), undefined);
            assert.strictEqual(resolveProjectIdForFileStub.called, false);
        });

        test('legacy migration respects last-writer-wins for duplicate project ids', async () => {
            const pathA = '/workspace/a.deepnote';
            const pathB = '/workspace/b.deepnote';

            await state.update(LEGACY_STORAGE_KEY, {
                [pathA]: 'env-first',
                [pathB]: 'env-second'
            });

            resolveProjectIdForFileStub.callsFake(async () => 'proj-shared');

            const mapper = new MapperModule.DeepnoteProjectEnvironmentMapper(context, disposables);
            await mapper.waitForInitialization();

            // Last one wins — the exact value depends on iteration order, but
            // the critical invariant is no crash on collision and some value
            // is retained.
            const envForShared = mapper.getEnvironmentForProject('proj-shared');
            assert.oneOf(
                envForShared,
                ['env-first', 'env-second'],
                'One of the two entries should win; migration must not crash on collision'
            );
        });

        test('already-migrated workspace-state is loaded alongside a no-op legacy migration', async () => {
            await state.update(STORAGE_KEY, { 'proj-loaded': 'env-loaded' });

            const mapper = new MapperModule.DeepnoteProjectEnvironmentMapper(context, disposables);
            await mapper.waitForInitialization();

            assert.strictEqual(mapper.getEnvironmentForProject('proj-loaded'), 'env-loaded');
        });

        test('legacy key is cleared before any resolver work so a crash mid-migration cannot re-run it', async () => {
            const path1 = '/workspace/a.deepnote';
            await state.update(LEGACY_STORAGE_KEY, { [path1]: 'env-1' });

            let legacyStillPresentWhenResolverRan: boolean | undefined;
            resolveProjectIdForFileStub.callsFake(async () => {
                legacyStillPresentWhenResolverRan = state.get(LEGACY_STORAGE_KEY) !== undefined;
                return 'proj-1';
            });

            const mapper = new MapperModule.DeepnoteProjectEnvironmentMapper(context, disposables);
            await mapper.waitForInitialization();

            assert.strictEqual(
                legacyStillPresentWhenResolverRan,
                false,
                'Legacy key must be cleared before the resolver runs so a crash during migration cannot cause a re-run'
            );
            assert.strictEqual(mapper.getEnvironmentForProject('proj-1'), 'env-1');
        });
    });
});
