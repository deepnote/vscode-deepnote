// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { IStartupCodeProvider, IStartupCodeProviders, StartupCodePriority, IKernel } from '../../../kernels/types';
import { JupyterNotebookView } from '../../../platform/common/constants';
import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { SqlIntegrationEnvironmentVariablesProvider } from '../../../platform/notebooks/deepnote/sqlIntegrationEnvironmentVariablesProvider';
import { logger } from '../../../platform/logging';
import { isPythonKernelConnection } from '../../../kernels/helpers';
import { DEEPNOTE_NOTEBOOK_TYPE } from '../../../kernels/deepnote/types';
import { workspace } from 'vscode';

/**
 * Provides startup code to inject SQL integration credentials into the kernel environment.
 * This is necessary because Jupyter doesn't automatically pass all environment variables
 * from the server process to the kernel process.
 */
@injectable()
export class SqlIntegrationStartupCodeProvider implements IStartupCodeProvider, IExtensionSyncActivationService {
    public priority = StartupCodePriority.Base;

    constructor(
        @inject(IStartupCodeProviders) private readonly registry: IStartupCodeProviders,
        @inject(SqlIntegrationEnvironmentVariablesProvider)
        private readonly envVarsProvider: SqlIntegrationEnvironmentVariablesProvider
    ) {}

    activate(): void {
        logger.info('SqlIntegrationStartupCodeProvider: Activating and registering with JupyterNotebookView');
        this.registry.register(this, JupyterNotebookView);
        logger.info('SqlIntegrationStartupCodeProvider: Successfully registered');
    }

    async getCode(kernel: IKernel): Promise<string[]> {
        logger.info(
            `SqlIntegrationStartupCodeProvider.getCode called for kernel ${
                kernel.id
            }, resourceUri: ${kernel.resourceUri?.toString()}`
        );

        // Only run for Python kernels on Deepnote notebooks
        if (!isPythonKernelConnection(kernel.kernelConnectionMetadata)) {
            logger.info(`SqlIntegrationStartupCodeProvider: Not a Python kernel, skipping`);
            return [];
        }

        // Check if this is a Deepnote notebook
        if (!kernel.resourceUri) {
            logger.info(`SqlIntegrationStartupCodeProvider: No resourceUri, skipping`);
            return [];
        }

        const notebook = workspace.notebookDocuments.find((nb) => nb.uri.toString() === kernel.resourceUri?.toString());
        if (!notebook) {
            logger.info(`SqlIntegrationStartupCodeProvider: Notebook not found for ${kernel.resourceUri.toString()}`);
            return [];
        }

        logger.info(`SqlIntegrationStartupCodeProvider: Found notebook with type: ${notebook.notebookType}`);

        if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            logger.info(`SqlIntegrationStartupCodeProvider: Not a Deepnote notebook, skipping`);
            return [];
        }

        try {
            // Get SQL integration environment variables for this notebook
            const envVars = await this.envVarsProvider.getEnvironmentVariables(kernel.resourceUri);

            if (!envVars || Object.keys(envVars).length === 0) {
                logger.trace(
                    `SqlIntegrationStartupCodeProvider: No SQL integration env vars for ${kernel.resourceUri.toString()}`
                );
                return [];
            }

            logger.info(
                `SqlIntegrationStartupCodeProvider: Injecting ${
                    Object.keys(envVars).length
                } SQL integration env vars into kernel: ${Object.keys(envVars).join(', ')}`
            );

            // Generate Python code to set environment variables directly in os.environ
            const code: string[] = [];

            code.push('try:');
            code.push('    import os');
            code.push(`    # [SQL Integration] Setting ${Object.keys(envVars).length} SQL integration env vars...`);

            // Set each environment variable directly in os.environ
            for (const [key, value] of Object.entries(envVars)) {
                if (value) {
                    // Use JSON.stringify to properly escape the value
                    const jsonEscaped = JSON.stringify(value);
                    code.push(`    os.environ['${key}'] = ${jsonEscaped}`);
                }
            }

            code.push(
                `    # [SQL Integration] Successfully set ${Object.keys(envVars).length} SQL integration env vars`
            );
            code.push('except Exception as e:');
            code.push('    import traceback');
            code.push('    print(f"[SQL Integration] ERROR: Failed to set SQL integration env vars: {e}")');
            code.push('    traceback.print_exc()');

            logger.info('SqlIntegrationStartupCodeProvider: Generated startup code');

            return code;
        } catch (error) {
            logger.error('SqlIntegrationStartupCodeProvider: Failed to generate startup code', error);
            return [];
        }
    }
}
