// Shared timeouts (ms) and selectors for the ExTester E2E suite.
// UI ops are slow and the first kernel start is the slowest step.

export const WORKBENCH_TIMEOUT = 60_000;
export const QUICK_PICK_TIMEOUT = 30_000;
export const KERNEL_CONNECT_TIMEOUT = 300_000;

// Mocha per-test timeout applied to the whole suite (overrides the .mocharc default). Stays just
// under the 25 min .mocharc.js default; the slowest single step is the first kernel start (venv +
// Deepnote toolkit provisioning).
export const SUITE_TIMEOUT = 1_320_000; // 22 min

// A single "Run All" must render output within this window. It sits well above a healthy first run
// (the interpreter already carries the toolkit, so nothing is provisioned) and below the multi-minute
// stall a dropped first run would cause, so the kernel-binding regression fails here instead of
// being masked by re-runs.
export const FIRST_RUN_OUTPUT_TIMEOUT = 120_000;

// How often to poll the output webview for the expected text.
export const OUTPUT_POLL_INTERVAL = 1_500;

// How long to wait for the notebook output iframe (`#active-frame`) to become switchable.
export const OUTPUT_FRAME_SWITCH_TIMEOUT = 5_000;

// The in-window simple file/folder dialog needs a beat to resolve a typed path before it accepts.
export const DIALOG_RESOLVE_DELAY = 1_500;
// "Open Folder" navigates one level toward the typed path per OK, so we re-click OK up to
// FOLDER_OPEN_TIMEOUT, waiting RELOAD_POLL_TIMEOUT for the reload and pausing FOLDER_OK_RETRY_DELAY between.
export const FOLDER_OPEN_TIMEOUT = 45_000;
export const RELOAD_POLL_TIMEOUT = 2_500;
export const FOLDER_OK_RETRY_DELAY = 400;

// How long a file opened through Quick Open gets to become the active editor.
export const EDITOR_ACTIVE_TIMEOUT = 15_000;

// Selectors that only exist inside the notebook output iframe (`#active-frame`),
// so reading them cannot accidentally match the cell's source in the editor.
export const OUTPUT_SELECTOR = '.output_container, .output, .rendered-output';

// Where the managed venv lives. Suites run against its interpreter, pinned in the generated user
// settings (helpers/venv.ts).
export const PREBAKED_VENV_DIR_NAME = '.venv-e2e';
