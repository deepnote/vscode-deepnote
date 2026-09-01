import { inject, injectable } from 'inversify';
import { CancellationToken, CancellationTokenSource, commands, window } from 'vscode';

import { Commands } from '../../platform/common/constants';
import { getDisplayPath } from '../../platform/common/platform/fs-paths.node';
import { IDisposable, Resource } from '../../platform/common/types';
import { Common, DataScience } from '../../platform/common/utils/localize';
import { getPythonEnvDisplayName } from '../../platform/interpreter/helpers';
import { ProductNames } from '../../platform/interpreter/installer/productNames';
import { IInstaller, InstallerResponse, Product } from '../../platform/interpreter/installer/types';
import { raceCancellation } from '../../platform/common/cancellation';
import { noop } from '../../platform/common/utils/misc';
import { logger } from '../../platform/logging';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { getComparisonKey } from '../../platform/vscode-path/resources';
import { DeepnoteToolkitDependencyResponse, IDeepnoteToolkitDependencyService } from './types';

// The per-notebook picker, not the Python extension's `python.setInterpreter`: that one changes
// the workspace selection, which a notebook's own pin overrides — so the prompt would reappear
// unchanged on the next run.
const SELECT_INTERPRETER_COMMAND = Commands.SelectInterpreterForNotebook;

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
    /**
     * In-flight checks, keyed on the interpreter as `KernelDependencyService` does. The contended
     * resource is that interpreter's site-packages, so two notebooks sharing one must join rather
     * than each raise their own prompt and run their own pip.
     */
    private readonly pendingChecks = new Map<string, Promise<DeepnoteToolkitDependencyResponse>>();

    constructor(@inject(IInstaller) private readonly installer: IInstaller) {}

    public async ensureToolkitInstalled(
        interpreter: PythonEnvironment,
        resource: Resource,
        token: CancellationToken
    ): Promise<DeepnoteToolkitDependencyResponse> {
        const key = getComparisonKey(interpreter.uri);
        let pending = this.pendingChecks.get(key);

        if (!pending) {
            pending = this.checkAndInstall(interpreter, resource, token);
            pending.catch(noop).finally(() => {
                if (this.pendingChecks.get(key) === pending) {
                    this.pendingChecks.delete(key);
                }
            });
            this.pendingChecks.set(key, pending);
        }

        // The joined caller inherits the first one's outcome but keeps its own cancellation, and
        // stops waiting the moment its notebook closes rather than sitting behind a shared modal or
        // pip run it no longer has a use for. The shared work carries on for whoever started it.
        return raceCancellation(token, DeepnoteToolkitDependencyResponse.cancel, pending);
    }

    private async checkAndInstall(
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

        // Racing the token, as KernelDependencyService does: a caller whose notebook closed must not
        // stay blocked on a modal only the user can dismiss.
        const selection = await raceCancellation(
            token,
            window.showInformationMessage(message, { modal: true }, Common.install, selectInterpreter)
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
