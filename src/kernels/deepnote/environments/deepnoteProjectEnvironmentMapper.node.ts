import { injectable, inject } from 'inversify';
import { EventEmitter, Memento, Uri } from 'vscode';

import { IDisposableRegistry, IExtensionContext } from '../../../platform/common/types';
import { resolveProjectIdForFile } from '../../../platform/deepnote/deepnoteProjectIdResolver';
import { logger } from '../../../platform/logging';
import { IDeepnoteProjectEnvironmentMapper } from '../types';

/**
 * Manages the mapping between Deepnote projects and their selected environments.
 * Stores selections in workspace state keyed by `project.id` so that sibling
 * `.deepnote` files sharing a project automatically inherit the same environment
 * and share a single runtime.
 */
@injectable()
export class DeepnoteProjectEnvironmentMapper implements IDeepnoteProjectEnvironmentMapper {
    private static readonly LEGACY_STORAGE_KEY = 'deepnote.notebookEnvironmentMappings';
    private static readonly STORAGE_KEY = 'deepnote.projectEnvironmentMappings';

    private readonly _onDidRemoveEnvironment = new EventEmitter<{ projectId: string }>();
    private readonly _onDidSetEnvironment = new EventEmitter<{ projectId: string; environmentId: string }>();

    public readonly onDidRemoveEnvironment = this._onDidRemoveEnvironment.event;
    public readonly onDidSetEnvironment = this._onDidSetEnvironment.event;

    private readonly workspaceState: Memento;
    private mappings: Map<string, string> = new Map(); // projectId -> environmentId
    private readonly initializationPromise: Promise<void>;

    constructor(
        @inject(IExtensionContext) context: IExtensionContext,
        @inject(IDisposableRegistry) disposables: IDisposableRegistry
    ) {
        this.workspaceState = context.workspaceState;
        disposables.push(this._onDidSetEnvironment, this._onDidRemoveEnvironment);

        this.initializationPromise = this.initialize().catch((error) => {
            logger.error('Failed to initialize DeepnoteProjectEnvironmentMapper', error);
        });
    }

    public getAllMappings(): ReadonlyMap<string, string> {
        return new Map(this.mappings);
    }

    public getEnvironmentForProject(projectId: string): string | undefined {
        return this.mappings.get(projectId);
    }

    public getProjectsUsingEnvironment(environmentId: string): string[] {
        const projects: string[] = [];
        for (const [projectId, mappedEnvironmentId] of this.mappings.entries()) {
            if (mappedEnvironmentId === environmentId) {
                projects.push(projectId);
            }
        }

        return projects;
    }

    public async removeEnvironmentForProject(projectId: string): Promise<void> {
        await this.waitForInitialization();

        if (!this.mappings.has(projectId)) {
            return;
        }

        this.mappings.delete(projectId);
        await this.saveMappings();

        logger.info(`Removed environment mapping for project ${projectId}`);
        this._onDidRemoveEnvironment.fire({ projectId });
    }

    public async setEnvironmentForProject(projectId: string, environmentId: string): Promise<void> {
        await this.waitForInitialization();

        this.mappings.set(projectId, environmentId);
        await this.saveMappings();

        logger.info(`Mapped project ${projectId} to environment ${environmentId}`);
        this._onDidSetEnvironment.fire({ projectId, environmentId });
    }

    public async waitForInitialization(): Promise<void> {
        await this.initializationPromise;
    }

    /**
     * Load existing project-keyed mappings and run the one-shot migration from
     * the legacy notebook-URI keyed storage.
     */
    private async initialize(): Promise<void> {
        const stored = this.workspaceState.get<Record<string, string>>(DeepnoteProjectEnvironmentMapper.STORAGE_KEY);
        if (stored) {
            this.mappings = new Map(Object.entries(stored));
            logger.info(`Loaded ${this.mappings.size} project-environment mappings`);
        }

        await this.migrateLegacyMappings();
    }

    /**
     * Migrate entries from the legacy `deepnote.notebookEnvironmentMappings`
     * workspace-state key (fsPath → environmentId) to the new project-id keyed
     * key. The migration is a one-shot: after resolving project ids from each
     * `.deepnote` file, the legacy key is cleared.
     *
     * Entries whose project id cannot be resolved (file missing, unparsable)
     * are logged and skipped.
     */
    private async migrateLegacyMappings(): Promise<void> {
        const legacyStored = this.workspaceState.get<Record<string, string>>(
            DeepnoteProjectEnvironmentMapper.LEGACY_STORAGE_KEY
        );

        if (!legacyStored || Object.keys(legacyStored).length === 0) {
            return;
        }

        logger.info(
            `Migrating ${
                Object.keys(legacyStored).length
            } legacy notebook-keyed environment mappings to project-keyed storage`
        );

        // Clear the legacy key up front so the migration is strictly one-shot
        // even if a later step fails. Worst case the user re-picks an env for
        // a project — acceptable, and better than re-running migration on a
        // later activation and overwriting project-keyed entries the user set
        // in between.
        await this.workspaceState.update(DeepnoteProjectEnvironmentMapper.LEGACY_STORAGE_KEY, undefined);

        const migratedEntries: Array<{ projectId: string; environmentId: string }> = [];

        for (const [fsPath, environmentId] of Object.entries(legacyStored)) {
            try {
                const projectId = await resolveProjectIdForFile(Uri.file(fsPath));
                if (!projectId) {
                    logger.warn(`Skipping legacy environment mapping for ${fsPath}: project id could not be resolved`);
                    continue;
                }

                // Last-writer-wins if multiple siblings mapped to different envs
                this.mappings.set(projectId, environmentId);
                migratedEntries.push({ projectId, environmentId });
            } catch (error) {
                logger.warn(`Failed to migrate legacy environment mapping for ${fsPath}`, error);
            }
        }

        await this.saveMappings();

        logger.info(`Migrated ${migratedEntries.length} environment mappings to project-keyed storage`);

        for (const entry of migratedEntries) {
            this._onDidSetEnvironment.fire(entry);
        }
    }

    /**
     * Save mappings to workspace state
     */
    private async saveMappings(): Promise<void> {
        const obj = Object.fromEntries(this.mappings.entries());
        await this.workspaceState.update(DeepnoteProjectEnvironmentMapper.STORAGE_KEY, obj);
    }
}
