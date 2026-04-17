import { serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { l10n, RelativePattern, Uri, window, workspace } from 'vscode';

import { logger } from '../../platform/logging';
import {
    buildSingleNotebookFile,
    computeSnapshotHash,
    getFileStem,
    slugifyNotebookNameOrFallback
} from './deepnoteNotebookFileFactory';
import { slugifyProjectName } from './snapshots/snapshotFiles';

/**
 * Splits multi-notebook .deepnote files into separate files (one notebook per file).
 * All split files share the same project ID and metadata.
 */
export class DeepnoteAutoSplitter {
    /**
     * Checks if a file has more than one non-init notebook and splits it if so.
     * The first non-init notebook (by array order) stays in the original file.
     * Each extra notebook gets its own file with the same project metadata.
     *
     * @returns Info about whether a split happened and which new files were created
     */
    async splitIfNeeded(fileUri: Uri, deepnoteFile: DeepnoteFile): Promise<{ wasSplit: boolean; newFiles: Uri[] }> {
        const initNotebookId = deepnoteFile.project.initNotebookId;

        const nonInitNotebooks = deepnoteFile.project.notebooks.filter((nb) => nb.id !== initNotebookId);

        if (nonInitNotebooks.length <= 1) {
            return { wasSplit: false, newFiles: [] };
        }

        const initNotebook = initNotebookId
            ? deepnoteFile.project.notebooks.find((nb) => nb.id === initNotebookId)
            : undefined;

        // First non-init notebook stays in original file
        const primaryNotebook = nonInitNotebooks[0];
        const extraNotebooks = nonInitNotebooks.slice(1);

        logger.info(
            `[AutoSplitter] Splitting ${nonInitNotebooks.length} notebooks from project ${deepnoteFile.project.id}`
        );

        const parentDir = Uri.joinPath(fileUri, '..');
        const originalStem = getFileStem(fileUri);
        const newFiles: Uri[] = [];

        // Create a new file for each extra notebook
        for (const notebook of extraNotebooks) {
            const notebookSlug = slugifyNotebookNameOrFallback(notebook.name);
            const newFileName = `${originalStem}_${notebookSlug}.deepnote`;
            const newFileUri = Uri.joinPath(parentDir, newFileName);

            const newProject = await buildSingleNotebookFile(deepnoteFile, notebook);

            const yaml = serializeDeepnoteFile(newProject);
            await workspace.fs.writeFile(newFileUri, new TextEncoder().encode(yaml));

            newFiles.push(newFileUri);

            logger.info(`[AutoSplitter] Created ${newFileName} for notebook "${notebook.name}"`);
        }

        // Update original file to keep only primary notebook (+ init)
        const originalNotebooks = initNotebook ? [structuredClone(initNotebook), primaryNotebook] : [primaryNotebook];
        deepnoteFile.project.notebooks = originalNotebooks;

        if (deepnoteFile.metadata) {
            (deepnoteFile.metadata as Record<string, unknown>).snapshotHash = await computeSnapshotHash(deepnoteFile);
        }

        const updatedYaml = serializeDeepnoteFile(deepnoteFile);
        await workspace.fs.writeFile(fileUri, new TextEncoder().encode(updatedYaml));

        // Split snapshot files too
        await this.splitSnapshots(
            fileUri,
            deepnoteFile.project.id,
            deepnoteFile.project.name,
            primaryNotebook.id,
            extraNotebooks.map((nb) => nb.id)
        );

        // Notify the user
        const fileNames = newFiles.map((f) => f.path.split('/').pop()).join(', ');

        void window.showInformationMessage(
            l10n.t(
                'This project had {0} notebooks. They have been split into separate files: {1}',
                nonInitNotebooks.length,
                fileNames
            )
        );

        return { wasSplit: true, newFiles };
    }

    /**
     * Splits existing snapshot files so each notebook gets its own snapshot.
     * Old format: {slug}_{projectId}_{variant}.snapshot.deepnote
     * New format: {slug}_{projectId}_{notebookId}_{variant}.snapshot.deepnote
     */
    private async splitSnapshots(
        _projectFileUri: Uri,
        projectId: string,
        projectName: string,
        primaryNotebookId: string,
        extraNotebookIds: string[]
    ): Promise<void> {
        const workspaceFolders = workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }

        const snapshotGlob = `**/snapshots/*_${projectId}_*.snapshot.deepnote`;
        let allSnapshotFiles: Uri[] = [];

        for (const folder of workspaceFolders) {
            const pattern = new RelativePattern(folder, snapshotGlob);
            const files = await workspace.findFiles(pattern, null, 100);
            allSnapshotFiles = allSnapshotFiles.concat(files);
        }

        if (allSnapshotFiles.length === 0) {
            logger.debug(`[AutoSplitter] No snapshots found for project ${projectId}`);
            return;
        }

        let slug: string;

        try {
            slug = slugifyProjectName(projectName);
        } catch {
            logger.warn(`[AutoSplitter] Cannot slugify project name, skipping snapshot split`);
            return;
        }

        const allNotebookIds = [primaryNotebookId, ...extraNotebookIds];

        for (const snapshotUri of allSnapshotFiles) {
            try {
                await this.splitSingleSnapshot(snapshotUri, slug, projectId, allNotebookIds);
            } catch (error) {
                logger.warn(`[AutoSplitter] Failed to split snapshot ${snapshotUri.path}`, error);
            }
        }
    }

    private async splitSingleSnapshot(
        snapshotUri: Uri,
        slug: string,
        projectId: string,
        notebookIds: string[]
    ): Promise<void> {
        const content = await workspace.fs.readFile(snapshotUri);
        const { deserializeDeepnoteFile: parseFile } = await import('@deepnote/blocks');
        const snapshotData = parseFile(new TextDecoder().decode(content));

        const snapshotDir = Uri.joinPath(snapshotUri, '..');

        // Extract variant from existing filename
        const basename = snapshotUri.path.split('/').pop() ?? '';
        const variant = this.extractVariantFromSnapshotFilename(basename, projectId);

        if (!variant) {
            logger.debug(`[AutoSplitter] Could not extract variant from ${basename}, skipping`);
            return;
        }

        // Create per-notebook snapshot files
        for (const notebookId of notebookIds) {
            const notebookData = structuredClone(snapshotData);

            // Keep only this notebook (and init)
            notebookData.project.notebooks = notebookData.project.notebooks.filter(
                (nb) =>
                    nb.id === notebookId ||
                    (notebookData.project.initNotebookId && nb.id === notebookData.project.initNotebookId)
            );

            // Recompute hash
            if (notebookData.metadata) {
                (notebookData.metadata as Record<string, unknown>).snapshotHash = await computeSnapshotHash(
                    notebookData
                );
            }

            const newFilename = `${slug}_${projectId}_${notebookId}_${variant}.snapshot.deepnote`;
            const newUri = Uri.joinPath(snapshotDir, newFilename);
            const yaml = serializeDeepnoteFile(notebookData);

            await workspace.fs.writeFile(newUri, new TextEncoder().encode(yaml));

            logger.debug(`[AutoSplitter] Created notebook snapshot: ${newFilename}`);
        }

        // Delete the old snapshot file (it's been replaced by per-notebook files)
        try {
            await workspace.fs.delete(snapshotUri);
            logger.debug(`[AutoSplitter] Deleted old snapshot: ${basename}`);
        } catch {
            logger.warn(`[AutoSplitter] Failed to delete old snapshot: ${basename}`);
        }
    }

    /**
     * Extracts the variant portion from a snapshot filename.
     * Old format: {slug}_{projectId}_{variant}.snapshot.deepnote
     */
    private extractVariantFromSnapshotFilename(basename: string, projectId: string): string | undefined {
        const suffix = '.snapshot.deepnote';

        if (!basename.endsWith(suffix)) {
            return undefined;
        }

        const withoutSuffix = basename.slice(0, -suffix.length);
        const projectIdIndex = withoutSuffix.indexOf(`_${projectId}_`);

        if (projectIdIndex === -1) {
            return undefined;
        }

        return withoutSuffix.slice(projectIdIndex + 1 + projectId.length + 1);
    }
}
