import { inject, injectable } from 'inversify';
import { l10n, type NotebookDocument, window } from 'vscode';

import { IKernel, IKernelProvider } from '../../../kernels/types';
import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { IDisposableRegistry } from '../../../platform/common/types';
import { noop } from '../../../platform/common/utils/misc';
import { logger } from '../../../platform/logging';
import { ISqlIntegrationEnvVarsProvider } from '../../../platform/notebooks/deepnote/types';
import { buildIntegrationEnvRefreshSnippet, IntegrationEnvValidationError } from './integrationEnvSnippet';
import { getStartupIntegrationEnvNames } from './startupIntegrationEnvTracker';
import { IIntegrationEnvLiveRefresher } from './types';

/** How long the transient "environment updated" status-bar message stays visible. */
const STATUS_BAR_MESSAGE_TIMEOUT_MS = 5000;

/**
 * Applies integration credential changes to already-running kernels without a restart, by executing
 * the assignments directly in the kernel through the leak-safe execution primitive.
 *
 * Initial and post-restart delivery is not done here — `SqlIntegrationStartupCodeProvider` handles
 * that as startup code. This class only needs to know *which* names that provider set, so it can
 * remove the ones that later disappear from the configuration.
 */
@injectable()
export class IntegrationEnvLiveRefresher implements IIntegrationEnvLiveRefresher, IExtensionSyncActivationService {
    /** Per kernel, the integration env-var names currently believed to be set in it. */
    private readonly lastSetNames = new WeakMap<IKernel, Set<string>>();
    /** Tail of each kernel's work queue — see {@link enqueue}. */
    private readonly pendingByKernel = new WeakMap<IKernel, Promise<unknown>>();
    /** Monotonic per-kernel refresh counter used to drop refreshes that a newer one supersedes. */
    private readonly refreshGenerations = new WeakMap<IKernel, number>();

    constructor(
        @inject(IKernelProvider) private readonly kernelProvider: IKernelProvider,
        @inject(ISqlIntegrationEnvVarsProvider) private readonly envVarsProvider: ISqlIntegrationEnvVarsProvider,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry
    ) {}

    public activate(): void {
        // A restart fires onDidRestartKernel rather than onDidStartKernel, so both are subscribed.
        //
        // These events make the baseline available as early as possible, but they are not what
        // guarantees it is there: `startedAtLeastOnce` — the sole gate on a refresh — is set at the top
        // of `startJupyterSession`, before the session even exists, while `_onStarted` fires only at the
        // very end of the start path. A refresh arriving in that window would otherwise read an empty
        // baseline and emit no removals. `applyEnvToKernel` closes that by merging the startup names in
        // at read time; these subscriptions are belt-and-braces on top.
        //
        // onDidPostInitializeKernel would be worse still — it early-returns for `disableUI` starts and
        // for `ignoreTriggeringOnPostInitialized`.
        this.kernelProvider.onDidStartKernel(this.seedRemovalBaseline, this, this.disposables);
        this.kernelProvider.onDidRestartKernel(this.seedRemovalBaseline, this, this.disposables);
    }

    public async refresh(notebooks: readonly NotebookDocument[]): Promise<void> {
        const results = await Promise.all(notebooks.map((notebook) => this.refreshNotebook(notebook)));
        const refreshedCount = results.filter(Boolean).length;

        if (refreshedCount > 0) {
            // Transient status-bar message rather than a persistent toast, so frequent env-file edits don't spam notifications (F2).
            window.setStatusBarMessage(
                l10n.t('Deepnote integration environment updated.'),
                STATUS_BAR_MESSAGE_TIMEOUT_MS
            );
        }
    }

    /**
     * Resolves this notebook's integration env and pushes the difference into the kernel. Always runs
     * inside the kernel's queue, since it reads and then writes the removal baseline.
     */
    private async applyEnvToKernel(kernel: IKernel, notebook: NotebookDocument): Promise<boolean> {
        const envVars = (await this.envVarsProvider.getEnvironmentVariables(notebook.uri)) ?? {};
        // The startup-code provider's names are merged in here, at read time, not just via the
        // start/restart event: a refresh can beat that event (see `activate`), and reading an empty
        // baseline would silently skip the removal of a credential the user just deleted. Repeating the
        // merge on every read is idempotent, and the worst case — re-emitting `unset_env` for a name
        // already removed — is a harmless `os.environ.pop(name, None)`.
        const baseline = new Set([
            ...(this.lastSetNames.get(kernel) ?? []),
            ...(getStartupIntegrationEnvNames(kernel) ?? [])
        ]);
        const hasEntries = Object.values(envVars).some((value) => typeof value === 'string');

        // `getEnvironmentVariables` resolves to `{}` on its soft-failure paths (notebook not found,
        // missing project/notebook metadata, project not cached), and a healthy open Deepnote notebook
        // always yields at least the internal DuckDB variable. So an empty result against a non-empty
        // baseline is a failed read, never a genuine "no integrations configured" — applying it would
        // unset every tracked name and wipe the kernel's live credentials.
        if (!hasEntries && baseline.size > 0) {
            logger.warn(
                `IntegrationEnvLiveRefresher: Resolved no integration environment for ${notebook.uri.toString()} while ${
                    baseline.size
                } variable(s) are set; keeping the current environment.`
            );

            return false;
        }

        const { code, setNames } = buildIntegrationEnvRefreshSnippet(envVars, baseline);

        // Nothing to set and nothing to remove. Reporting success would put "environment updated" on
        // the status bar for a refresh that delivered nothing — this is reached when the provider
        // resolved no variables at all, which is a soft failure rather than a real empty configuration.
        if (code.length === 0) {
            return false;
        }

        const outputs = await this.kernelProvider.getKernelExecution(kernel).executeHiddenSilent(code);

        // `outputs` is deliberately never logged: the code that produced it embeds credentials.
        if (outputs.some((output) => output.output_type === 'error')) {
            logger.warn(
                `IntegrationEnvLiveRefresher: Failed to apply the integration environment for ${notebook.uri.toString()}`
            );

            // A snippet that raised part-way through still applied the lines before it — `stop_on_error`
            // governs later queued requests, not statements within one request. Union rather than
            // discard `setNames`, so a variable that did get set stays tracked and a later deletion can
            // still unset it. This can only over-track, and an extra `unset_env` is harmless.
            this.lastSetNames.set(kernel, new Set([...baseline, ...setNames]));

            return false;
        }

        // Replace, rather than union, is correct here: every name dropped from the baseline was
        // unset by this same snippet.
        this.lastSetNames.set(kernel, setNames);

        return true;
    }

    /**
     * Serializes work per kernel: `work` starts only once everything already queued for that kernel has
     * settled. Seeding and refreshing both read-modify-write the same baseline and so must not
     * interleave, and two racing refreshes must not let the older provider read land last.
     */
    private enqueue<T>(kernel: IKernel, work: () => Promise<T>): Promise<T> {
        // The stored tail never rejects, so `work` is always reached.
        const previous = this.pendingByKernel.get(kernel) ?? Promise.resolve();
        const next = previous.then(work);

        this.pendingByKernel.set(kernel, next.then(noop, noop));

        return next;
    }

    /** Refreshes one kernel; never throws (per-notebook errors are logged), resolves true only on a clean run. */
    private async refreshNotebook(notebook: NotebookDocument): Promise<boolean> {
        try {
            const kernel = this.kernelProvider.get(notebook);
            if (!kernel || !kernel.startedAtLeastOnce) {
                return false;
            }

            const generation = (this.refreshGenerations.get(kernel) ?? 0) + 1;
            this.refreshGenerations.set(kernel, generation);

            return await this.enqueue(kernel, async () => {
                // Superseded before it got to start. Not a staleness guard — the provider read happens
                // inside this closure, so this refresh would see the same fresh configuration as the
                // one that superseded it. Skipping is pure de-duplication of identical work.
                if (this.refreshGenerations.get(kernel) !== generation) {
                    return false;
                }

                return this.applyEnvToKernel(kernel, notebook);
            });
        } catch (err) {
            if (err instanceof IntegrationEnvValidationError) {
                // Nothing was emitted, so the kernel still holds the previous, working environment.
                logger.warn(
                    `IntegrationEnvLiveRefresher: ${err.message} Refresh aborted for ${notebook.uri.toString()}`
                );

                return false;
            }

            // The error type only, never the error itself: the logger renders an Error through
            // `util.inspect`, which would emit its full stack and `[cause]`, and this path handles
            // throws from the provider, whose messages are not guaranteed to be free of credentials.
            logger.error(
                `IntegrationEnvLiveRefresher: Failed to refresh integration env for ${notebook.uri.toString()} (${
                    err instanceof Error ? err.name : 'unknown'
                })`
            );

            return false;
        }
    }

    /**
     * Adds the names the startup-code provider wrote for this kernel to its removal baseline.
     *
     * Unions, never replaces: over-tracking costs at most a harmless `os.environ.pop(name, None)`,
     * whereas under-tracking would leave a credential the user deleted live in the kernel.
     */
    private seedRemovalBaseline(kernel: IKernel): void {
        const startupNames = getStartupIntegrationEnvNames(kernel);
        if (!startupNames || startupNames.size === 0) {
            return;
        }

        // Queued, not applied inline, so it cannot land between an in-flight refresh reading the
        // baseline and writing it back — which would silently discard the seeded names.
        this.enqueue(kernel, async () => {
            this.lastSetNames.set(kernel, new Set([...(this.lastSetNames.get(kernel) ?? []), ...startupNames]));
        }).catch(noop);
    }
}
