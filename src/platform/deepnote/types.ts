import type { Disposable, Uri } from 'vscode';
import type { DeepnoteFile } from '@deepnote/blocks';

/**
 * Result of a project-metadata propagation pass.
 * `updated` holds the URIs whose on-disk content was rewritten; `failures` holds the
 * per-file errors that did not abort the rest of the pass.
 */
export interface ProjectMetadataPropagationResult {
    updated: Uri[];
    failures: Array<{ uri: Uri; error: unknown }>;
}

export const IDeepnoteProjectMetadataPropagator = Symbol('IDeepnoteProjectMetadataPropagator');

/**
 * Propagates project-level metadata changes across every sibling `.deepnote` file of a
 * project (open or closed) by enumerating the project group on disk and rewriting each file.
 *
 * Because each sibling file carries its own copy of the project-level fields
 * (`project.integrations`, `project.settings`, `project.name`, …), any edit to such a field
 * must be written into all sibling files of the project, or unopened siblings keep stale
 * values. Membership is determined purely by `project.id` on disk — never by which editors
 * happen to be open or which documents the manager has cached.
 */
export interface IDeepnoteProjectMetadataPropagator {
    /**
     * Registers a callback that is invoked synchronously before each file the propagator writes.
     * Used by the file-change watcher for deterministic self-write detection.
     * @returns A disposable that removes the callback.
     */
    onFileWritten(callback: (uri: Uri) => void): Disposable;

    /**
     * Enumerates every `.deepnote` file in the workspace whose `project.id === projectId`,
     * applies `mutator` to each file's project-level fields, and writes it back to disk.
     * Files whose serialized bytes are unchanged by the mutator are skipped (no write, no
     * `modifiedAt` bump). Returns the URIs that were rewritten and any per-file failures.
     * @param projectId The project whose sibling files should be updated
     * @param mutator Mutates the parsed file in place; must touch only project-level fields
     */
    propagateProjectMetadata(
        projectId: string,
        mutator: (file: DeepnoteFile) => void
    ): Promise<ProjectMetadataPropagationResult>;
}
