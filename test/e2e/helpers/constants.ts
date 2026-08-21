// Shared timeouts (ms) and selectors for the ExTester E2E suite.
// UI ops are slow and the first kernel start is the slowest step.

export const WORKBENCH_TIMEOUT = 60_000;
export const QUICK_PICK_TIMEOUT = 30_000;
export const ENV_CREATED_TIMEOUT = 120_000;
export const KERNEL_CONNECT_TIMEOUT = 300_000;

// Mocha per-test timeout applied to the whole suite (overrides the .mocharc default). Stays just
// under the 25 min .mocharc.js default; the slowest single step is the first kernel start (venv +
// Deepnote toolkit provisioning).
export const SUITE_TIMEOUT = 1_320_000; // 22 min

// A single "Run All" against an already-selected kernel must render output within this window. It
// sits well above a healthy first run (the kernel is bound before the click — see
// selectEnvironmentForNotebook) and below the multi-minute stall a dropped first run would cause,
// so the kernel-binding regression fails here instead of being masked by re-runs.
export const FIRST_RUN_OUTPUT_TIMEOUT = 120_000;

// How often to poll the output webview for the expected text.
export const OUTPUT_POLL_INTERVAL = 1_500;

// How long to wait for the notebook output iframe (`#active-frame`) to become switchable.
export const OUTPUT_FRAME_SWITCH_TIMEOUT = 5_000;

export const INTERPRETER_RETRY_DELAY = 5_000;
export const MAX_CREATE_ATTEMPTS = 6;

// How long to wait for the interpreter quick pick to open after issuing the create-environment
// command. When no interpreter has been discovered yet the command shows a "No Python interpreters
// found" notification and returns instead, so this wait elapses and the attempt is retried.
export const INTERPRETER_PROMPT_TIMEOUT = 5_000;

// How long to wait for an optional input box (packages/description) to appear after confirming the
// environment name. When the name already exists the create command short-circuits with an "already
// exists" notification and opens no further inputs, so this wait elapses and the prompts are skipped.
export const OPTIONAL_PROMPT_TIMEOUT = 5_000;

// The in-window simple file/folder dialog needs a beat to resolve a typed path before it accepts.
export const DIALOG_RESOLVE_DELAY = 1_500;
// "Open Folder" navigates one level toward the typed path per OK, so we re-click OK up to
// FOLDER_OPEN_TIMEOUT, waiting RELOAD_POLL_TIMEOUT for the reload and pausing FOLDER_OK_RETRY_DELAY between.
export const FOLDER_OPEN_TIMEOUT = 45_000;
export const RELOAD_POLL_TIMEOUT = 2_500;
export const FOLDER_OK_RETRY_DELAY = 400;

// Selectors that only exist inside the notebook output iframe (`#active-frame`),
// so reading them cannot accidentally match the cell's source in the editor.
export const OUTPUT_SELECTOR = '.output_container, .output, .rendered-output';

// The environment every suite shares. Creating a Deepnote environment is cheap (metadata only), but
// the first kernel connect provisions a venv + the Deepnote toolkit, so a suite that invents its own
// name pays that once more. Import this instead of writing a name; `E2E Delete Env` in
// environment.e2e.test.ts is the one deliberate exception, since that suite deletes what it creates.
export const SHARED_ENV_NAME = 'E2E Hello Env';

// Where the managed venv lives, and the substring that identifies it in the interpreter quick pick.
// The marker matches both the real directory and the `.venv` link the workspace exposes it through.
export const PREBAKED_VENV_DIR_NAME = '.venv-e2e';
export const PREBAKED_VENV_MARKER = '.venv';

// How long to wait for the interpreter quick pick to actually narrow to the baked venv. The
// filter is near-instant when the venv is discoverable, so this only elapses when it is missing —
// keep it well under QUICK_PICK_TIMEOUT so a forgotten setup step does not stall every suite.
export const PREBAKED_VENV_FILTER_TIMEOUT = 10_000;
