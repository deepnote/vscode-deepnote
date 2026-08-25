import { inject, injectable } from 'inversify';
import { CancellationToken, CancellationTokenSource, commands, window } from 'vscode';

import { getDisplayPath } from '../../platform/common/platform/fs-paths.node';
import { IDisposable, Resource } from '../../platform/common/types';
import { Common, DataScience } from '../../platform/common/utils/localize';
import { getPythonEnvDisplayName } from '../../platform/interpreter/helpers';
import { ProductNames } from '../../platform/interpreter/installer/productNames';
import { IInstaller, InstallerResponse, Product } from '../../platform/interpreter/installer/types';
import { logger } from '../../platform/logging';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { DeepnoteToolkitDependencyResponse, IDeepnoteToolkitDependencyService } from './types';

const SELECT_INTERPRETER_COMMAND = 'python.setInterpreter';

/**
 * Asks for consent before installing deepnote-toolkit into the user's interpreter, mirroring
 * `KernelDependencyService` — same prompt shape, same "cancel is not a failure" semantics.
 *
 * It cannot reuse that service directly: `installMissingDependencies` is keyed on a
 * `KernelConnectionMetadata`, and a Deepnote connection cannot exist until the toolkit server is
 * running and has reported the kernels it offers — which is precisely what this check gates.
 */
@injectable()
export class DeepnoteToolkitDependencyService implements IDeepnoteToolkitDependencyService {
    constructor(@inject(IInstaller) private readonly installer: IInstaller) {}

    public async ensureToolkitInstalled(
        interpreter: PythonEnvironment,
        resource: Resource,
        token: CancellationToken
    ): Promise<DeepnoteToolkitDependencyResponse> {
        if (await this.installer.isInstalled(Product.deepnoteToolkit, interpreter)) {
            return DeepnoteToolkitDependencyResponse.ok;
        }

        if (token.isCancellationRequested) {
            return DeepnoteToolkitDependencyResponse.cancel;
        }

        const moduleName = ProductNames.get(Product.deepnoteToolkit)!;
        const message = DataScience.libraryRequiredToLaunchJupyterKernelNotInstalledInterpreter(
            getPythonEnvDisplayName(interpreter) || getDisplayPath(interpreter.uri),
            moduleName
        );
        const selectInterpreter = DataScience.selectDifferentPythonInterpreter;

        logger.info(`${moduleName} missing for ${getDisplayPath(resource)}, prompting to install`);

        const selection = await window.showInformationMessage(
            message,
            { modal: true },
            Common.install,
            selectInterpreter
        );

        if (selection === selectInterpreter) {
            await commands.executeCommand(SELECT_INTERPRETER_COMMAND);

            return DeepnoteToolkitDependencyResponse.selectDifferentInterpreter;
        }

        if (selection !== Common.install) {
            logger.info(`User declined to install ${moduleName}`);

            return DeepnoteToolkitDependencyResponse.cancel;
        }

        return this.install(interpreter, moduleName, token);
    }

    private async install(
        interpreter: PythonEnvironment,
        moduleName: string,
        token: CancellationToken
    ): Promise<DeepnoteToolkitDependencyResponse> {
        const cts = new CancellationTokenSource();
        let cancellationListener: IDisposable | undefined;

        try {
            cancellationListener = token.onCancellationRequested(() => cts.cancel());

            const result = await this.installer.install(Product.deepnoteToolkit, interpreter, cts);

            if (result === InstallerResponse.Installed) {
                return DeepnoteToolkitDependencyResponse.ok;
            }

            if (result === InstallerResponse.Cancelled || token.isCancellationRequested) {
                logger.info(`${moduleName} installation cancelled`);

                return DeepnoteToolkitDependencyResponse.cancel;
            }

            logger.error(`${moduleName} installation did not complete: ${InstallerResponse[result]}`);

            return DeepnoteToolkitDependencyResponse.failed;
        } finally {
            cancellationListener?.dispose();
            cts.dispose();
        }
    }
}
