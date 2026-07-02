import type { DeepnoteFile } from '@deepnote/blocks';
import { isValidSiblingInitCandidate } from '@deepnote/convert';
import { inject, injectable } from 'inversify';
import {
    type NotebookDocument,
    ProgressLocation,
    Uri,
    window,
    workspace,
    CancellationTokenSource,
    type CancellationToken,
    l10n
} from 'vscode';

import { logger } from '../../platform/logging';
import type { DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';
import { DEEPNOTE_NOTEBOOK_TYPE } from '../../kernels/deepnote/types';
import { IKernel, IKernelProvider } from '../../kernels/types';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { getDisplayPath } from '../../platform/common/platform/fs-paths.node';
import { readDeepnoteProjectFile } from '../../platform/deepnote/deepnoteProjectFileReader';
import { resolveProjectIdForNotebook } from '../../platform/deepnote/deepnoteProjectIdResolver';
import { IDeepnoteNotebookManager } from '../types';

const DEEPNOTE_FILE_EXTENSION = '.deepnote';
const SNAPSHOT_FILE_SUFFIX = '.snapshot.deepnote';

// How long to keep the "initialization complete" message visible before resolving.
const INIT_COMPLETE_DISPLAY_DELAY_MS = 1000;

// Progress weighting for the init run (sums to 100 across start + per-block + finish).
const INIT_PROGRESS_START_INCREMENT = 5;
const INIT_PROGRESS_BLOCKS_INCREMENT = 90;
const INIT_PROGRESS_FINISH_INCREMENT = 5;

const DEEPNOTE_CLOUD_INIT_NOTEBOOK_BLOCK_CONTENT = `%%bash
# If your project has a 'requirements.txt' file, we'll install it here.
if test -f requirements.txt
  then
    pip install -r ./requirements.txt
  else echo "There's no requirements.txt, so nothing to install."
fi`.trim();

const VSCODE_INIT_NOTEBOOK_BLOCK_CONTENT = `import os, sys, subprocess

if os.path.exists("requirements.txt"):
    print("Installing requirements.txt")
    subprocess.run([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"], check=False)
else:
    print("There's no requirements.txt, so nothing to install.")`.trim();

/**
 * Runs a project's init notebook (from its sibling `.deepnote` file, referenced by
 * `project.initNotebookId`) in the kernel on start, and again on restart. Tracked per kernel — not
 * per project/URI — so a same-environment restart re-initializes correctly.
 */
@injectable()
export class DeepnoteInitNotebookRunner implements IDeepnoteInitNotebookRunner, IExtensionSyncActivationService {
    // Kernels that have already run init in their current lifetime; entries are collected on dispose.
    private readonly initRunByKernel = new WeakSet<IKernel>();
    // In-flight init run per kernel, so a restart can cancel a still-running start-triggered run.
    private readonly inFlightInitByKernel = new WeakMap<IKernel, CancellationTokenSource>();

    constructor(
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(IKernelProvider) private readonly kernelProvider: IKernelProvider,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry
    ) {}

    public activate(): void {
        // A restart fires onDidRestartKernel (not onDidStartKernel) and must always re-run init.
        this.kernelProvider.onDidStartKernel(this.onDidStartKernel, this, this.disposables);
        this.kernelProvider.onDidRestartKernel(this.onDidRestartKernel, this, this.disposables);
    }

    private async onDidStartKernel(kernel: IKernel): Promise<void> {
        if (this.initRunByKernel.has(kernel) || this.inFlightInitByKernel.has(kernel)) {
            return;
        }

        await this.runInitForKernel(kernel);

        // Mark even when no init was found — only affects THIS kernel; a new kernel re-scans.
        this.initRunByKernel.add(kernel);
    }

    private async onDidRestartKernel(kernel: IKernel): Promise<void> {
        // A restart loses all in-kernel state, so re-run init unconditionally.
        this.inFlightInitByKernel.get(kernel)?.cancel();
        await this.runInitForKernel(kernel);
        this.initRunByKernel.add(kernel);
    }

    /**
     * Runs the init notebook for a kernel, sourcing it from the project's sibling init file.
     * Never throws — failures are logged so the user can continue.
     */
    private async runInitForKernel(kernel: IKernel): Promise<void> {
        const notebook = kernel.notebook;

        // Only Deepnote notebooks have init notebooks.
        if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        try {
            const projectId = await resolveProjectIdForNotebook(notebook);
            if (!projectId) {
                logger.info(
                    `No Deepnote project id resolved for ${getDisplayPath(notebook.uri)}, skipping init notebook`
                );
                return;
            }

            const notebookId = notebook.metadata?.deepnoteNotebookId as string | undefined;
            const initNotebookId = notebookId
                ? this.notebookManager.getProjectForNotebook(projectId, notebookId)?.project.initNotebookId
                : undefined;
            if (!initNotebookId) {
                logger.info(`No init notebook configured for project ${projectId}, skipping init`);
                return;
            }

            const initNotebook = await this.findSiblingInitNotebook(notebook, projectId, initNotebookId);
            if (!initNotebook) {
                logger.warn(
                    `No valid sibling init file found for project ${projectId} (initNotebookId ${initNotebookId}), skipping init`
                );
                return;
            }

            logger.info(
                `Running init notebook "${
                    initNotebook.name
                }" (${initNotebookId}) for project ${projectId} in kernel for ${getDisplayPath(notebook.uri)}`
            );

            // Cancel if the notebook is closed mid-init. Per-run state — do NOT register in `disposables`.
            const cts = new CancellationTokenSource();
            this.inFlightInitByKernel.set(kernel, cts);
            const closeListener = workspace.onDidCloseNotebookDocument((closedNotebook) => {
                if (closedNotebook.uri.toString() === notebook.uri.toString()) {
                    logger.info(`Notebook closed while init notebook was running, cancelling for project ${projectId}`);
                    cts.cancel();
                }
            });

            try {
                const success = await this.executeInitNotebook(notebook, initNotebook, cts.token);

                if (success) {
                    logger.info(`Init notebook completed successfully for project ${projectId}`);
                } else {
                    logger.warn(`Init notebook did not execute for project ${projectId} - kernel not available`);
                }
            } finally {
                closeListener.dispose();
                // Only clear if a superseding restart hasn't already replaced our CTS.
                if (this.inFlightInitByKernel.get(kernel) === cts) {
                    this.inFlightInitByKernel.delete(kernel);
                }
                cts.dispose();
            }
        } catch (error) {
            // Log error but don't throw - we want to let the user continue anyway.
            logger.error(`Error running init notebook for ${getDisplayPath(notebook.uri)}:`, error);
        }
    }

    /**
     * Scans sibling `.deepnote` files (skipping snapshots) and returns the single notebook of the
     * first valid init source (same `project.id`, one notebook matching `initNotebookId`), or
     * undefined if none.
     */
    private async findSiblingInitNotebook(
        notebook: NotebookDocument,
        projectId: string,
        initNotebookId: string
    ): Promise<DeepnoteNotebook | undefined> {
        const dirUri = Uri.joinPath(notebook.uri, '..');

        let entries: [string, number][];
        try {
            entries = await workspace.fs.readDirectory(dirUri);
        } catch (error) {
            logger.warn(`Failed to read directory ${getDisplayPath(dirUri)} while looking for init notebook:`, error);
            return undefined;
        }

        for (const [name] of entries) {
            if (!name.endsWith(DEEPNOTE_FILE_EXTENSION) || name.endsWith(SNAPSHOT_FILE_SUFFIX)) {
                continue;
            }

            const candidateUri = Uri.joinPath(dirUri, name);
            try {
                const candidate: DeepnoteFile = await readDeepnoteProjectFile(candidateUri);
                const validation = isValidSiblingInitCandidate(candidate, projectId, initNotebookId);

                if (validation.valid) {
                    return candidate.project.notebooks[0];
                }
            } catch (error) {
                // One unreadable/invalid file must not stop the scan of the rest.
                logger.warn(`Failed to read candidate init file ${getDisplayPath(candidateUri)}:`, error);
            }
        }

        return undefined;
    }

    /**
     * Executes the init notebook's code blocks in the kernel.
     * @param notebook The notebook document (for kernel context)
     * @param initNotebook The init notebook to execute
     * @param token Optional cancellation token from parent operation
     * @returns True if execution completed, false if kernel was not available
     */
    private async executeInitNotebook(
        notebook: NotebookDocument,
        initNotebook: DeepnoteNotebook,
        token?: CancellationToken
    ): Promise<boolean> {
        // Check for cancellation before starting
        if (token?.isCancellationRequested) {
            logger.info(`Init notebook execution cancelled before start`);
            return false;
        }

        // Show progress in both notification AND window for maximum visibility
        const cancellationTokenSource = new CancellationTokenSource();

        // Link parent token to our local token if provided
        const tokenDisposable = token?.onCancellationRequested(() => {
            cancellationTokenSource.cancel();
        });

        // Create a wrapper that reports to both progress locations
        const executeWithDualProgress = async () => {
            return window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: l10n.t(`🚀 Initializing project environment`),
                    cancellable: false
                },
                async (notificationProgress) => {
                    return window.withProgress(
                        {
                            location: ProgressLocation.Window,
                            title: l10n.t(`Init: "${initNotebook.name}"`),
                            cancellable: false
                        },
                        async (windowProgress) => {
                            // Helper to report to both progress bars
                            const reportProgress = (message: string, increment: number) => {
                                notificationProgress.report({ message, increment });
                                windowProgress.report({ message, increment });
                            };

                            return this.executeInitNotebookImpl(
                                notebook,
                                initNotebook,
                                reportProgress,
                                cancellationTokenSource.token
                            );
                        }
                    );
                }
            );
        };

        try {
            return await executeWithDualProgress();
        } finally {
            tokenDisposable?.dispose();
            cancellationTokenSource.dispose();
        }
    }

    private async executeInitNotebookImpl(
        notebook: NotebookDocument,
        initNotebook: DeepnoteNotebook,
        progress: (message: string, increment: number) => void,
        token: CancellationToken
    ): Promise<boolean> {
        try {
            // Check for cancellation
            if (token.isCancellationRequested) {
                logger.info(`Init notebook execution cancelled`);
                return false;
            }

            progress(`Running init notebook "${initNotebook.name}"...`, 0);

            // Get the kernel for this notebook
            // Note: This should always exist because the kernel start/restart event already fired
            const kernel = this.kernelProvider.get(notebook);
            if (!kernel) {
                logger.error(
                    `No kernel found for ${getDisplayPath(
                        notebook.uri
                    )} even after the kernel start/restart event fired - this should not happen`
                );
                return false;
            }

            logger.info(`Kernel found for ${getDisplayPath(notebook.uri)}, starting init notebook execution`);

            // Filter out non-code blocks
            const codeBlocks = initNotebook.blocks.filter((block) => block.type === 'code');

            if (codeBlocks.length === 0) {
                logger.info(`Init notebook has no code blocks, skipping execution`);
                return true; // Not an error - just nothing to execute
            }

            logger.info(`Executing ${codeBlocks.length} code blocks from init notebook`);
            progress(
                `Preparing to execute ${codeBlocks.length} initialization ${
                    codeBlocks.length === 1 ? 'block' : 'blocks'
                }...`,
                INIT_PROGRESS_START_INCREMENT
            );

            // Check for cancellation
            if (token.isCancellationRequested) {
                logger.info(`Init notebook execution cancelled before starting blocks`);
                return false;
            }

            // Get kernel execution
            const kernelExecution = this.kernelProvider.getKernelExecution(kernel);

            // Execute each code block sequentially
            for (let i = 0; i < codeBlocks.length; i++) {
                // Check for cancellation between blocks
                if (token.isCancellationRequested) {
                    logger.info(`Init notebook execution cancelled after block ${i}`);
                    return false;
                }

                const block = codeBlocks[i];
                const percentComplete = Math.min(100, Math.floor(((i + 1) / codeBlocks.length) * 100));

                // Show more detailed progress with percentage
                progress(
                    `[${percentComplete}%] Executing block ${i + 1} of ${codeBlocks.length}...`,
                    INIT_PROGRESS_BLOCKS_INCREMENT / codeBlocks.length
                );

                logger.info(`Executing init notebook block ${i + 1}/${codeBlocks.length}`);

                try {
                    // Make sure the init notebook execution works cross-platform
                    let blockContent = block.content ?? '';
                    const isWindows = process.platform === 'win32';
                    if (isWindows && blockContent.trim() === DEEPNOTE_CLOUD_INIT_NOTEBOOK_BLOCK_CONTENT) {
                        blockContent = VSCODE_INIT_NOTEBOOK_BLOCK_CONTENT;
                        logger.info(
                            `Replacing Deepnote Cloud init notebook block ${
                                i + 1
                            } content with VSCode init notebook block`
                        );
                    }

                    // Execute the code silently in the background
                    const outputs = await kernelExecution.executeHidden(blockContent);

                    // Log outputs for debugging
                    if (outputs && outputs.length > 0) {
                        logger.info(`Init notebook block ${i + 1} produced ${outputs.length} outputs`);

                        // Check for errors in outputs
                        const errors = outputs.filter(
                            (output: { output_type?: string }) => output.output_type === 'error'
                        );
                        if (errors.length > 0) {
                            logger.warn(`Init notebook block ${i + 1} produced errors:`, errors);
                        }
                    }
                } catch (blockError) {
                    // Log error but continue with next block
                    logger.error(`Error executing init notebook block ${i + 1}:`, blockError);
                }
            }

            logger.info(`Completed executing all init notebook blocks`);
            progress(`✓ Initialization complete! Environment ready.`, INIT_PROGRESS_FINISH_INCREMENT);

            // Give user a moment to see the completion message
            await new Promise((resolve) => setTimeout(resolve, INIT_COMPLETE_DISPLAY_DELAY_MS));

            return true;
        } catch (error) {
            logger.error(`Error in executeInitNotebook:`, error);
            throw error;
        }
    }
}

export const IDeepnoteInitNotebookRunner = Symbol('IDeepnoteInitNotebookRunner');
export interface IDeepnoteInitNotebookRunner {
    activate(): void;
}
