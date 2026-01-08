import type { DeepnoteBlock, DeepnoteFile } from '@deepnote/blocks';
import { injectable } from 'inversify';
import * as yaml from 'js-yaml';
import { Uri, workspace } from 'vscode';
import { Utils } from 'vscode-uri';

import { logger } from '../../platform/logging';
import type { DeepnoteOutput } from '../../platform/deepnote/deepnoteTypes';
import type { ISnapshotFileService } from './snapshotFileServiceTypes';

export { ISnapshotFileService } from './snapshotFileServiceTypes';

/**
 * Slugifies a project name for use in filenames.
 * Converts to lowercase, replaces spaces with hyphens, removes non-alphanumeric chars.
 * @throws Error if the result is empty after transformation
 */
function slugifyProjectName(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    if (!slug) {
        throw new Error('Project name cannot be empty or contain only special characters');
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
     * Uses workspace.findFiles() to locate snapshots without needing the project URI.
     * @returns Map of block ID to outputs, or undefined if no snapshot exists
     */
    async readSnapshot(projectId: string): Promise<Map<string, DeepnoteOutput[]> | undefined> {
        // 1. Try to find a 'latest' snapshot file
        const latestPattern = `**/snapshots/*_${projectId}_latest.snapshot.deepnote`;
        const latestFiles = await workspace.findFiles(latestPattern, null, 1);

        if (latestFiles.length > 0) {
            logger.debug(`[SnapshotFileService] Found latest snapshot: ${latestFiles[0].fsPath}`);

            return this.parseSnapshotFile(latestFiles[0]);
        }

        logger.debug(`[SnapshotFileService] No latest snapshot found, looking for timestamped files`);

        // 2. Find timestamped snapshots
        const timestampedPattern = `**/snapshots/*_${projectId}_*.snapshot.deepnote`;
        const timestampedFiles = await workspace.findFiles(timestampedPattern, null, 100);

        // Filter out 'latest' files (in case glob matched them) and sort by filename descending
        const sortedFiles = timestampedFiles
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

        return this.parseSnapshotFile(newestFile);
    }

    /**
     * Parse a snapshot file and extract outputs.
     */
    private async parseSnapshotFile(path: Uri): Promise<Map<string, DeepnoteOutput[]>> {
        const content = await workspace.fs.readFile(path);
        const contentString = new TextDecoder('utf-8').decode(content);
        const snapshotData = yaml.load(contentString) as DeepnoteFile;

        const outputsMap = new Map<string, DeepnoteOutput[]>();

        for (const notebook of snapshotData.project?.notebooks ?? []) {
            for (const block of notebook.blocks ?? []) {
                if (block.id && block.outputs) {
                    outputsMap.set(block.id, block.outputs as DeepnoteOutput[]);
                }
            }
        }

        logger.debug(`[SnapshotFileService] Read ${outputsMap.size} block outputs from snapshot`);

        return outputsMap;
    }

    /**
     * Create a snapshot of the project data if there are changes.
     * Compares with the existing latest snapshot and skips if content is identical.
     * Writes to a timestamped file first, then copies to 'latest' if successful.
     * This ensures atomic operation - existing files aren't corrupted on failure.
     * @returns URI of the timestamped snapshot file, or undefined if no changes
     */
    async createSnapshot(
        projectUri: Uri,
        projectId: string,
        projectName: string,
        projectData: DeepnoteFile
    ): Promise<Uri | undefined> {
        const latestPath = this.buildSnapshotPath(projectUri, projectId, projectName, 'latest');
        const snapshotsDir = Uri.joinPath(latestPath, '..');

        // Ensure snapshots directory exists
        try {
            await workspace.fs.stat(snapshotsDir);
        } catch {
            logger.debug(`[SnapshotFileService] Creating snapshots directory: ${snapshotsDir.fsPath}`);
            await workspace.fs.createDirectory(snapshotsDir);
        }

        // Check if there are changes compared to the existing latest snapshot
        const hasChanges = await this.hasSnapshotChanges(latestPath, projectData);

        if (!hasChanges) {
            logger.debug(`[SnapshotFileService] No changes detected, skipping snapshot creation`);

            return undefined;
        }

        const timestamp = generateTimestamp();
        const timestampedPath = this.buildSnapshotPath(projectUri, projectId, projectName, timestamp);

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

        // Write to timestamped file first (safe - doesn't touch existing files)
        await workspace.fs.writeFile(timestampedPath, content);
        logger.debug(`[SnapshotFileService] Wrote timestamped snapshot: ${timestampedPath.fsPath}`);

        // Copy to latest (only after timestamped write succeeded)
        await workspace.fs.writeFile(latestPath, content);
        logger.debug(`[SnapshotFileService] Updated latest snapshot: ${latestPath.fsPath}`);

        return timestampedPath;
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

            const existingJson = JSON.stringify(existingProject);
            const newJson = JSON.stringify(newProject);

            return existingJson !== newJson;
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
