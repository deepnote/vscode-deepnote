import dotenv from 'dotenv';
import { inject, injectable } from 'inversify';
import { Uri, workspace } from 'vscode';

import {
    BUILTIN_INTEGRATIONS,
    DatabaseIntegrationConfig,
    DEFAULT_ENV_FILE,
    DEFAULT_INTEGRATIONS_FILE,
    FederatedAuthMethod,
    isFederatedAuthMethod,
    parseIntegrations,
    ValidationIssue
} from '@deepnote/database-integrations';

import { IFileSystem } from '../../common/platform/types';
import { logger } from '../../logging';
import { DATAFRAME_SQL_INTEGRATION_ID } from './integrationTypes';
import { IIntegrationsFileConfigProvider } from './types';

/**
 * Narrows metadata to the federated-auth variant. Mirrors the guard in
 * `sqlIntegrationEnvironmentVariablesProvider.ts` because upstream `isFederatedAuthMetadata`'s generic
 * doesn't unify with our `DatabaseIntegrationConfig['metadata']` union; delegates to the exported
 * `isFederatedAuthMethod` at runtime.
 */
function isFederatedAuthMetadata(
    metadata: DatabaseIntegrationConfig['metadata']
): metadata is Extract<DatabaseIntegrationConfig['metadata'], { authMethod: FederatedAuthMethod }> {
    if (typeof metadata !== 'object' || metadata === null) {
        return false;
    }
    if (!('authMethod' in metadata)) {
        return false;
    }
    const authMethod = metadata.authMethod;

    return typeof authMethod === 'string' && isFederatedAuthMethod(authMethod);
}

/**
 * Stateless loader that reads integration configs from a `.deepnote.env.yaml` file (CLI parity),
 * resolving `env:` references against a sibling `.env` file and `process.env`. Replicates the Node
 * filesystem/dotenv shell that `@deepnote/database-integrations` does not export, delegating parsing
 * to the exported, environment-agnostic `parseIntegrations`.
 *
 * No caching, no watching: a fresh read happens on every call, since it is only invoked at
 * kernel/server (re)start.
 */
@injectable()
export class IntegrationsFileConfigProvider implements IIntegrationsFileConfigProvider {
    constructor(@inject(IFileSystem) private readonly fileSystem: IFileSystem) {}

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

            return this.filterIntegrations(integrations, issues);
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
     * Filters parsed integrations into the configs we can inject, collecting an issue for each dropped
     * entry: reserved ids, unsupported (dataframe) types, duplicate ids (first wins), and federated-auth
     * configs (whose tokens are only available via SecretStorage, not the environment file).
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

            if (integration.type === 'pandas-dataframe' || integration.id === DATAFRAME_SQL_INTEGRATION_ID) {
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

            if (isFederatedAuthMetadata(integration.metadata)) {
                issues.push({
                    path: issuePath,
                    message: `Integration '${integration.id}' uses federated authentication, which is unsupported from the environment file, and was ignored.`,
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
}
