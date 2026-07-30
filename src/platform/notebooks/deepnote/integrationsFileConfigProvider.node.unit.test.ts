import assert from 'assert';

import {
    DatabaseIntegrationConfig,
    DEFAULT_ENV_FILE,
    DEFAULT_INTEGRATIONS_FILE
} from '@deepnote/database-integrations';
import dedent from 'dedent';
import { dump } from 'js-yaml';
import { anything, instance, mock, verify, when } from 'ts-mockito';
import { DiagnosticCollection, Uri, WorkspaceConfiguration, WorkspaceFolder } from 'vscode';

import { IFileSystem } from '../../common/platform/types';
import { IntegrationsFileConfigProvider } from './integrationsFileConfigProvider.node';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';

/** A pgsql entry for `pgIntegrationYaml`: `id`/`name` identify it, every other key overrides a metadata default. */
interface PgIntegrationSpec {
    id: string;
    name: string;
    [key: string]: string;
}

/** A file present in the virtual filesystem: either readable `content`, or a `readError` that rejects. */
interface VirtualFile {
    path: string;
    content?: string;
    readError?: Error;
}

/** Provider whose process environment is controllable, so tests never read or mutate the real `process.env`. */
class TestableIntegrationsFileConfigProvider extends IntegrationsFileConfigProvider {
    public processEnvironment: Record<string, string | undefined> = {};

    protected override getProcessEnvironment(): Record<string, string | undefined> {
        return this.processEnvironment;
    }
}

suite('IntegrationsFileConfigProvider', () => {
    const deepnoteFileUri = Uri.file('/workspace/project/notebook.deepnote');
    const deepnoteDirUri = Uri.joinPath(deepnoteFileUri, '..');
    // Build the expected file paths exactly as the loader does (dir of the `.deepnote` file).
    const yamlPath = Uri.joinPath(deepnoteDirUri, DEFAULT_INTEGRATIONS_FILE).fsPath;
    const envPath = Uri.joinPath(deepnoteDirUri, DEFAULT_ENV_FILE).fsPath;

    let fileSystem: IFileSystem;
    let provider: TestableIntegrationsFileConfigProvider;
    let featureEnabled: boolean;
    let workspaceFolder: WorkspaceFolder | undefined;

    setup(() => {
        resetVSCodeMocks();

        featureEnabled = true;
        workspaceFolder = undefined;

        fileSystem = mock<IFileSystem>();
        provider = new TestableIntegrationsFileConfigProvider(instance(fileSystem), []);

        // The gate reads `deepnote.integrations.envFile.enabled`; return the current `featureEnabled` value.
        when(mockedVSCodeNamespaces.workspace.getConfiguration(anything(), anything())).thenReturn({
            get: () => featureEnabled
        } as unknown as WorkspaceConfiguration);
        when(mockedVSCodeNamespaces.workspace.getWorkspaceFolder(anything())).thenCall(() => workspaceFolder);
    });

    /** Wires `IFileSystem.exists`/`readFile` to a small in-memory set of files keyed by fsPath. */
    function configureFileSystem(files: VirtualFile[]): void {
        const byPath = new Map(files.map((file) => [file.path, file]));

        when(fileSystem.exists(anything())).thenCall((uri: Uri) => Promise.resolve(byPath.has(uri.fsPath)));
        when(fileSystem.readFile(anything())).thenCall((uri: Uri) => {
            const file = byPath.get(uri.fsPath);
            if (!file) {
                return Promise.reject(new Error(`ENOENT: ${uri.fsPath}`));
            }
            if (file.readError) {
                return Promise.reject(file.readError);
            }

            return Promise.resolve(file.content ?? '');
        });
    }

    /** Reads a metadata field off a parsed config without narrowing the metadata union. */
    function metadataField(config: DatabaseIntegrationConfig, key: string): unknown {
        return (config.metadata as unknown as Record<string, unknown>)[key];
    }

    /**
     * Rebuilds `provider` with a recording `DiagnosticCollection`. The default `languages` mock returns
     * undefined, so a test that cares about diagnostics has to opt in before the constructor runs.
     */
    function recordDiagnostics(): { deleted: string[]; set: string[] } {
        const recorded: { deleted: string[]; set: string[] } = { deleted: [], set: [] };

        when(mockedVSCodeNamespaces.languages.createDiagnosticCollection(anything())).thenReturn({
            delete: (uri: Uri) => recorded.deleted.push(uri.fsPath),
            dispose: () => undefined,
            set: (uri: Uri) => recorded.set.push(uri.fsPath)
        } as unknown as DiagnosticCollection);

        provider = new TestableIntegrationsFileConfigProvider(instance(fileSystem), []);

        return recorded;
    }

    /** An integrations document holding the given pgsql entries, each with valid default connection metadata. */
    function pgIntegrationYaml(...entries: PgIntegrationSpec[]): string {
        return dump({
            integrations: entries.map(({ id, name, ...overrides }) => ({
                id,
                name,
                type: 'pgsql',
                metadata: {
                    host: 'localhost',
                    port: '5432',
                    database: 'mydb',
                    user: 'root',
                    password: 'my-secret',
                    ...overrides
                }
            }))
        });
    }

    test('returns configs for a valid integrations file', async () => {
        configureFileSystem([
            { path: yamlPath, content: pgIntegrationYaml({ id: 'my-postgres', name: 'My Postgres' }) }
        ]);

        const { configs, issues } = await provider.getConfigsForFile(deepnoteFileUri);

        assert.strictEqual(configs.length, 1);
        assert.strictEqual(configs[0].id, 'my-postgres');
        assert.strictEqual(configs[0].type, 'pgsql');
        assert.deepStrictEqual(issues, []);
    });

    test('lets the process environment override values from the .env file', async () => {
        provider.processEnvironment = { DEEPNOTE_TEST_OVERRIDE_PASSWORD: 'secret-from-process-env' };
        configureFileSystem([
            {
                path: yamlPath,
                content: pgIntegrationYaml({
                    id: 'override-postgres',
                    name: 'Override Postgres',
                    password: 'env:DEEPNOTE_TEST_OVERRIDE_PASSWORD'
                })
            },
            { path: envPath, content: 'DEEPNOTE_TEST_OVERRIDE_PASSWORD=stale-from-dotenv\n' }
        ]);

        const { configs, issues } = await provider.getConfigsForFile(deepnoteFileUri);

        assert.strictEqual(configs.length, 1);
        assert.strictEqual(metadataField(configs[0], 'password'), 'secret-from-process-env');
        assert.deepStrictEqual(issues, []);
    });

    test('returns an empty result when the YAML file is missing', async () => {
        configureFileSystem([]);

        const result = await provider.getConfigsForFile(deepnoteFileUri);

        assert.deepStrictEqual(result, { configs: [], issues: [] });
    });

    test('reports a yaml_parse_error for malformed YAML', async () => {
        configureFileSystem([{ path: yamlPath, content: 'integrations:\n  - id: "unclosed string' }]);

        const { configs, issues } = await provider.getConfigsForFile(deepnoteFileUri);

        assert.deepStrictEqual(configs, []);
        assert.strictEqual(issues.length, 1);
        assert.strictEqual(issues[0].code, 'yaml_parse_error');
    });

    test('finds the YAML at the workspace-folder root when absent next to the .deepnote file', async () => {
        const nestedDeepnoteUri = Uri.file('/workspace/project/sub/notebook.deepnote');
        const rootFolder: WorkspaceFolder = { uri: Uri.file('/workspace/project'), name: 'project', index: 0 };
        const rootYamlPath = Uri.joinPath(rootFolder.uri, DEFAULT_INTEGRATIONS_FILE).fsPath;

        workspaceFolder = rootFolder;
        configureFileSystem([
            { path: rootYamlPath, content: pgIntegrationYaml({ id: 'root-postgres', name: 'Root Postgres' }) }
        ]);

        const { configs, issues } = await provider.getConfigsForFile(nestedDeepnoteUri);

        assert.strictEqual(configs.length, 1);
        assert.strictEqual(configs[0].id, 'root-postgres');
        assert.deepStrictEqual(issues, []);
    });

    test('drops an integration whose id is reserved (reserved_integration_id)', async () => {
        configureFileSystem([
            { path: yamlPath, content: pgIntegrationYaml({ id: 'deepnote-dataframe-sql', name: 'Reserved' }) }
        ]);

        const { configs, issues } = await provider.getConfigsForFile(deepnoteFileUri);

        assert.deepStrictEqual(configs, []);
        assert.strictEqual(issues.length, 1);
        assert.strictEqual(issues[0].code, 'reserved_integration_id');
        assert.strictEqual(issues[0].path, 'integrations[0]');
    });

    test('drops an integration with an unsupported pandas-dataframe type (unsupported_integration_type)', async () => {
        configureFileSystem([
            {
                path: yamlPath,
                content: dedent`
                    integrations:
                      - id: my-dataframe
                        name: My Dataframe
                        type: pandas-dataframe
                        metadata: {}
                `
            }
        ]);

        const { configs, issues } = await provider.getConfigsForFile(deepnoteFileUri);

        assert.deepStrictEqual(configs, []);
        assert.strictEqual(issues.length, 1);
        assert.strictEqual(issues[0].code, 'unsupported_integration_type');
        assert.strictEqual(issues[0].path, 'integrations[0]');
    });

    test('drops a duplicate id, keeping the first occurrence (duplicate_integration_id)', async () => {
        configureFileSystem([
            {
                path: yamlPath,
                content: pgIntegrationYaml(
                    { id: 'dup-postgres', name: 'First', host: 'first-host' },
                    { id: 'dup-postgres', name: 'Second', host: 'second-host' }
                )
            }
        ]);

        const { configs, issues } = await provider.getConfigsForFile(deepnoteFileUri);

        assert.strictEqual(configs.length, 1);
        assert.strictEqual(configs[0].id, 'dup-postgres');
        assert.strictEqual(metadataField(configs[0], 'host'), 'first-host');
        assert.strictEqual(issues.length, 1);
        assert.strictEqual(issues[0].code, 'duplicate_integration_id');
        assert.strictEqual(issues[0].path, 'integrations[1]');
    });

    test('returns a file_read_error issue (and does not throw) when reading the file fails', async () => {
        configureFileSystem([{ path: yamlPath, readError: new Error('disk failure') }]);

        // Must resolve, never reject: a read failure degrades to an issue, not a thrown error.
        const { configs, issues } = await provider.getConfigsForFile(deepnoteFileUri);

        assert.deepStrictEqual(configs, []);
        assert.strictEqual(issues.length, 1);
        assert.strictEqual(issues[0].code, 'file_read_error');
        assert.strictEqual(issues[0].path, '');
        assert.ok(issues[0].message.includes('Failed to read integrations file'));
    });

    test('keeps a BigQuery google-oauth integration, resolving env: references inside its metadata', async () => {
        configureFileSystem([
            {
                path: yamlPath,
                content: dedent`
                    integrations:
                      - id: bq-oauth
                        name: BigQuery OAuth
                        type: big-query
                        metadata:
                          authMethod: google-oauth
                          project: my-project
                          clientId: my-client-id
                          clientSecret: "env:DEEPNOTE_TEST_BQ_CLIENT_SECRET"
                `
            },
            { path: envPath, content: 'DEEPNOTE_TEST_BQ_CLIENT_SECRET=oauth-secret-from-dotenv\n' }
        ]);

        const { configs, issues } = await provider.getConfigsForFile(deepnoteFileUri);

        assert.strictEqual(configs.length, 1);
        assert.strictEqual(configs[0].id, 'bq-oauth');
        assert.strictEqual(configs[0].type, 'big-query');
        assert.strictEqual(metadataField(configs[0], 'authMethod'), 'google-oauth');
        assert.strictEqual(metadataField(configs[0], 'clientSecret'), 'oauth-secret-from-dotenv');
        assert.deepStrictEqual(issues, []);
    });

    test('drops a federated integration using an unsupported method (unsupported_federated_integration)', async () => {
        configureFileSystem([
            {
                path: yamlPath,
                content: dedent`
                    integrations:
                      - id: sf-okta
                        name: Snowflake Okta
                        type: snowflake
                        metadata:
                          authMethod: okta
                          accountName: my-account
                          clientId: my-client-id
                          clientSecret: my-client-secret
                          oktaSubdomain: my-subdomain
                          identityProvider: okta
                          authorizationServer: default
                `
            }
        ]);

        const { configs, issues } = await provider.getConfigsForFile(deepnoteFileUri);

        assert.deepStrictEqual(configs, []);
        assert.strictEqual(issues.length, 1);
        assert.strictEqual(issues[0].code, 'unsupported_federated_integration');
        assert.strictEqual(issues[0].path, 'integrations[0]');
    });

    test('returns an empty result without touching the filesystem when the feature is disabled', async () => {
        featureEnabled = false;

        const result = await provider.getConfigsForFile(deepnoteFileUri);

        assert.deepStrictEqual(result, { configs: [], issues: [] });
        verify(fileSystem.exists(anything())).never();
        verify(fileSystem.readFile(anything())).never();
    });

    test('clears a stale diagnostic once the YAML file is deleted', async () => {
        const diagnostics = recordDiagnostics();

        configureFileSystem([{ path: yamlPath, content: 'integrations:\n  - id: "unclosed string' }]);
        await provider.getConfigsForFile(deepnoteFileUri);

        assert.deepStrictEqual(diagnostics.set, [yamlPath], 'the malformed file should publish a diagnostic');

        // Nothing below the early return republishes, so the warning would otherwise stay pinned in Problems.
        configureFileSystem([]);
        await provider.getConfigsForFile(deepnoteFileUri);

        assert.deepStrictEqual(diagnostics.deleted, [yamlPath]);
    });

    test('clears a stale diagnostic once the feature is disabled', async () => {
        const diagnostics = recordDiagnostics();

        configureFileSystem([{ path: yamlPath, content: 'integrations:\n  - id: "unclosed string' }]);
        await provider.getConfigsForFile(deepnoteFileUri);

        assert.deepStrictEqual(diagnostics.set, [yamlPath], 'the malformed file should publish a diagnostic');

        featureEnabled = false;
        await provider.getConfigsForFile(deepnoteFileUri);

        assert.deepStrictEqual(diagnostics.deleted, [yamlPath]);
    });
});
