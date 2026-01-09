import type { DeepnoteBlock, DeepnoteFile } from '@deepnote/blocks';
import fastDeepEqual from 'fast-deep-equal';
import { injectable } from 'inversify';
import * as yaml from 'js-yaml';
import { RelativePattern, Uri, workspace } from 'vscode';
import { Utils } from 'vscode-uri';

import { logger } from '../../platform/logging';
import type { DeepnoteOutput } from '../../platform/deepnote/deepnoteTypes';
import { InvalidProjectNameError } from '../../platform/errors/invalidProjectNameError';
import type { ISnapshotFileService } from './snapshotFileServiceTypes';

export { ISnapshotFileService } from './snapshotFileServiceTypes';

/**
 * Slugifies a project name for use in filenames.
 * Converts to lowercase, replaces spaces with hyphens, removes non-alphanumeric chars.
 * @throws Error if the result is empty after transformation
 */
function slugifyProjectName(name: string): string {
    if (typeof name !== 'string' || !name.trim()) {
        throw new InvalidProjectNameError();
    }

    const slug = name
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    if (!slug) {
        throw new InvalidProjectNameError();
    }

    return slug;
}

/**
 * Generates a timestamp string for snapshot filenames.
 * Format: 2025-12-11T10-31-48 (ISO 8601 with colons replaced by hyphens)
 */
function generateTimestamp(): string {
    return new Date().toISOString().replace(/:/g, '-').slice(0, 19);
}

/**
 * Implementation of ISnapshotFileService.
 * Manages snapshot files for Deepnote notebooks.
 */
@injectable()
export class SnapshotFileService implements ISnapshotFileService {
    /**
     * Check if snapshots are enabled via the deepnote.snapshots.enabled setting.
     */
    isSnapshotsEnabled(): boolean {
        const config = workspace.getConfiguration('deepnote');

        return config.get<boolean>('snapshots.enabled', false);
    }

    /**
     * Build the snapshot file path for a project.
     * @param projectUri URI of the main .deepnote file
     * @param projectId Project UUID
     * @param projectName Project name (will be slugified)
     * @param variant 'latest' or a timestamp string
     */
    private buildSnapshotPath(
        projectUri: Uri,
        projectId: string,
        projectName: string,
        variant: 'latest' | string
    ): Uri {
        const parentDir = Uri.joinPath(projectUri, '..');
        const slug = slugifyProjectName(projectName);
        const filename = `${slug}_${projectId}_${variant}.snapshot.deepnote`;

        return Uri.joinPath(parentDir, 'snapshots', filename);
    }

    /**
     * Read outputs from a snapshot file by searching for files matching the projectId.
     * First tries the 'latest' snapshot, then falls back to the most recent timestamped snapshot.
     * Uses workspace.findFiles() with RelativePattern to scope searches to workspace folders.
     * @returns Map of block ID to outputs, or undefined if no snapshot exists or on parse error
     */
    async readSnapshot(projectId: string): Promise<Map<string, DeepnoteOutput[]> | undefined> {
        const workspaceFolders = workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            logger.debug(`[SnapshotFileService] No workspace folders found`);

            return undefined;
        }

        // 1. Try to find a 'latest' snapshot file
        const latestGlob = `**/snapshots/*_${projectId}_latest.snapshot.deepnote`;

        for (const folder of workspaceFolders) {
            const latestPattern = new RelativePattern(folder, latestGlob);
            const latestFiles = await workspace.findFiles(latestPattern, null, 1);

            if (latestFiles.length > 0) {
                logger.debug(`[SnapshotFileService] Found latest snapshot: ${latestFiles[0].fsPath}`);

                try {
                    return await this.parseSnapshotFile(latestFiles[0]);
                } catch (error) {
                    logger.error(`[SnapshotFileService] Failed to parse snapshot: ${latestFiles[0].fsPath}`, error);

                    return undefined;
                }
            }
        }

        logger.debug(`[SnapshotFileService] No latest snapshot found, looking for timestamped files`);

        // 2. Find timestamped snapshots across all workspace folders
        const timestampedGlob = `**/snapshots/*_${projectId}_*.snapshot.deepnote`;
        let allTimestampedFiles: Uri[] = [];

        for (const folder of workspaceFolders) {
            const timestampedPattern = new RelativePattern(folder, timestampedGlob);
            const files = await workspace.findFiles(timestampedPattern, null, 100);

            allTimestampedFiles = allTimestampedFiles.concat(files);
        }

        // Filter out 'latest' files (in case glob matched them) and sort by filename descending
        const sortedFiles = allTimestampedFiles
            .filter((uri) => !uri.fsPath.includes('_latest.'))
            .sort((a, b) => {
                // Sort by filename descending (timestamps sort lexicographically)
                const nameA = Utils.basename(a);
                const nameB = Utils.basename(b);

                return nameB.localeCompare(nameA);
            });

        if (sortedFiles.length === 0) {
            logger.debug(`[SnapshotFileService] No timestamped snapshots found`);

            return undefined;
        }

        const newestFile = sortedFiles[0];

        logger.debug(`[SnapshotFileService] Using timestamped snapshot: ${newestFile.fsPath}`);

        try {
            return await this.parseSnapshotFile(newestFile);
        } catch (error) {
            logger.error(`[SnapshotFileService] Failed to parse snapshot: ${newestFile.fsPath}`, error);

            return undefined;
        }
    }

    /**
     * Parse a snapshot file and extract outputs.
     * @returns Map of block ID to outputs, or empty map if parsing fails or structure is invalid
     */
    private async parseSnapshotFile(path: Uri): Promise<Map<string, DeepnoteOutput[]>> {
        const outputsMap = new Map<string, DeepnoteOutput[]>();

        let snapshotData: unknown;

        try {
            const content = await workspace.fs.readFile(path);
            const contentString = new TextDecoder('utf-8').decode(content);

            snapshotData = yaml.load(contentString);
        } catch (error) {
            logger.error(`[SnapshotFileService] Failed to read or parse snapshot file: ${path.fsPath}`, error);

            return outputsMap;
        }

        // Validate snapshotData is an object
        if (typeof snapshotData !== 'object' || snapshotData === null) {
            logger.error(`[SnapshotFileService] Invalid snapshot structure (not an object): ${path.fsPath}`);

            return outputsMap;
        }

        const data = snapshotData as DeepnoteFile;
        const notebooks = data.project?.notebooks;

        // Validate notebooks is an array
        if (!Array.isArray(notebooks)) {
            logger.debug(`[SnapshotFileService] No notebooks array in snapshot: ${path.fsPath}`);

            return outputsMap;
        }

        for (const notebook of notebooks) {
            const blocks = notebook?.blocks;

            if (!Array.isArray(blocks)) {
                continue;
            }

            for (const block of blocks) {
                if (
                    typeof block === 'object' &&
                    block !== null &&
                    typeof block.id === 'string' &&
                    Array.isArray(block.outputs)
                ) {
                    outputsMap.set(block.id, block.outputs as DeepnoteOutput[]);
                }
            }
        }

        logger.debug(`[SnapshotFileService] Read ${outputsMap.size} block outputs from snapshot`);

        return outputsMap;
    }

    /**
     * Ensures the snapshots directory exists, creating it if necessary.
     * @returns true if directory exists or was created, false on failure
     */
    private async ensureSnapshotsDirectory(snapshotsDir: Uri): Promise<boolean> {
        try {
            await workspace.fs.stat(snapshotsDir);

            return true;
        } catch {
            logger.debug(`[SnapshotFileService] Creating snapshots directory: ${snapshotsDir.fsPath}`);

            try {
                await workspace.fs.createDirectory(snapshotsDir);

                return true;
            } catch (error) {
                logger.error(
                    `[SnapshotFileService] Failed to create snapshots directory: ${snapshotsDir.fsPath}`,
                    error
                );

                return false;
            }
        }
    }

    /**
     * Prepares snapshot data for writing.
     * Checks for changes compared to existing snapshot and serializes to YAML.
     * @returns { latestPath, content } or undefined if no changes detected
     */
    private async prepareSnapshotData(
        projectUri: Uri,
        projectId: string,
        projectName: string,
        projectData: DeepnoteFile
    ): Promise<{ latestPath: Uri; content: Uint8Array } | undefined> {
        const latestPath = this.buildSnapshotPath(projectUri, projectId, projectName, 'latest');
        const snapshotsDir = Uri.joinPath(latestPath, '..');

        // Ensure snapshots directory exists
        const dirExists = await this.ensureSnapshotsDirectory(snapshotsDir);

        if (!dirExists) {
            return undefined;
        }

        // Check if there are changes compared to the existing latest snapshot
        const hasChanges = await this.hasSnapshotChanges(latestPath, projectData);

        if (!hasChanges) {
            return undefined;
        }

        // Prepare snapshot data with timestamp
        const snapshotData = structuredClone(projectData);

        snapshotData.metadata = snapshotData.metadata || { createdAt: new Date().toISOString() };
        snapshotData.metadata.modifiedAt = new Date().toISOString();

        const yamlString = yaml.dump(snapshotData, {
            indent: 2,
            lineWidth: -1,
            noRefs: true,
            sortKeys: false
        });

        const content = new TextEncoder().encode(yamlString);

        return { latestPath, content };
    }

    /**
     * Create a snapshot of the project data if there are changes.
     * Compares with the existing latest snapshot and skips if content is identical.
     *
     * Write strategy: Writes to a timestamped file first, then updates 'latest'.
     * This is not truly atomic (two separate writes), but ensures:
     * - The existing 'latest' file is never corrupted mid-write
     * - If timestamped write fails, nothing changes
     * - If 'latest' write fails, the timestamped snapshot still exists as a recovery point
     *
     * @returns URI of the timestamped snapshot file, or undefined if no changes or on write failure
     */
    async createSnapshot(
        projectUri: Uri,
        projectId: string,
        projectName: string,
        projectData: DeepnoteFile
    ): Promise<Uri | undefined> {
        const prepared = await this.prepareSnapshotData(projectUri, projectId, projectName, projectData);

        if (!prepared) {
            logger.debug(`[SnapshotFileService] No changes detected, skipping snapshot creation`);

            return undefined;
        }

        const { latestPath, content } = prepared;
        const timestamp = generateTimestamp();
        const timestampedPath = this.buildSnapshotPath(projectUri, projectId, projectName, timestamp);

        // Write to timestamped file first (safe - doesn't touch existing files)
        try {
            await workspace.fs.writeFile(timestampedPath, content);
            logger.debug(`[SnapshotFileService] Wrote timestamped snapshot: ${timestampedPath.fsPath}`);
        } catch (error) {
            logger.error(
                `[SnapshotFileService] Failed to write timestamped snapshot: ${timestampedPath.fsPath}`,
                error
            );

            return undefined;
        }

        // Update 'latest' pointer (only after timestamped write succeeded)
        // If this fails, the timestamped snapshot still exists as a recovery point
        try {
            await workspace.fs.writeFile(latestPath, content);
            logger.debug(`[SnapshotFileService] Updated latest snapshot: ${latestPath.fsPath}`);
        } catch (error) {
            logger.warn(
                `[SnapshotFileService] Wrote timestamped snapshot but failed to update latest pointer: ${latestPath.fsPath}. ` +
                    `Timestamped snapshot available at: ${timestampedPath.fsPath}`,
                error
            );
            // Still return timestampedPath since the snapshot data was saved successfully
        }

        return timestampedPath;
    }

    /**
     * Update only the latest snapshot file without creating a timestamped copy.
     * Used for partial execution (running individual cells, not "Run All").
     *
     * @returns URI of the latest snapshot file, or undefined if no changes or on write failure
     */
    async updateLatestSnapshot(
        projectUri: Uri,
        projectId: string,
        projectName: string,
        projectData: DeepnoteFile
    ): Promise<Uri | undefined> {
        const prepared = await this.prepareSnapshotData(projectUri, projectId, projectName, projectData);

        if (!prepared) {
            logger.debug(`[SnapshotFileService] No changes detected, skipping latest snapshot update`);

            return undefined;
        }

        const { latestPath, content } = prepared;

        // Write only to latest file (no timestamped copy for partial runs)
        try {
            await workspace.fs.writeFile(latestPath, content);
            logger.debug(`[SnapshotFileService] Updated latest snapshot: ${latestPath.fsPath}`);

            return latestPath;
        } catch (error) {
            logger.error(`[SnapshotFileService] Failed to update latest snapshot: ${latestPath.fsPath}`, error);

            return undefined;
        }
    }

    /**
     * Check if the project data has changes compared to the existing latest snapshot.
     * Compares the project content excluding metadata timestamps.
     */
    private async hasSnapshotChanges(latestPath: Uri, projectData: DeepnoteFile): Promise<boolean> {
        try {
            const existingContent = await workspace.fs.readFile(latestPath);
            const existingString = new TextDecoder('utf-8').decode(existingContent);
            const existingData = yaml.load(existingString) as DeepnoteFile;

            // Compare the project content (notebooks and their blocks)
            // We exclude metadata since timestamps always change
            const existingProject = this.getComparableProjectContent(existingData);
            const newProject = this.getComparableProjectContent(projectData);

            return !fastDeepEqual(existingProject, newProject);
        } catch {
            // If we can't read the existing snapshot, treat it as having changes
            logger.debug(`[SnapshotFileService] No existing snapshot found, treating as changed`);

            return true;
        }
    }

    /**
     * Extract the comparable content from a DeepnoteFile, excluding timestamps.
     */
    private getComparableProjectContent(data: DeepnoteFile): object {
        return {
            version: data.version,
            project: data.project,
            environment: data.environment,
            execution: data.execution
        };
    }

    /**
     * Merge outputs from a snapshot into notebook blocks.
     * Updates blocks in place.
     */
    mergeOutputsIntoBlocks(blocks: DeepnoteBlock[], outputs: Map<string, DeepnoteOutput[]>): void {
        let mergedCount = 0;

        for (const block of blocks) {
            if (block.id && outputs.has(block.id)) {
                block.outputs = outputs.get(block.id);
                mergedCount++;
            }
        }

        logger.debug(`[SnapshotFileService] Merged outputs into ${mergedCount}/${blocks.length} blocks`);
    }

    /**
     * Strip outputs from blocks for saving to the main file.
     * Returns a new array with outputs removed.
     */
    stripOutputsFromBlocks(blocks: DeepnoteBlock[]): DeepnoteBlock[] {
        return blocks.map((block) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { outputs, ...strippedBlock } = block;

            return strippedBlock as DeepnoteBlock;
        });
    }

    /**
     * Extract outputs from blocks into a Map.
     * @returns Map of block ID to outputs
     */
    extractOutputsFromBlocks(blocks: DeepnoteBlock[]): Map<string, DeepnoteOutput[]> {
        const outputsMap = new Map<string, DeepnoteOutput[]>();

        for (const block of blocks) {
            if (block.id && block.outputs) {
                outputsMap.set(block.id, block.outputs as DeepnoteOutput[]);
            }
        }

        return outputsMap;
    }
}
