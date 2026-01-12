import type { DeepnoteBlock, DeepnoteFile } from '@deepnote/blocks';
import { Uri } from 'vscode';

import type { DeepnoteOutput } from '../../platform/deepnote/deepnoteTypes';

export const ISnapshotFileService = Symbol('ISnapshotFileService');

/**
 * Service interface for managing snapshot files.
 * Handles reading/writing outputs to separate snapshot files.
 */
export interface ISnapshotFileService {
    /** Check if snapshots are enabled for this workspace */
    isSnapshotsEnabled(): boolean;

    /**
     * Read outputs from a snapshot file by searching for files matching the projectId.
     * First tries the 'latest' snapshot, then falls back to the most recent timestamped snapshot.
     * Uses workspace.findFiles() to locate snapshots without needing the project URI.
     */
    readSnapshot(projectId: string): Promise<Map<string, DeepnoteOutput[]> | undefined>;

    /**
     * Create a snapshot of the project data if there are changes.
     * Compares with the existing latest snapshot and skips if content is identical.
     * Writes to a timestamped file first, then copies to 'latest' if successful.
     * Used for "Run All" command to create a historical snapshot.
     * @returns URI of the timestamped snapshot file, or undefined if no changes
     */
    createSnapshot(
        projectUri: Uri,
        projectId: string,
        projectName: string,
        projectData: DeepnoteFile
    ): Promise<Uri | undefined>;

    /**
     * Update only the latest snapshot file without creating a timestamped copy.
     * Used for partial execution (running individual cells, not "Run All").
     * @returns URI of the latest snapshot file, or undefined if no changes
     */
    updateLatestSnapshot(
        projectUri: Uri,
        projectId: string,
        projectName: string,
        projectData: DeepnoteFile
    ): Promise<Uri | undefined>;

    /** Merge outputs from snapshot into notebook blocks, returns new array */
    mergeOutputsIntoBlocks(blocks: DeepnoteBlock[], outputs: Map<string, DeepnoteOutput[]>): DeepnoteBlock[];

    /** Strip outputs from blocks (for saving to main file) */
    stripOutputsFromBlocks(blocks: DeepnoteBlock[]): DeepnoteBlock[];

    /** Extract outputs from blocks into a Map */
    extractOutputsFromBlocks(blocks: DeepnoteBlock[]): Map<string, DeepnoteOutput[]>;
}
