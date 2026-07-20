import type { IBaseKernel } from '../../../kernels/types';

/**
 * The integration env-var names that `SqlIntegrationStartupCodeProvider` last emitted for a kernel.
 *
 * `IntegrationEnvLiveRefresher` needs a baseline of what is already set in a kernel to know what to
 * remove on the first live refresh, and start/restart credentials are delivered by the startup-code
 * provider rather than by the refresher. Re-reading the integration config to derive that baseline
 * would be wrong: an edit landing between the provider's read and the re-read drops a name the
 * provider actually wrote, and that variable would then never be removed. So the provider records
 * exactly what it emitted and the refresher unions those names in.
 *
 * Keyed weakly by kernel, so entries disappear with the kernel; a restart overwrites the previous
 * entry because the provider runs again on every kernel start and restart.
 */
const namesByKernel = new WeakMap<IBaseKernel, ReadonlySet<string>>();

/** The names recorded for `kernel`, or `undefined` if the provider never emitted any for it. */
export function getStartupIntegrationEnvNames(kernel: IBaseKernel): ReadonlySet<string> | undefined {
    return namesByKernel.get(kernel);
}

export function recordStartupIntegrationEnvNames(kernel: IBaseKernel, names: Iterable<string>): void {
    namesByKernel.set(kernel, new Set(names));
}
