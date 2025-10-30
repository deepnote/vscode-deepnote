import { inject, injectable } from 'inversify';
import {
    type NotebookDocument,
    ProgressLocation,
    window,
    CancellationTokenSource,
    type CancellationToken,
    l10n
} from 'vscode';

import { logger } from '../../platform/logging';
import { IDeepnoteNotebookManager } from '../types';
import type { DeepnoteProject, DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';
import { IKernelProvider } from '../../kernels/types';
import { getDisplayPath } from '../../platform/common/platform/fs-paths';

/**
 * Service responsible for running init notebooks before the main notebook starts.
 * Init notebooks typically contain setup code like pip installs.
 */
@injectable()
export class DeepnoteInitNotebookRunner {
    constructor(
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(IKernelProvider) private readonly kernelProvider: IKernelProvider
    ) {}

    /**
     * Runs the init notebook if it exists and hasn't been run yet for this project.
     * This should be called after the kernel is started but before user code executes.
     * @param notebook The notebook document
     * @param projectId The Deepnote project ID
     * @param token Optional cancellation token to stop execution if notebook is closed
     */
    async runInitNotebookIfNeeded(
        projectId: string,
        notebook: NotebookDocument,
        token?: CancellationToken
    ): Promise<void> {
        try {
            // Check for cancellation before starting
            if (token?.isCancellationRequested) {
                logger.info(`Init notebook cancelled before start for project ${projectId}`);
                return;
            }

            // Check if init notebook has already run for this project
            if (this.notebookManager.hasInitNotebookBeenRun(projectId)) {
                logger.info(`Init notebook already ran for project ${projectId}, skipping`);
                return;
            }

            if (token?.isCancellationRequested) {
                logger.info(`Init notebook cancelled for project ${projectId}`);
                return;
            }

            // Get the project data
            const project = this.notebookManager.getOriginalProject(projectId) as DeepnoteProject | undefined;
            if (!project) {
                logger.warn(`Project ${projectId} not found, cannot run init notebook`);
                return;
            }

            // Check if project has an init notebook ID
            const initNotebookId = (project.project as { initNotebookId?: string }).initNotebookId;
            if (!initNotebookId) {
                logger.info(`No init notebook configured for project ${projectId}`);
                // Mark as run so we don't check again
                this.notebookManager.markInitNotebookAsRun(projectId);
                return;
            }

            // Find the init notebook
            const initNotebook = project.project.notebooks.find((nb) => nb.id === initNotebookId);
            if (!initNotebook) {
                logger.warn(
                    `Init notebook ${initNotebookId} not found in project ${projectId}, skipping initialization`
                );
                this.notebookManager.markInitNotebookAsRun(projectId);
                return;
            }

            if (token?.isCancellationRequested) {
                logger.info(`Init notebook cancelled before execution for project ${projectId}`);
                return;
            }

            logger.info(`Running init notebook "${initNotebook.name}" (${initNotebookId}) for project ${projectId}`);

            // Execute the init notebook with progress
            const success = await this.executeInitNotebook(notebook, initNotebook, token);

            if (success) {
                // Mark as run so we don't run it again
                this.notebookManager.markInitNotebookAsRun(projectId);
                logger.info(`Init notebook completed successfully for project ${projectId}`);
            } else {
                logger.warn(`Init notebook did not execute for project ${projectId} - kernel not available`);
            }
        } catch (error) {
            // Check if this is a cancellation error
            if (error instanceof Error && error.message === 'Cancelled') {
                logger.info(`Init notebook cancelled for project ${projectId}`);
                return;
            }
            // Log error but don't throw - we want to let user continue anyway
            logger.error(`Error running init notebook for project ${projectId}:`, error);
            // Still mark as run to avoid retrying on every notebook open
            this.notebookManager.markInitNotebookAsRun(projectId);
        }
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
            // Note: This should always exist because onKernelStarted already fired
            const kernel = this.kernelProvider.get(notebook);
            if (!kernel) {
                logger.error(
                    `No kernel found for ${getDisplayPath(
                        notebook.uri
                    )} even after onDidStartKernel fired - this should not happen`
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
                5
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
                    90 / codeBlocks.length // Reserve 5% for start, 5% for finish
                );

                logger.info(`Executing init notebook block ${i + 1}/${codeBlocks.length}`);

                try {
                    // Execute the code silently in the background
                    const outputs = await kernelExecution.executeHidden(block.content ?? '');

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
            progress(`✓ Initialization complete! Environment ready.`, 5);

            // Give user a moment to see the completion message
            await new Promise((resolve) => setTimeout(resolve, 1000));

            return true;
        } catch (error) {
            logger.error(`Error in executeInitNotebook:`, error);
            throw error;
        }
    }
}

export const IDeepnoteInitNotebookRunner = Symbol('IDeepnoteInitNotebookRunner');
export interface IDeepnoteInitNotebookRunner {
    runInitNotebookIfNeeded(projectId: string, notebook: NotebookDocument, token?: CancellationToken): Promise<void>;
}
