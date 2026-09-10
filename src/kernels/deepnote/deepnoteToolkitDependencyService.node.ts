import { inject, injectable } from 'inversify';
import { CancellationToken, CancellationTokenSource, window } from 'vscode';

import { DEEPNOTE_TOOLKIT_VERSION } from '../../platform/common/constants';
import { getDisplayPath } from '../../platform/common/platform/fs-paths.node';
import { IDisposable, Resource } from '../../platform/common/types';
import { Common, DataScience } from '../../platform/common/utils/localize';
import { getPythonEnvDisplayName } from '../../platform/interpreter/helpers';
import { ProductNames } from '../../platform/interpreter/installer/productNames';
import { IInstaller, InstallerResponse, Product } from '../../platform/interpreter/installer/types';
import { IPythonExecutionFactory } from '../../platform/interpreter/types.node';
import { raceCancellation } from '../../platform/common/cancellation';
import { noop } from '../../platform/common/utils/misc';
import { logger } from '../../platform/logging';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { getComparisonKey } from '../../platform/vscode-path/resources';
import { DeepnoteToolkitDependencyResponse, IDeepnoteToolkitDependencyService } from './types';

/** What the probe found in an interpreter. `version` is absent when the distribution is not installed. */
export interface ToolkitProbe {
    version?: string;
    /** Whether `jupyter_server` imports, i.e. the toolkit was installed with its `[server]` extra. */
    server: boolean;
}

export type ToolkitState = 'ok' | 'missing' | 'needsUpdate';

/**
 * Reads distribution metadata rather than importing `deepnote_toolkit`: the import costs seconds and
 * floods the log, and would still say nothing about the version. `jupyter_server` is what the
 * `[server]` extra brings in, and what the toolkit server refuses to start without.
 */
const TOOLKIT_PROBE = [
    'import json',
    'r = {"version": None, "server": False}',
    'try:',
    '    from importlib.metadata import version',
    '    r["version"] = version("deepnote-toolkit")',
    'except Exception:',
    '    pass',
    'try:',
    '    import jupyter_server',
    '    r["server"] = True',
    'except Exception:',
    '    pass',
    'print(json.dumps(r))'
].join('\n');

/**
 * Numeric release segments of a version, so `2.6.0.dev0` reads as 2.6.0 and `2.5.1rc1` as 2.5.1.
 * Undefined when the version does not start with a number, which no PyPI release does.
 */
function releaseSegments(version: string): number[] | undefined {
    const match = /^\s*v?(\d+(?:\.\d+)*)/.exec(version);

    return match ? match[1].split('.').map(Number) : undefined;
}

/**
 * Whether `installed` is an older release than `pinned`. Pre-release and local suffixes are ignored,
 * and a version that cannot be read at all is not treated as older: an editable checkout of the
 * toolkit is a deliberate choice, not something to prompt about on every run.
 */
export function isOlderRelease(installed: string, pinned: string): boolean {
    const a = releaseSegments(installed);
    const b = releaseSegments(pinned);

    if (!a || !b) {
        return false;
    }

    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const left = a[i] ?? 0;
        const right = b[i] ?? 0;

        if (left !== right) {
            return left < right;
        }
    }

    return false;
}

/**
 * Whether the interpreter can run the toolkit server as this extension expects: the distribution is
 * present, at least the pinned release, and installed with the `[server]` extra. A newer release
 * passes, so toolkit developers are not asked to downgrade.
 */
export function toolkitState(probe: ToolkitProbe, pinned: string = DEEPNOTE_TOOLKIT_VERSION): ToolkitState {
    if (!probe.version) {
        return 'missing';
    }

    if (!probe.server || isOlderRelease(probe.version, pinned)) {
        return 'needsUpdate';
    }

    return 'ok';
}

/**
 * Asks for consent before installing deepnote-toolkit into the user's interpreter, mirroring
 * `KernelDependencyService` — same prompt shape, same "cancel is not a failure" semantics.
 *
 * It cannot reuse that service directly: `installMissingDependencies` is keyed on a
 * `KernelConnectionMetadata`, and a Deepnote connection cannot exist until the toolkit server is
 * running and has reported the kernels it offers — which is precisely what this check gates.
 *
 * The gate is on version and extra, not presence: the extension and the toolkit co-evolve, so a
 * toolkit older than the pin, or one installed without `[server]`, gets the same consent prompt
 * worded as an update. The install itself is `pip install -U deepnote-toolkit[server]==<pin>`, which
 * repairs both.
 */
@injectable()
export class DeepnoteToolkitDependencyService implements IDeepnoteToolkitDependencyService {
    /**
     * In-flight checks, keyed on the interpreter as `KernelDependencyService` does. The contended
     * resource is that interpreter's site-packages, so two notebooks sharing one must join rather
     * than each raise their own prompt and run their own pip.
     */
    private readonly pendingChecks = new Map<string, Promise<DeepnoteToolkitDependencyResponse>>();

    constructor(
        @inject(IInstaller) private readonly installer: IInstaller,
        @inject(IPythonExecutionFactory) private readonly pythonExecutionFactory: IPythonExecutionFactory
    ) {}

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
        const state = await this.probe(interpreter);

        if (state === 'ok') {
            return DeepnoteToolkitDependencyResponse.ok;
        }

        if (token.isCancellationRequested) {
            return DeepnoteToolkitDependencyResponse.cancel;
        }

        const moduleName = ProductNames.get(Product.deepnoteToolkit)!;
        const environmentName = getPythonEnvDisplayName(interpreter) || getDisplayPath(interpreter.uri);
        const message =
            state === 'needsUpdate'
                ? DataScience.libraryRequiredToLaunchJupyterKernelNotInstalledInterpreterAndRequiresUpdate(
                      environmentName,
                      moduleName
                  )
                : DataScience.libraryRequiredToLaunchJupyterKernelNotInstalledInterpreter(environmentName, moduleName);
        const selectInterpreter = DataScience.selectDifferentPythonInterpreter;

        logger.info(`${moduleName} ${state} for ${getDisplayPath(resource)}, prompting to install`);

        // Racing the token, as KernelDependencyService does: a caller whose notebook closed must not
        // stay blocked on a modal only the user can dismiss.
        const selection = await raceCancellation(
            token,
            window.showInformationMessage(message, { modal: true }, Common.install, selectInterpreter)
        );

        // Reported, not acted on, as KernelDependencyService does with selectDifferentKernel. Opening
        // the picker here would re-enter this same check through the switch it starts, and that check
        // is the shared promise this call is still inside: it would join itself and never settle.
        if (selection === selectInterpreter) {
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

    /**
     * Runs the metadata probe in the interpreter. When the probe itself cannot run, the check falls
     * back to the import test the installer uses, so a broken environment still gets the install
     * prompt rather than an opaque failure.
     */
    private async probe(interpreter: PythonEnvironment): Promise<ToolkitState> {
        try {
            const python = await this.pythonExecutionFactory.createActivatedEnvironment({ interpreter });
            const result = await python.exec(['-c', TOOLKIT_PROBE], { throwOnStdErr: false });
            const lastLine = result.stdout.trim().split(/\r?\n/).pop() ?? '';
            const parsed = JSON.parse(lastLine) as { version?: unknown; server?: unknown };
            const found: ToolkitProbe = {
                ...(typeof parsed.version === 'string' && parsed.version ? { version: parsed.version } : {}),
                server: parsed.server === true
            };
            const state = toolkitState(found);

            logger.info(
                `deepnote-toolkit ${found.version ?? 'not installed'}${
                    found.server ? '' : ' (no [server] extra)'
                } in ${getDisplayPath(interpreter.uri)}: ${state}, pinned ${DEEPNOTE_TOOLKIT_VERSION}`
            );

            return state;
        } catch (error) {
            logger.warn(`Could not probe deepnote-toolkit in ${getDisplayPath(interpreter.uri)}`, error);

            return (await this.installer.isInstalled(Product.deepnoteToolkit, interpreter)) ? 'ok' : 'missing';
        }
    }
}
