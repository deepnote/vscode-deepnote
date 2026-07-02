// Shared timeouts (ms) and selectors for the ExTester E2E suite.

export const WORKBENCH_TIMEOUT = 60_000;
export const QUICK_PICK_TIMEOUT = 30_000;
export const ENV_CREATED_TIMEOUT = 120_000;
export const KERNEL_CONNECT_TIMEOUT = 300_000;

// Mocha per-test timeout for the whole suite; stays just under the .mocharc.js default. Slowest step
// is the first kernel start (venv + toolkit provisioning).
export const SUITE_TIMEOUT = 1_320_000; // 22 min

// A single "Run All" against an already-selected kernel must render output within this window: above
// a healthy first run but below the stall a dropped first run causes, so that regression fails here.
export const FIRST_RUN_OUTPUT_TIMEOUT = 120_000;

export const OUTPUT_POLL_INTERVAL = 1_500;
export const OUTPUT_FRAME_SWITCH_TIMEOUT = 5_000;

export const INTERPRETER_RETRY_DELAY = 5_000;
export const MAX_CREATE_ATTEMPTS = 6;

// When no interpreter is discovered yet the create command shows a notification and returns, so this
// wait elapses and the attempt is retried.
export const INTERPRETER_PROMPT_TIMEOUT = 5_000;

// When the name already exists the create command opens no further inputs, so this wait elapses and
// the optional prompts are skipped.
export const OPTIONAL_PROMPT_TIMEOUT = 5_000;

export const DIALOG_RESOLVE_DELAY = 1_500;
// "Open Folder" navigates one level toward the typed path per OK, so we re-click OK up to
// FOLDER_OPEN_TIMEOUT, waiting RELOAD_POLL_TIMEOUT for the reload and pausing FOLDER_OK_RETRY_DELAY between.
export const FOLDER_OPEN_TIMEOUT = 45_000;
export const RELOAD_POLL_TIMEOUT = 2_500;
export const FOLDER_OK_RETRY_DELAY = 400;

// Selectors that only exist inside the output iframe, so reading them can't match the editor's source.
export const OUTPUT_SELECTOR = '.output_container, .output, .rendered-output';
