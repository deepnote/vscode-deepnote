// Wrapper for vega-lite that uses dynamic import to handle ESM/CJS interop
// vega-lite has top-level await (through vega-canvas) which isn't compatible with CJS bundles
// This wrapper makes vega-lite optional - if it fails to load, we gracefully degrade

import type { TopLevelSpec } from 'vega-lite';
import type { Spec as VegaSpec } from 'vega';

import { logger } from '../../platform/logging';

let compileFunction: ((spec: TopLevelSpec) => { spec: VegaSpec }) | null = null;
let loadPromise: Promise<void> | null = null;
let loadFailed = false;

async function loadVegaLite(): Promise<void> {
    if (typeof compileFunction === 'function' || loadFailed) return;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
        try {
            const vegaLite = await import('vega-lite');

            if (!vegaLite.compile || typeof vegaLite.compile !== 'function') {
                throw new Error(
                    `vega-lite module loaded but compile function is missing or not a function. Got: ${typeof vegaLite.compile}. Vega-lite chart conversion will be skipped.`
                );
            }

            compileFunction = vegaLite.compile;
        } catch (error) {
            compileFunction = null;
            loadFailed = true;
            logger.warn('vega-lite could not be loaded. Vega-lite chart conversion will be skipped.', error);
        }
    })();

    return loadPromise;
}

/**
 * Check if vega-lite is available for use.
 */
export function isVegaLiteAvailable(): boolean {
    return typeof compileFunction === 'function';
}

/**
 * Compile a vega-lite spec to a vega spec.
 * Returns undefined if vega-lite is not available.
 */
export function compile(spec: TopLevelSpec): { spec: VegaSpec } | undefined {
    if (typeof compileFunction !== 'function') {
        return undefined;
    }

    return compileFunction(spec);
}

export async function ensureVegaLiteLoaded(): Promise<void> {
    await loadVegaLite();
}
