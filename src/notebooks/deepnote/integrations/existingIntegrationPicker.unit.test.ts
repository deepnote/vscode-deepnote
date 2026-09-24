import { deserializeDeepnoteFile, serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { assert, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { anything, instance, mock, when } from 'ts-mockito';
import { CancellationError, CancellationToken, CancellationTokenSource, Uri, workspace } from 'vscode';

import { ConfigurableDatabaseIntegrationConfig } from '../../../platform/notebooks/deepnote/integrationTypes';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { IDeepnoteNotebookManager, RawProjectIntegration } from '../../types';
import {
    createDeepnoteFile,
    createDeepnoteProject,
    createMockNotebook,
    createWorkspaceFolder
} from '../deepnoteTestHelpers';
import {
    attachExistingIntegration,
    collectReusableIntegrations,
    findOtherProjectsDeclaring,
    ReusableIntegration
} from './existingIntegrationPicker';
import { buildGoogleOauthIntegration, buildPostgresIntegration } from './federatedAuth/federatedAuthTestHelpers';
import { IIntegrationStorage } from './types';

use(chaiAsPromised);

const CURRENT_PROJECT_ID = 'project-current';

// `thenCall` checks no signature, so doubles take their parameter types from here; annotating them by hand undoes it.
type UpdateProjectIntegrationsFn = IDeepnoteNotebookManager['updateProjectIntegrationsForNotebook'];

interface OnDiskProject {
    uri: Uri;
    projectId: string;
    projectName?: string;
    integrations?: Array<{ id: string; name: string; type: string }>;
}

function projectFile(project: OnDiskProject): DeepnoteFile {
    return createDeepnoteFile({
        project: createDeepnoteProject({
            id: project.projectId,
            name: project.projectName ?? project.projectId,
            integrations: project.integrations
        })
    });
}

/** Stubs `workspace.findFiles` + `workspace.fs` over the given files; `unreadable` URIs reject on read. */
function stubWorkspace(opts: {
    projects: OnDiskProject[];
    unreadable?: Uri[];
    hasWorkspaceFolder?: boolean;
    onFindFiles?: () => void;
    onRead?: (uri: Uri) => void;
}): {
    reads: string[];
    writes: Map<string, DeepnoteFile>;
} {
    when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn(
        opts.hasWorkspaceFolder === false ? undefined : [createWorkspaceFolder(Uri.file('/ws'))]
    );

    const discovered = [...opts.projects.map((project) => project.uri), ...(opts.unreadable ?? [])];
    when(mockedVSCodeNamespaces.workspace.findFiles(anything(), anything(), anything(), anything())).thenCall(
        (_include: unknown, _exclude: unknown, _maxResults: unknown, token?: CancellationToken) => {
            opts.onFindFiles?.();

            // Mirrors the real API, which resolves to no results when its token trips instead of rejecting.
            return Promise.resolve(token?.isCancellationRequested ? [] : discovered);
        }
    );
    // The writer enumerates without a token; the scan passes one.
    when(mockedVSCodeNamespaces.workspace.findFiles(anything())).thenReturn(Promise.resolve(discovered));
    when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([]);

    const byPath = new Map(opts.projects.map((project) => [project.uri.fsPath, projectFile(project)] as const));
    const reads: string[] = [];
    const writes = new Map<string, DeepnoteFile>();
    const mockFs = mock<typeof workspace.fs>();

    when(mockFs.readFile(anything())).thenCall((uri: Uri) => {
        reads.push(uri.fsPath);

        const file = byPath.get(uri.fsPath);

        opts.onRead?.(uri);

        return file
            ? Promise.resolve(new TextEncoder().encode(serializeDeepnoteFile(file)))
            : Promise.reject(new Error(`no readFile stub for ${uri.fsPath}`));
    });
    when(mockFs.writeFile(anything(), anything())).thenCall((uri: Uri, bytes: Uint8Array) => {
        writes.set(uri.fsPath, deserializeDeepnoteFile(new TextDecoder().decode(bytes)));

        return Promise.resolve();
    });
    when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

    return { reads, writes };
}

function stubStorage(configs: ConfigurableDatabaseIntegrationConfig[]): IIntegrationStorage {
    const byId = new Map(configs.map((config) => [config.id, config] as const));
    const storage = mock<IIntegrationStorage>();

    when(storage.getIntegrationConfig(anything())).thenCall((id: string) => Promise.resolve(byId.get(id)));

    return instance(storage);
}

suite('existingIntegrationPicker', () => {
    setup(() => {
        resetVSCodeMocks();
    });

    suite('collectReusableIntegrations', () => {
        const pgConfig = buildPostgresIntegration({ id: 'pg-shared', name: 'Shared Postgres' });
        const bqConfig = buildGoogleOauthIntegration({ id: 'bq-oauth', name: 'Team BigQuery' });

        async function collect(
            excludeIntegrationIds: string[] = [],
            configs: ConfigurableDatabaseIntegrationConfig[] = [pgConfig, bqConfig],
            token?: CancellationToken
        ) {
            return collectReusableIntegrations({
                excludeIntegrationIds: new Set(excludeIntegrationIds),
                integrationStorage: stubStorage(configs),
                projectId: CURRENT_PROJECT_ID,
                token
            });
        }

        test('lists integrations other projects declare, deduped by id with every using project named', async () => {
            stubWorkspace({
                projects: [
                    {
                        uri: Uri.file('/ws/a.deepnote'),
                        projectId: 'project-a',
                        projectName: 'Alpha',
                        integrations: [{ id: 'pg-shared', name: 'Alpha Postgres', type: 'pgsql' }]
                    },
                    {
                        uri: Uri.file('/ws/b.deepnote'),
                        projectId: 'project-b',
                        projectName: 'Beta',
                        integrations: [
                            { id: 'pg-shared', name: 'Beta Postgres', type: 'pgsql' },
                            { id: 'bq-oauth', name: 'Team BigQuery', type: 'big-query' }
                        ]
                    },
                    // A second notebook file of Beta must not list Beta twice.
                    {
                        uri: Uri.file('/ws/b-2.deepnote'),
                        projectId: 'project-b',
                        projectName: 'Beta',
                        integrations: [{ id: 'pg-shared', name: 'Beta Postgres', type: 'pgsql' }]
                    }
                ]
            });

            const result = await collect();

            const expected: ReusableIntegration[] = [
                { id: 'pg-shared', name: 'Shared Postgres', projectNames: ['Alpha', 'Beta'], type: 'pgsql' },
                { id: 'bq-oauth', name: 'Team BigQuery', projectNames: ['Beta'], type: 'big-query' }
            ];
            assert.deepStrictEqual(result, { conflictingIds: [], integrations: expected });
        });

        test('excludes ids the current project already declares and the current project files themselves', async () => {
            stubWorkspace({
                projects: [
                    {
                        uri: Uri.file('/ws/current.deepnote'),
                        projectId: CURRENT_PROJECT_ID,
                        integrations: [{ id: 'bq-oauth', name: 'Team BigQuery', type: 'big-query' }]
                    },
                    {
                        uri: Uri.file('/ws/a.deepnote'),
                        projectId: 'project-a',
                        integrations: [
                            { id: 'pg-shared', name: 'Shared Postgres', type: 'pgsql' },
                            { id: 'bq-oauth', name: 'Team BigQuery', type: 'big-query' }
                        ]
                    }
                ]
            });

            const { integrations } = await collect(['pg-shared']);

            const expected: ReusableIntegration[] = [
                { id: 'bq-oauth', name: 'Team BigQuery', projectNames: ['project-a'], type: 'big-query' }
            ];
            assert.deepStrictEqual(
                integrations,
                expected,
                'pg-shared is already attached; bq-oauth is offered because project-a (not the current project) declares it'
            );
        });

        test('skips entries with no stored config (file-only or never configured) and unsupported types', async () => {
            stubWorkspace({
                projects: [
                    {
                        uri: Uri.file('/ws/a.deepnote'),
                        projectId: 'project-a',
                        integrations: [
                            { id: 'file-only', name: 'From env yaml', type: 'pgsql' },
                            { id: 'duckdb', name: 'DuckDB', type: 'pandas-dataframe' },
                            { id: 'pg-shared', name: 'Shared Postgres', type: 'pgsql' }
                        ]
                    },
                    // A type this build cannot manage is skipped, not taken for a conflict that hides pg-shared.
                    {
                        uri: Uri.file('/ws/b.deepnote'),
                        projectId: 'project-b',
                        integrations: [{ id: 'pg-shared', name: 'Shared Postgres', type: 'some-future-type' }]
                    }
                ]
            });

            const { integrations } = await collect();

            assert.deepStrictEqual(
                integrations.map((integration) => integration.id),
                ['pg-shared']
            );
        });

        test('reports an id whose declared type disagrees with the stored config as conflicting and drops it everywhere', async () => {
            stubWorkspace({
                projects: [
                    {
                        uri: Uri.file('/ws/a.deepnote'),
                        projectId: 'project-a',
                        integrations: [{ id: 'pg-shared', name: 'Shared Postgres', type: 'pgsql' }]
                    },
                    {
                        uri: Uri.file('/ws/b.deepnote'),
                        projectId: 'project-b',
                        // Same id, but declared as a different database than the credentials are for.
                        integrations: [{ id: 'pg-shared', name: 'Not really Postgres', type: 'mysql' }]
                    }
                ]
            });

            const result = await collect();

            assert.deepStrictEqual(result, { conflictingIds: ['pg-shared'], integrations: [] });
        });

        test('ignores snapshot files and keeps going past an unreadable file', async () => {
            stubWorkspace({
                projects: [
                    {
                        uri: Uri.file('/ws/snapshots/a_project-a_2024.snapshot.deepnote'),
                        projectId: 'project-snapshot',
                        integrations: [{ id: 'bq-oauth', name: 'Team BigQuery', type: 'big-query' }]
                    },
                    {
                        uri: Uri.file('/ws/a.deepnote'),
                        projectId: 'project-a',
                        integrations: [{ id: 'pg-shared', name: 'Shared Postgres', type: 'pgsql' }]
                    }
                ],
                unreadable: [Uri.file('/ws/broken.deepnote')]
            });

            const { integrations } = await collect();

            assert.deepStrictEqual(
                integrations.map((integration) => integration.id),
                ['pg-shared']
            );
        });

        const projectA: OnDiskProject = {
            uri: Uri.file('/ws/a.deepnote'),
            projectId: 'project-a',
            integrations: [{ id: 'pg-shared', name: 'Shared Postgres', type: 'pgsql' }]
        };
        const projectB: OnDiskProject = {
            uri: Uri.file('/ws/b.deepnote'),
            projectId: 'project-b',
            integrations: [{ id: 'bq-oauth', name: 'Team BigQuery', type: 'big-query' }]
        };
        const cancellations: {
            name: string;
            projects: OnDiskProject[];
            readsBeforeStop: Uri[];
            trip: 'discovery' | 'read';
        }[] = [
            { name: 'mid-scan', projects: [projectA, projectB], readsBeforeStop: [projectA.uri], trip: 'read' },
            {
                name: 'while the last file is read',
                projects: [projectA],
                readsBeforeStop: [projectA.uri],
                trip: 'read'
            },
            { name: 'during file discovery', projects: [projectA], readsBeforeStop: [], trip: 'discovery' }
        ];

        for (const { name, projects, readsBeforeStop, trip } of cancellations) {
            test(`reports cancellation and reads no further when the token trips ${name}`, async () => {
                const cts = new CancellationTokenSource();

                try {
                    const { reads } = stubWorkspace({
                        projects,
                        onFindFiles: trip === 'discovery' ? () => cts.cancel() : undefined,
                        onRead: trip === 'read' ? () => cts.cancel() : undefined
                    });

                    await assert.isRejected(collect([], [pgConfig, bqConfig], cts.token), CancellationError);

                    assert.deepStrictEqual(
                        reads,
                        readsBeforeStop.map((uri) => uri.fsPath)
                    );
                } finally {
                    cts.dispose();
                }
            });
        }

        test('returns nothing without an open workspace folder', async () => {
            stubWorkspace({ projects: [], hasWorkspaceFolder: false });

            const result = await collect();

            assert.deepStrictEqual(result, { conflictingIds: [], integrations: [] });
        });
    });

    suite('attachExistingIntegration', () => {
        const activeUri = Uri.file('/ws/current.deepnote');
        const shared: ReusableIntegration = {
            id: 'pg-shared',
            name: 'Shared Postgres',
            projectNames: ['Alpha'],
            type: 'pgsql'
        };

        let notebookManager: IDeepnoteNotebookManager;
        let cacheUpdates: Parameters<UpdateProjectIntegrationsFn>[];

        setup(() => {
            cacheUpdates = [];
            const recordCacheUpdate: UpdateProjectIntegrationsFn = (...update) => {
                cacheUpdates.push(update);
            };
            const mockManager = mock<IDeepnoteNotebookManager>();
            when(mockManager.updateProjectIntegrationsForNotebook(anything(), anything(), anything())).thenCall(
                recordCacheUpdate
            );
            notebookManager = instance(mockManager);
        });

        test('appends the linked entry in the cache and on disk, keeping every existing entry verbatim, even of types it cannot manage', async () => {
            const currentIntegrations: RawProjectIntegration[] = [
                { id: 'bq-own', name: 'Own BigQuery', type: 'big-query' },
                { id: 'duckdb', name: 'DuckDB', type: 'pandas-dataframe' },
                { id: 'future', name: 'Unknown to this build', type: 'some-future-type' }
            ];
            const { writes } = stubWorkspace({
                projects: [{ uri: activeUri, projectId: CURRENT_PROJECT_ID, integrations: currentIntegrations }]
            });
            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([
                createMockNotebook({
                    metadata: { deepnoteNotebookId: 'notebook-current', deepnoteProjectId: CURRENT_PROJECT_ID },
                    uri: activeUri
                })
            ]);

            const result = await attachExistingIntegration({
                activeFileUri: activeUri,
                integration: shared,
                notebookManager,
                projectId: CURRENT_PROJECT_ID
            });

            const expectedIntegrations = [
                ...currentIntegrations,
                { id: 'pg-shared', name: 'Shared Postgres', type: 'pgsql' }
            ];
            assert.deepStrictEqual(result, { activePersisted: true, siblingsFailed: 0 });
            assert.deepStrictEqual(cacheUpdates, [[CURRENT_PROJECT_ID, 'notebook-current', expectedIntegrations]]);
            assert.deepStrictEqual(writes.get(activeUri.fsPath)?.project.integrations, expectedIntegrations);
        });
    });

    suite('findOtherProjectsDeclaring', () => {
        test('names every other project declaring the id once, ignoring its own files, snapshots and unreadable files', async () => {
            // Catches: the current project or a snapshot counted as "another project", which blocks every delete, or
            // a project listed twice.
            const shared = { id: 'pg-shared', name: 'Shared Postgres', type: 'pgsql' };

            stubWorkspace({
                projects: [
                    {
                        uri: Uri.file('/ws/beta.deepnote'),
                        projectId: 'project-beta',
                        projectName: 'Beta',
                        integrations: [shared]
                    },
                    {
                        uri: Uri.file('/ws/alpha.deepnote'),
                        projectId: 'project-alpha',
                        projectName: 'Alpha',
                        integrations: [shared]
                    },
                    {
                        uri: Uri.file('/ws/alpha-2.deepnote'),
                        projectId: 'project-alpha',
                        projectName: 'Alpha',
                        integrations: [shared]
                    },
                    {
                        uri: Uri.file('/ws/current.deepnote'),
                        projectId: CURRENT_PROJECT_ID,
                        projectName: 'Current',
                        integrations: [shared]
                    },
                    {
                        uri: Uri.file('/ws/snapshots/gamma_project-gamma_latest.snapshot.deepnote'),
                        projectId: 'project-gamma',
                        projectName: 'Gamma',
                        integrations: [shared]
                    },
                    {
                        uri: Uri.file('/ws/delta.deepnote'),
                        projectId: 'project-delta',
                        projectName: 'Delta',
                        integrations: [{ id: 'pg-other', name: 'Other Postgres', type: 'pgsql' }]
                    }
                ],
                unreadable: [Uri.file('/ws/broken.deepnote')]
            });

            const projectNames = await findOtherProjectsDeclaring({
                integrationId: 'pg-shared',
                projectId: CURRENT_PROJECT_ID
            });

            assert.deepStrictEqual(projectNames, ['Alpha', 'Beta']);
        });
    });
});
