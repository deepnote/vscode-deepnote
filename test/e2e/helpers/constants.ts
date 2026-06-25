// Shared timeouts (ms) and selectors for the ExTester E2E suite.
// UI ops are slow and the first kernel start is the slowest step.

export const WORKBENCH_TIMEOUT = 60_000;
export const QUICK_PICK_TIMEOUT = 30_000;
export const ENV_CREATED_TIMEOUT = 120_000;
export const KERNEL_CONNECT_TIMEOUT = 300_000;
export const OUTPUT_TIMEOUT = 300_000;

// How often to re-issue "Run All" while waiting for output — the first run can be dropped right
// after the kernel connects.
export const RUN_ALL_REISSUE_INTERVAL = 25_000;

export const INTERPRETER_RETRY_DELAY = 5_000;
export const MAX_CREATE_ATTEMPTS = 6;

// The in-window simple file/folder dialog needs a beat to resolve a typed path before it accepts.
export const DIALOG_RESOLVE_DELAY = 1_500;
export const FOLDER_OPEN_ATTEMPTS = 5;
export const FOLDER_RELOAD_TIMEOUT = 12_000;

// Selectors that only exist inside the notebook output iframe (`#active-frame`),
// so reading them cannot accidentally match the cell's source in the editor.
export const OUTPUT_SELECTOR = '.output_container, .output, .rendered-output';
