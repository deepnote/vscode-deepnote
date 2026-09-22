import { deserializeDeepnoteFile, serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';
import { CancellationToken, CancellationTokenSource, Uri, workspace } from 'vscode';

import { ConfigurableDatabaseIntegrationConfig } from '../../../platform/notebooks/deepnote/integrationTypes';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { IDeepnoteNotebookManager, ProjectIntegration, RawProjectIntegration } from '../../types';
import { createDeepnoteFile, createDeepnoteProject, createWorkspaceFolder } from '../deepnoteTestHelpers';
import {
    attachExistingIntegration,
    collectReusableIntegrations,
    ReusableIntegration
} from './existingIntegrationPicker';
import { buildGoogleOauthIntegration, buildPostgresIntegration } from './federatedAuth/federatedAuthTestHelpers';
import { IIntegrationStorage } from './types';

const CURRENT_PROJECT_ID = 'project-current';

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
    // `persistProjectIntegrations` enumerates without a token; the scan passes one.
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
            assert.deepStrictEqual(result, { cancelled: false, conflictingIds: [], integrations: expected });
        });

        test('takes the name from the stored config, not from whichever project was read first', async () => {
            stubWorkspace({
                projects: [
                    {
                        uri: Uri.file('/ws/a.deepnote'),
                        projectId: 'project-a',
                        integrations: [{ id: 'pg-shared', name: 'Stale project name', type: 'pgsql' }]
                    }
                ]
            });

            const { integrations } = await collect();

            assert.strictEqual(integrations[0].name, 'Shared Postgres');
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

            assert.deepStrictEqual(
                integrations.map((integration) => integration.id),
                ['bq-oauth'],
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

            assert.deepStrictEqual(result, { cancelled: false, conflictingIds: ['pg-shared'], integrations: [] });
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

        test('stops at the next file and reports cancellation when the token trips mid-scan', async () => {
            const cts = new CancellationTokenSource();

            try {
                const { reads } = stubWorkspace({
                    projects: [
                        {
                            uri: Uri.file('/ws/a.deepnote'),
                            projectId: 'project-a',
                            integrations: [{ id: 'pg-shared', name: 'Shared Postgres', type: 'pgsql' }]
                        },
                        {
                            uri: Uri.file('/ws/b.deepnote'),
                            projectId: 'project-b',
                            integrations: [{ id: 'bq-oauth', name: 'Team BigQuery', type: 'big-query' }]
                        }
                    ],
                    onRead: () => cts.cancel()
                });

                const result = await collect([], [pgConfig, bqConfig], cts.token);

                assert.deepStrictEqual(result, { cancelled: true, conflictingIds: [], integrations: [] });
                assert.deepStrictEqual(reads, [Uri.file('/ws/a.deepnote').fsPath], 'the scan must not read on');
            } finally {
                cts.dispose();
            }
        });

        test('reports cancellation when the token trips while the last file is read', async () => {
            const cts = new CancellationTokenSource();

            try {
                stubWorkspace({
                    projects: [
                        {
                            uri: Uri.file('/ws/a.deepnote'),
                            projectId: 'project-a',
                            integrations: [{ id: 'pg-shared', name: 'Shared Postgres', type: 'pgsql' }]
                        }
                    ],
                    onRead: () => cts.cancel()
                });

                const result = await collect([], [pgConfig, bqConfig], cts.token);

                assert.deepStrictEqual(result, { cancelled: true, conflictingIds: [], integrations: [] });
            } finally {
                cts.dispose();
            }
        });

        test('reports cancellation when the token trips during file discovery', async () => {
            const cts = new CancellationTokenSource();

            try {
                const { reads } = stubWorkspace({
                    projects: [
                        {
                            uri: Uri.file('/ws/a.deepnote'),
                            projectId: 'project-a',
                            integrations: [{ id: 'pg-shared', name: 'Shared Postgres', type: 'pgsql' }]
                        }
                    ],
                    onFindFiles: () => cts.cancel()
                });

                const result = await collect([], [pgConfig, bqConfig], cts.token);

                assert.deepStrictEqual(result, { cancelled: true, conflictingIds: [], integrations: [] });
                assert.deepStrictEqual(reads, [], 'discovery never finished, so no file was visited');
            } finally {
                cts.dispose();
            }
        });

        test('returns nothing without an open workspace folder', async () => {
            stubWorkspace({ projects: [], hasWorkspaceFolder: false });

            const result = await collect();

            assert.deepStrictEqual(result, { cancelled: false, conflictingIds: [], integrations: [] });
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
        let cacheUpdates: Array<{ projectId: string; integrations: ProjectIntegration[] }>;

        setup(() => {
            cacheUpdates = [];
            const mockManager = mock<IDeepnoteNotebookManager>();
            when(mockManager.updateProjectIntegrations(anything(), anything())).thenCall(
                (projectId: string, integrations: ProjectIntegration[]) => {
                    cacheUpdates.push({ projectId, integrations });

                    return true;
                }
            );
            notebookManager = instance(mockManager);
        });

        test('appends the linked entry to the project integrations in the cache and on disk, keeping existing entries', async () => {
            const { writes } = stubWorkspace({
                projects: [
                    {
                        uri: activeUri,
                        projectId: CURRENT_PROJECT_ID,
                        integrations: [{ id: 'bq-own', name: 'Own BigQuery', type: 'big-query' }]
                    }
                ]
            });
            const currentIntegrations: ProjectIntegration[] = [
                { id: 'bq-own', name: 'Own BigQuery', type: 'big-query' }
            ];

            const result = await attachExistingIntegration({
                activeFileUri: activeUri,
                currentIntegrations,
                integration: shared,
                notebookManager,
                projectId: CURRENT_PROJECT_ID
            });

            const expectedIntegrations: ProjectIntegration[] = [
                { id: 'bq-own', name: 'Own BigQuery', type: 'big-query' },
                { id: 'pg-shared', name: 'Shared Postgres', type: 'pgsql' }
            ];
            assert.deepStrictEqual(result, { activePersisted: true, siblingsFailed: 0 });
            assert.deepStrictEqual(cacheUpdates, [
                { projectId: CURRENT_PROJECT_ID, integrations: expectedIntegrations }
            ]);
            assert.deepStrictEqual(writes.get(activeUri.fsPath)?.project.integrations, expectedIntegrations);
        });

        test('passes entries of types it cannot manage (e.g. pandas-dataframe) through verbatim', async () => {
            const { writes } = stubWorkspace({
                projects: [{ uri: activeUri, projectId: CURRENT_PROJECT_ID }]
            });
            const currentIntegrations: RawProjectIntegration[] = [
                { id: 'duckdb', name: 'DuckDB', type: 'pandas-dataframe' },
                { id: 'future', name: 'Unknown to this build', type: 'some-future-type' }
            ];

            await attachExistingIntegration({
                activeFileUri: activeUri,
                currentIntegrations,
                integration: shared,
                notebookManager,
                projectId: CURRENT_PROJECT_ID
            });

            const expectedIntegrations = [
                ...currentIntegrations,
                { id: 'pg-shared', name: 'Shared Postgres', type: 'pgsql' }
            ];
            assert.deepStrictEqual(cacheUpdates, [
                { projectId: CURRENT_PROJECT_ID, integrations: expectedIntegrations }
            ]);
            assert.deepStrictEqual(writes.get(activeUri.fsPath)?.project.integrations, expectedIntegrations);
        });

        test('replaces rather than duplicates an entry whose id the project already declares', async () => {
            const { writes } = stubWorkspace({
                projects: [{ uri: activeUri, projectId: CURRENT_PROJECT_ID }]
            });

            await attachExistingIntegration({
                activeFileUri: activeUri,
                currentIntegrations: [{ id: 'pg-shared', name: 'Old name', type: 'pgsql' }],
                integration: shared,
                notebookManager,
                projectId: CURRENT_PROJECT_ID
            });

            assert.deepStrictEqual(writes.get(activeUri.fsPath)?.project.integrations, [
                { id: 'pg-shared', name: 'Shared Postgres', type: 'pgsql' }
            ]);
        });
    });
});
