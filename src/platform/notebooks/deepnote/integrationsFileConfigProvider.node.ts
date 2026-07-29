import dotenv from 'dotenv';
import { inject, injectable } from 'inversify';
import { Diagnostic, DiagnosticCollection, DiagnosticSeverity, languages, Range, Uri, workspace } from 'vscode';

import {
    BUILTIN_INTEGRATIONS,
    DatabaseIntegrationConfig,
    DEFAULT_ENV_FILE,
    DEFAULT_INTEGRATIONS_FILE,
    parseIntegrations,
    ValidationIssue
} from '@deepnote/database-integrations';

import { IFileSystem } from '../../common/platform/types';
import { IDisposableRegistry } from '../../common/types';
import { logger } from '../../logging';
import { isFederatedAuthMetadata, isSupportedFederatedAuth } from './integrationTypes';
import { IIntegrationsFileConfigProvider } from './types';

/**
 * Stateless loader that reads integration configs from a `.deepnote.env.yaml` file (CLI parity),
 * resolving `env:` references against a sibling `.env` file and `process.env`. Replicates the Node
 * filesystem/dotenv shell that `@deepnote/database-integrations` does not export, delegating parsing
 * to the exported, environment-agnostic `parseIntegrations`.
 *
 * No caching, no watching: a fresh read happens on every call. That was cheap when the only caller was
 * kernel/server (re)start, but `getMergedConfigs` now reaches here on every SQL cell execution and on every
 * integrations-panel refresh, so each call is up to two `exists` + two `readFile` round-trips and re-publishes
 * the YAML's diagnostics. Adding a cache means invalidating it on file change — deliberately not done yet.
 */
@injectable()
export class IntegrationsFileConfigProvider implements IIntegrationsFileConfigProvider {
    private readonly diagnostics: DiagnosticCollection | undefined;

    constructor(
        @inject(IFileSystem) private readonly fileSystem: IFileSystem,
        @inject(IDisposableRegistry) disposables: IDisposableRegistry
    ) {
        this.diagnostics = languages.createDiagnosticCollection('deepnote-integrations');
        if (this.diagnostics) {
            disposables.push(this.diagnostics);
        }
    }

    public async getConfigsForFile(
        deepnoteFileUri: Uri
    ): Promise<{ configs: DatabaseIntegrationConfig[]; issues: ValidationIssue[] }> {
        try {
            const enabled = workspace
                .getConfiguration('deepnote', deepnoteFileUri)
                .get<boolean>('integrations.envFile.enabled', true);
            if (!enabled) {
                return { configs: [], issues: [] };
            }

            const candidateDirs = this.getCandidateDirs(deepnoteFileUri);

            // Locate the integrations YAML (dir-then-root). A missing file is not an error.
            const yamlUri = await this.findFirstExisting(candidateDirs, DEFAULT_INTEGRATIONS_FILE);
            if (!yamlUri) {
                return { configs: [], issues: [] };
            }

            const yaml = await this.fileSystem.readFile(yamlUri);

            // Locate the `.env` (dir-then-root) and resolve `env:` refs against it; real env wins over the file.
            const envUri = await this.findFirstExisting(candidateDirs, DEFAULT_ENV_FILE);
            const fileEnv = envUri ? dotenv.parse(await this.fileSystem.readFile(envUri)) : {};
            const env: Record<string, string | undefined> = { ...fileEnv, ...this.getProcessEnvironment() };

            const { integrations, issues } = parseIntegrations({ yaml, env });

            const result = this.filterIntegrations(integrations, issues);
            this.updateDiagnostics(yamlUri, result.issues);

            return result;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const issue: ValidationIssue = {
                path: '',
                message: `Failed to read integrations file: ${message}`,
                code: 'file_read_error'
            };
            logger.error(`IntegrationsFileConfigProvider: ${issue.message}`);

            return { configs: [], issues: [issue] };
        }
    }

    /** The process environment merged over the `.env` file; a seam tests override so they never touch the real `process.env`. */
    protected getProcessEnvironment(): Record<string, string | undefined> {
        return process.env;
    }

    /**
     * Filters parsed integrations into the configs we accept, collecting an issue for each dropped
     * entry: reserved ids, unsupported (dataframe) types, duplicate ids (first wins), and federated-auth
     * configs other than the one combination this extension implements (BigQuery + `google-oauth`).
     *
     * That combination is kept because the file only ever carries its OAuth client metadata (`project`,
     * `clientId`, `clientSecret`); the token is a separate artifact owned by `IFederatedAuthTokenStorage`.
     * Keeping those credentials out of the kernel environment is
     * `SqlIntegrationEnvironmentVariablesProvider.getEnvironmentVariables`' job, not this filter's.
     */
    private filterIntegrations(
        integrations: DatabaseIntegrationConfig[],
        parseIssues: ValidationIssue[]
    ): { configs: DatabaseIntegrationConfig[]; issues: ValidationIssue[] } {
        const configs: DatabaseIntegrationConfig[] = [];
        const issues: ValidationIssue[] = [...parseIssues];
        const seenIds = new Set<string>();

        integrations.forEach((integration, index) => {
            const issuePath = `integrations[${index}]`;

            if (BUILTIN_INTEGRATIONS.has(integration.id)) {
                issues.push({
                    path: issuePath,
                    message: `Integration '${integration.id}' uses a reserved id and was ignored.`,
                    code: 'reserved_integration_id'
                });

                return;
            }

            if (integration.type === 'pandas-dataframe') {
                issues.push({
                    path: issuePath,
                    message: `Integration '${integration.id}' has unsupported type '${integration.type}' and was ignored.`,
                    code: 'unsupported_integration_type'
                });

                return;
            }

            if (seenIds.has(integration.id)) {
                issues.push({
                    path: issuePath,
                    message: `Integration '${integration.id}' has a duplicate id and was ignored.`,
                    code: 'duplicate_integration_id'
                });

                return;
            }

            if (isFederatedAuthMetadata(integration.metadata) && !isSupportedFederatedAuth(integration)) {
                issues.push({
                    path: issuePath,
                    message: `Integration '${integration.id}' uses an unsupported federated authentication method and was ignored.`,
                    code: 'unsupported_federated_integration'
                });

                return;
            }

            seenIds.add(integration.id);
            configs.push(integration);
        });

        issues.forEach((issue) => {
            logger.warn(`IntegrationsFileConfigProvider: ${issue.code} at '${issue.path}': ${issue.message}`);
        });

        return { configs, issues };
    }

    private async findFirstExisting(dirs: Uri[], fileName: string): Promise<Uri | undefined> {
        for (const dir of dirs) {
            const candidate = Uri.joinPath(dir, fileName);
            if (await this.fileSystem.exists(candidate)) {
                return candidate;
            }
        }

        return undefined;
    }

    /**
     * Candidate directories to look for the integration/env files in priority order: next to the
     * `.deepnote` file first, then the workspace-folder root. Undefined entries are skipped and
     * duplicates removed.
     */
    private getCandidateDirs(deepnoteFileUri: Uri): Uri[] {
        const dirs: Uri[] = [Uri.joinPath(deepnoteFileUri, '..')];
        const workspaceFolder = workspace.getWorkspaceFolder(deepnoteFileUri);
        if (workspaceFolder) {
            dirs.push(workspaceFolder.uri);
        }

        const seen = new Set<string>();

        return dirs.filter((dir) => {
            const key = dir.toString();
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);

            return true;
        });
    }

    /** Surfaces validation issues in the Problems panel against the located `.deepnote.env.yaml` so a typo/missing key isn't silent; a clean parse clears them. No-op when diagnostics are unavailable (e.g. web/tests). */
    private updateDiagnostics(yamlUri: Uri, issues: ValidationIssue[]): void {
        if (!this.diagnostics) {
            return;
        }

        if (issues.length === 0) {
            this.diagnostics.delete(yamlUri);

            return;
        }

        const diagnostics = issues.map((issue) => {
            const detail = issue.path
                ? `${issue.code} at '${issue.path}': ${issue.message}`
                : `${issue.code}: ${issue.message}`;
            const diagnostic = new Diagnostic(new Range(0, 0, 0, 0), detail, DiagnosticSeverity.Warning);
            diagnostic.source = 'Deepnote integrations';

            return diagnostic;
        });

        this.diagnostics.set(yamlUri, diagnostics);
    }
}
