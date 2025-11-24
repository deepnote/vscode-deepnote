// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Call this function to debug async hangs. It should print out stack traces of still running promises.
export async function asyncDump() {
    // @ts-expect-error - why-is-node-running doesn't have type definitions
    const whyIsNodeRunning = await import('why-is-node-running');
    whyIsNodeRunning.default();
}
