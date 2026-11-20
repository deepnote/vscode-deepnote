import type { DeepnoteFile } from '@deepnote/blocks';
import type { IOutput } from '@deepnote/runtime-core';
import type { Router } from 'express';
import type { CancellationToken, Uri } from 'vscode';

/** An input value a page can pass to `run()`, as Deepnote's `POST /v2/runs` accepts it. */
export type AppPreviewInputValue = string | boolean | string[];

/** A block of a run's snapshot, as Deepnote's `GET /v2/runs/:runId` lists it in `snapshotBlocks`. */
export interface SnapshotBlock {
    id: string;
    metadata: Record<string, unknown>;
    outputHead: null;
    outputs: IOutput[];
    outputTail: null;
    type: string;
}

export interface AppPreviewRunRequest {
    file: DeepnoteFile;
    fileUri: Uri;
    inputs: Record<string, AppPreviewInputValue>;
    notebookId: string;
}

export interface AppPreviewRunOutcome {
    error: string | null;
    snapshotBlocks: SnapshotBlock[] | null;
    status: 'success' | 'error' | 'internal_error' | 'stopped';
}

/** A run as Deepnote's `GET /v2/runs/:runId` answers it, without the snapshot fields a local run never has. */
export interface PreviewRun {
    completedAt: string | null;
    createdAt: string;
    error: string | null;
    notebookId: string;
    runId: string;
    snapshotBlocks: AppPreviewRunOutcome['snapshotBlocks'];
    snapshotStatus: 'pending' | 'available' | 'unavailable';
    status: 'pending' | 'running' | AppPreviewRunOutcome['status'];
}

export interface AppPreviewApi {
    router: Router;
    /** The preview's runs by ID, trimmed as `PreviewRuns` describes. */
    runs: Map<string, PreviewRun>;
    /**
     * Cancels every unfinished run, which stops its kernel once it has one. `POST /runs` starts no run from then on and
     * answers 503 instead, also to a request that was still looking up its notebook.
     */
    dispose(): void;
}

export const IAppPreviewRunner = Symbol('IAppPreviewRunner');
export interface IAppPreviewRunner {
    /**
     * Runs the notebook `notebookId` of `file`, the `.deepnote` file the caller read from `fileUri`, in a new kernel on
     * the toolkit server the extension runs for that file: the project's init notebook first, with its saved inputs,
     * then the notebook with `inputs` applied. `onRunning` is called once the kernel is up, before the first block.
     * Cancelling `token` ends the run as `stopped`, and once the kernel is up also stops the block that is executing
     * and shuts the kernel down. Never rejects: failures are reported in the outcome.
     */
    run(request: AppPreviewRunRequest, token: CancellationToken, onRunning: () => void): Promise<AppPreviewRunOutcome>;
}
