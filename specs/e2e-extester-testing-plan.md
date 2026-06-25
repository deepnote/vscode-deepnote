# E2E Testing with ExTester (vscode-extension-tester) — Self-Contained Plan & Reference

> **What this document is.** A single, self-contained guide to the end-to-end (E2E) UI
> test layer for this extension, built on Red Hat's **ExTester**
> (`vscode-extension-tester`). It explains *why* and *how*, and embeds the **complete,
> verbatim contents of every file** involved, so you can understand, reproduce, run, and
> extend the setup from this document alone — without opening any other file.
>
> **Status:** implemented **and verified passing locally** on headless Linux (Ubuntu 24.04,
> Xvfb, VS Code 1.111.0). The files below exist in the repo at the stated paths.
>
> **The one test we ship** drives the full Deepnote happy path through the *real* VS Code
> UI: open a one-notebook `.deepnote` file containing `print("hello world")` → create a
> Deepnote environment → select it for the notebook → kernel connects → run the cell →
> assert the rendered output contains `hello world`.

---

## 0. Implementation reality (read this first)

Bringing this test green required several fixes beyond the first draft of the plan. They are
baked into the files reproduced below; this section explains the *why* so the test reads
sensibly and so the setup is reproducible.

**Setup the headless run needs (one-time):**

- **System libraries for Electron/Chromium** (the test VS Code won't launch without them). On
  Ubuntu 24.04: `libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libgtk-3-0t64
  libgdk-pixbuf-2.0-0 libgbm1 libasound2t64 libnss3 libnspr4 libxss1 libxshmfence1 libdrm2
  libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libxfixes3 libxext6 libxrender1
  libpango-1.0-0 libcairo2 libatspi2.0-0 libx11-xcb1 libxcb-dri3-0 libxtst6 libsecret-1-0
  libgssapi-krb5-2 libdbus-1-3 libexpat1` plus `xvfb`.
- **A venv-capable Python interpreter** — env creation runs `python -m venv` (needs
  `ensurepip`) then `pip install deepnote-toolkit[server] ipykernel python-lsp-server
  deepnote-cli` (needs network). On Ubuntu: `python3.12-venv python3-pip`.
- **No proposed-API allow-listing is needed.** The extension declares `enabledApiProposals`
  (Jupyter's notebook kernel/execution set, inherited from the vscode-jupyter fork), and on a
  plain stable VS Code those proposals are *not* granted — VS Code logs a non-fatal "CANNOT USE
  these API proposals" line. That does **not** block anything: activation, the notebook
  serializer, kernel execution, and output rendering all run on **stable** APIs (output goes
  through `controller.createNotebookCellExecution` with a `replaceCells` fallback), and the few
  genuinely-proposed calls are guarded (e.g. `if (!controller.createNotebookExecution)`). The
  suite is verified passing on a plain stable VS Code with **no** `product.json` patch — which is
  also how the published Marketplace/Open VSX extension runs for end users.
- **`.gitignore` is not `.vscodeignore`.** `vsce` packs from `.vscodeignore`; the e2e
  `.test-extensions/` dir (~200 MB) must be excluded there too or every run packages a
  ~300 MB VSIX. (§6.2)

**Why the test code looks the way it does (vs a naive script):**

- **Open a workspace *folder*, not just the file.** The Deepnote serializer reads a "snapshot"
  during deserialization and, with **no** workspace folder, blocks forever on
  `await window.showWarningMessage('Cannot read snapshot: No workspace folders found.')` —
  leaving the notebook blank. So the test opens the temp dir as a folder first, then the file.
- **ExTester's `openResources` (`code -r <file>`) silently no-ops** in this sandboxed instance
  (IPC reuse fails), so we drive the *running* window directly: the folder via the simple
  "Open Folder" dialog, the notebook via Quick Open ("Go to File…").
- **The simple "Open Folder" dialog's Enter navigates *into* a directory** rather than
  accepting it — the deterministic accept is the dialog's **"OK" button**, which we click. The
  open also reloads the window, so we wait for the old workbench element to detach.
- **`deepnote.runallcells` is gated** behind context keys (`deepnote.ispythonornativeactive`,
  …) that aren't reliably set under automation, so `Workbench.executeCommand('Jupyter: Run All
  Cells')` can miss and open the wrong view. We **click the notebook toolbar's "Run All"
  button** instead, and **re-issue it periodically** because the first run can be dropped right
  after the kernel connects.
- **Environment creation is idempotent** (treats "already exists" as success) with a stable
  name, so retries — and persistent local instances — reuse the already-provisioned venv.

---

## Table of contents

0. [Implementation reality (read this first)](#0-implementation-reality-read-this-first)
1. [TL;DR — run it](#1-tldr--run-it)
2. [Background: what ExTester is and how it works](#2-background-what-extester-is-and-how-it-works)
3. [The Deepnote flow this test drives (verified against the code)](#3-the-deepnote-flow-this-test-drives-verified-against-the-code)
4. [Design decisions](#4-design-decisions)
5. [File manifest](#5-file-manifest)
6. [Complete file contents (verbatim)](#6-complete-file-contents-verbatim)
   - 6.1 [`package.json` additions](#61-packagejson-additions)
   - 6.2 [`.gitignore` additions](#62-gitignore-additions)
   - 6.3 [`test/e2e/tsconfig.json`](#63-teste2etsconfigjson)
   - 6.4 [`test/e2e/.mocharc.js`](#64-teste2emocharcjs)
   - 6.5 [`test/e2e/settings.json`](#65-teste2esettingsjson)
   - 6.6 [`test/e2e/fixtures/hello-world.deepnote`](#66-teste2efixtureshello-worlddeepnote)
   - 6.7 [`test/e2e/suite/helloWorld.e2e.test.ts`](#67-teste2esuitehelloworlde2etestts)
7. [How the hard parts work](#7-how-the-hard-parts-work)
   - 7.1 [Reading rendered output from nested iframes](#71-reading-rendered-output-from-nested-iframes)
   - 7.2 [Driving QuickPicks & InputBoxes](#72-driving-quickpicks--inputboxes)
8. [Running it](#8-running-it)
9. [CI integration](#9-ci-integration)
10. [Gotchas & flakiness mitigation](#10-gotchas--flakiness-mitigation)
11. [Where ExTester fits vs the other test layers](#11-where-extester-fits-vs-the-other-test-layers)
12. [Risks & mitigations](#12-risks--mitigations)
13. [Appendix A — ExTester API surface used](#appendix-a--extester-api-surface-used)
14. [Appendix B — Deepnote command-id reference](#appendix-b--deepnote-command-id-reference)
15. [References](#references)

---

## 1. TL;DR — run it

```bash
# one-time / when the extension changes
npm run compile            # build the extension under test  → dist/extension.node.js
npm run setup:e2e          # download test VS Code + ChromeDriver and install ms-python.python

# compile the test sources (test/e2e → out/e2e), or run compile-e2e-watch while iterating
npm run compile-e2e

# run the E2E suite (extest packages the extension, downloads/launches VS Code, runs the tests)
npm run test:e2e

# headless Linux (CI or a server without a display): wrap in a virtual framebuffer
xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24' npm run test:e2e
```

`npm run setup:e2e` is the umbrella for `setup:e2e:vscode` → `setup:e2e:deps` (in that order —
installing the Python extension uses the downloaded VS Code's CLI). Re-running it is safe. No
proposed-API patch is needed (§0).

Prerequisites: the **system libraries + Xvfb** and a **venv-capable Python interpreter** from
§0, and **network access** (creating the environment installs the Deepnote toolkit; the first
kernel start can take minutes).

---

## 2. Background: what ExTester is and how it works

**ExTester** (`vscode-extension-tester`, current `^8.23.0`) is a UI-testing framework for
VS Code extensions built on **Selenium WebDriver**. It drives the *real* VS Code desktop
app (Electron/Chromium) as if it were a browser — clicking buttons, opening the command
palette, typing into editors, reading notifications, and inspecting the DOM — exercising
the extension exactly as a user would. Red Hat created it to UI-test their own extensions
(vscode-java, vscode-quarkus, vscode-server-connector, …) and it is the de-facto standard
for VS Code extension UI testing.

The `extest` CLI does five things:

1. Downloads a clean, pinned **VS Code** test instance.
2. Downloads the **ChromeDriver** matching that VS Code's Chromium.
3. Loads our extension into it (from source by default; from a `.vsix` with `-u`).
4. Launches VS Code under WebDriver and runs our **Mocha** test files.
5. Auto-screenshots failing tests into `<storage>/_screenshots`.

```
Mocha test → ExTester Page Objects → selenium-webdriver → ChromeDriver → VS Code (+ our extension)
```

We write tests against ExTester's **Page Object API** (`Workbench`, `EditorView`,
`InputBox`, `Notification`, `WebView`, …) — all imported from the single
`vscode-extension-tester` package — instead of hand-writing DOM selectors.

**Key facts that shape this plan** (from the ExTester docs + studying Red Hat's own repos):

- **No headless flag.** VS Code is a real GUI app; on Linux you run "headed" inside
  `xvfb`. (§8, §9)
- **WebViews are iframes.** Anything rendered in a webview (including **notebook cell
  output**) requires switching the WebDriver context into the iframe and back. (§7.1)
- **No notebook page object exists.** ExTester has `TextEditor`, `WebView`,
  `CustomEditor`, … but nothing notebook-specific. We use `WebView` — its frame-switching
  happens to descend exactly the two iframe levels the notebook output uses. (§7.1)
- **chai v4 + CommonJS.** Every current Red Hat repo uses chai v4 with CommonJS; chai v5
  is ESM-only and adds friction. This repo already ships chai `^4.3.10`. (§4)
- **Compatibility is a floating window.** ExTester officially supports the latest ~3 VS
  Code minors (`-c min|max`), oldest workable is 1.37.0; use the newest ExTester for the
  newest VS Code. Node = active LTS. (§4)
- **Reliability comes from `driver.wait(...)`,** preferring `Workbench.executeCommand`
  over clicking menus, always `switchBack()` in `finally`, and bumping Mocha timeouts well
  above the unusable 2 s default. (§10)

---

## 3. The Deepnote flow this test drives (verified against the code)

Each step below was confirmed by reading the extension source (anchors given for
maintainers).

1. **Open `.deepnote` → native Notebook editor.** The extension registers a serializer for
   notebook type **`deepnote`** (`package.json` → `contributes.notebooks[].type = "deepnote"`,
   selector `*.deepnote`; `DeepnoteNotebookSerializer` in
   `src/notebooks/deepnote/deepnoteSerializer.ts`; registered in
   `deepnoteActivationService.ts`). Opening the raw file works without the explorer: a
   single-notebook file resolves via `findDefaultNotebook()` (serializer line ~103).
   Before an environment is chosen, the notebook gets a **placeholder controller** labeled
   **"Deepnote: Select Environment"** (`deepnoteKernelAutoSelector.node.ts` →
   `createPlaceholderController`).

2. **Create an environment** → command **`deepnote.environments.create`** (palette label
   **"Deepnote: Create Environment"**; `deepnoteEnvironmentsView.node.ts` →
   `createEnvironmentCommand`). It prompts, in order:
   - a **QuickPick of Python interpreters** (from the Python extension API
     `api.environments.known`; placeholder *"Select a Python interpreter for this
     environment"*) — if none are discovered yet it shows *"No Python interpreters found"*
     and returns;
   - an **input box for the name**;
   - an **input box for packages** (optional — empty + Enter is valid);
   - an **input box for description** (optional);
   - then a progress notification *"Creating environment …"* and finally
     *"Environment "…" created successfully!"*.

3. **Select it for the notebook** → command **`deepnote.environments.selectForNotebook`**
   (palette label **"Deepnote: Select Environment for Notebook"**; requires the active
   editor to be a `deepnote` notebook). It shows a **QuickPick of environments** (plus
   *"$(add) Create New Environment"*). Choosing one calls
   `kernelAutoSelector.rebuildController(notebook, …)` inside a *"Switching to
   environment…"* progress notification, ending with *"Environment switched
   successfully"*.

4. **Kernel connects.** `rebuildController` → `ensureKernelSelectedWithConfiguration` →
   `ensureControllerSelectedForNotebook` provisions the venv/toolkit, **explicitly selects
   the controller** via `commands.executeCommand('notebook.selectKernel', { … id: controller.connection.id … })`
   (auto-selector line ~740), and **disposes the placeholder** (line ~502). After this the
   real controller is the selected kernel, so "Run All" executes through it.

5. **Execute** → command **`deepnote.runallcells`** (palette label **"Jupyter: Run All
   Cells"**), which runs the cell through the selected controller, starting the kernel.

6. **Validate output** → the rendered stdout `hello world` appears in the notebook
   **output webview** (nested iframes — §7.1).

### The fixture format

Confirmed from `src/notebooks/deepnote/deepnoteSerializer.unit.test.ts` and `@deepnote/blocks`.
A minimal one-notebook, one-code-block file is in §6.6.

---

## 4. Design decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Where tests live | `test/e2e/` (top-level, **outside `src/`**) | The root `tsconfig.json` only compiles `./src/**/*` and esbuild only bundles `src`, so E2E code never enters the extension bundle, the unit glob (`out/**/*.unit.test.js`), or the integration glob (`*.vscode.test`). Zero interference. |
| Compilation | Dedicated `test/e2e/tsconfig.json` → `out/e2e/` | Isolated from the strict extension config; `out/` is already gitignored, so compiled tests and `_screenshots` are ignored too. |
| Module system | **CommonJS + chai v4** | Matches every current Red Hat repo and the repo's existing chai `^4.3.10`; avoids chai v5 ESM friction. |
| New dependency | only `vscode-extension-tester@^8.23.0` | It transitively brings selenium-webdriver, page-objects, locators, @vscode/vsce, c8. `mocha` (`^11`), `chai`/`@types/chai` (`^4`), `@types/mocha` (`^10`) already exist and are reused. |
| VS Code version | `-c max` | Best DOM-locator match for ExTester 8.23 and most reliable automation; still within our `engines.vscode` `^1.95.0`. Swap to `-c 1.95.0` to additionally validate the minimum supported VS Code. |
| Output validation | read the **output iframe**, gated on `getViewToSwitchTo()` | Reading the whole document body would falsely match the cell's *source* `print("hello world")` shown in the editor. Gating on a real output iframe + output-scoped selectors prevents that. (§7.1) |
| Fixture handling | copy to a temp dir, open the copy | Execution dirties the notebook; a throwaway copy keeps the committed fixture pristine and avoids save prompts. |

---

## 5. File manifest

| Path | New? | Purpose |
| --- | --- | --- |
| `package.json` | modified | adds `vscode-extension-tester` devDep + the e2e npm scripts |
| `.gitignore` | modified | ignores ExTester's `test-resources/` and `.test-extensions/` |
| `.vscodeignore` | modified | excludes `.test-extensions/` + `test-resources/` from the VSIX (§6.2) |
| `test/e2e/tsconfig.json` | new | isolated CommonJS compile → `out/e2e` |
| `test/e2e/.mocharc.js` | new | UI-test timeouts/retries/reporter |
| `test/e2e/settings.json` | new | VS Code user settings for the test instance |
| `test/e2e/fixtures/hello-world.deepnote` | new | the one-notebook hello-world fixture |
| `test/e2e/suite/helloWorld.e2e.test.ts` | new | the single E2E test |

Resulting layout:

```
test/e2e/
├── tsconfig.json
├── .mocharc.js
├── settings.json
├── fixtures/
│   └── hello-world.deepnote
└── suite/
    └── helloWorld.e2e.test.ts
```

ExTester writes its downloads to `test-resources/` and installs extensions into
`.test-extensions/` (both gitignored). Compiled tests + failure screenshots live under
`out/e2e/` (already gitignored via `out`).

---

## 6. Complete file contents (verbatim)

### 6.1 `package.json` additions

Add one dev dependency:

```jsonc
"devDependencies": {
  // …existing…
  "vscode-extension-tester": "^8.23.0"
}
```

Add these scripts (placed alongside the other `test:*` scripts):

```jsonc
"scripts": {
  // …existing…
  "compile-e2e": "tsc -p ./test/e2e/tsconfig.json",
  "compile-e2e-watch": "tsc -p ./test/e2e/tsconfig.json --watch",
  "setup:e2e:vscode": "extest get-vscode -c max && extest get-chromedriver -c max",
  "setup:e2e:deps": "extest install-from-marketplace ms-python.python -e .test-extensions",
  "setup:e2e": "npm run setup:e2e:vscode && npm run setup:e2e:deps",
  "test:e2e": "extest setup-and-run \"./out/e2e/suite/*.e2e.test.js\" -c max -o ./test/e2e/settings.json -e .test-extensions -m ./test/e2e/.mocharc.js -i"
}
```

`compile-e2e` builds `test/e2e` → `out/e2e` (run it, or `compile-e2e-watch`, before `test:e2e`) —
mirroring the unit-test flow (`compile-tsc` / `compile-tsc-watch` then `test:unittests`), with no
`pre`-hook coupling compilation to the run. `setup:e2e:deps` installs the Python extension using
the *downloaded* test VS Code's CLI, so `setup:e2e:vscode` must run first.

What the `extest setup-and-run` flags mean:

- positional glob `"./out/e2e/suite/*.e2e.test.js"` — the compiled test(s) to run.
- `-c max` — download the newest VS Code ExTester supports (matching ChromeDriver fetched
  automatically).
- `-o ./test/e2e/settings.json` — user settings applied to the test instance.
- `-e .test-extensions` — isolated extensions directory.
- `-m ./test/e2e/.mocharc.js` — the Mocha config.
- `-i` — install declared extension *dependencies* from the Marketplace. (We have none
  declared, so the Python extension is installed separately via `setup:e2e:deps`, since it
  is not an `extensionDependency`.)

### 6.2 `.gitignore` additions

```gitignore
# ExTester (vscode-extension-tester) E2E artifacts
test-resources
.test-extensions
```

(`out/` is already ignored, covering `out/e2e/` and any `_screenshots` beneath it.)

**Also add to `.vscodeignore`** (separate from `.gitignore` — `vsce` reads `.vscodeignore`
when it exists and ignores `.gitignore` entirely). `test/` and `out/` are already excluded
there, but the e2e *artifact* dirs are not, and `-e .test-extensions` puts ~200 MB / 10k files
in the repo root that would otherwise be packed into the VSIX on every run:

```gitignore
.test-extensions/**
test-resources/**
```

### 6.3 `test/e2e/tsconfig.json`

```jsonc
{
    // Standalone config for the ExTester E2E suite. It is intentionally independent of the
    // extension's root tsconfig (which only compiles ./src) so these tests never enter the
    // esbuild bundle or the unit/integration test globs. CommonJS + chai v4 keeps
    // `import { expect } from 'chai'` working without ESM friction.
    "compilerOptions": {
        "module": "commonjs",
        "target": "ES2022",
        "lib": ["ES2022", "DOM"],
        "moduleResolution": "node",
        "outDir": "../../out/e2e",
        "rootDir": ".",
        "sourceMap": true,
        "strict": true,
        "skipLibCheck": true,
        "esModuleInterop": true,
        "resolveJsonModule": true,
        "types": ["node", "mocha", "chai"]
    },
    "include": ["**/*.ts"]
}
```

### 6.4 `test/e2e/.mocharc.js`

```js
// Mocha configuration for the ExTester (vscode-extension-tester) E2E suite.
// UI tests are slow: the 2s Mocha default is unusable. Individual waits inside the
// tests are the real guard rails; this is a generous suite-level safety net.
module.exports = {
    timeout: 900000, // 15 min — env creation + first kernel start (venv + toolkit) can be slow
    retries: 1, // absorb transient UI flakiness with a single retry
    reporter: 'spec',
    color: true
};
```

### 6.5 `test/e2e/settings.json`

Reduces UI noise and makes automation deterministic. The `files.simpleDialog.enable` +
`window.dialogStyle: custom` pair turns native OS dialogs (undriveable by Selenium) into
in-window quick inputs — a Red-Hat-wide best practice. `security.workspace.trust.enabled:
false` prevents a workspace-trust modal from blocking the run.

```json
{
    "files.simpleDialog.enable": true,
    "window.dialogStyle": "custom",
    "workbench.editor.enablePreview": false,
    "workbench.startupEditor": "none",
    "extensions.ignoreRecommendations": true,
    "workbench.remoteIndicator.showExtensionRecommendations": false,
    "git.autoRepositoryDetection": false,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "jupyter.kernels.trusted": true,
    "security.workspace.trust.enabled": false
}
```

### 6.6 `test/e2e/fixtures/hello-world.deepnote`

```yaml
version: '1.0.0'
metadata:
  createdAt: '2025-01-01T00:00:00.000Z'
  modifiedAt: '2025-01-01T00:00:00.000Z'
project:
  id: e2e-hello-world-project
  name: E2E Hello World
  notebooks:
    - id: e2e-hello-world-notebook
      name: Hello World
      blocks:
        - id: e2e-hello-block
          blockGroup: e2e-group
          type: code
          content: |-
            print("hello world")
          sortingKey: a0
          metadata: {}
      executionMode: block
      isModule: false
  settings: {}
```

### 6.7 `test/e2e/suite/helloWorld.e2e.test.ts`

```ts
/**
 * End-to-end UI test driven by ExTester (vscode-extension-tester).
 *
 * It exercises the full Deepnote happy path through the *real* VS Code UI:
 *   1. open a one-notebook `.deepnote` file containing `print("hello world")`
 *   2. create a Deepnote environment            (command `deepnote.environments.create`)
 *   3. select that environment for the notebook (command `deepnote.environments.selectForNotebook`)
 *      — this builds and selects the notebook's kernel controller ("kernel connected")
 *   4. run the cell                             (the notebook toolbar's "Run All" button)
 *   5. assert the rendered stdout output contains "hello world"
 *
 * Prerequisites (see specs/e2e-extester-testing-plan.md):
 *   - The Python extension (`ms-python.python`) must be installed in the test instance
 *     (`npm run setup:e2e:deps`) and at least one Python interpreter must be discoverable.
 *   - Creating the environment provisions a venv and the Deepnote toolkit, which needs
 *     network access; the first kernel start can take a few minutes.
 *
 * Notebook output in VS Code renders inside two nested iframes
 * (iframe.webview.ready -> #active-frame). ExTester's WebView page object descends
 * exactly those two levels, which is how we read the rendered output below.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { expect } from 'chai';
import {
    By,
    EditorView,
    InputBox,
    Notification,
    VSBrowser,
    WebView,
    Workbench,
    type WebDriver
} from 'vscode-extension-tester';

// Command palette labels (category + title) the way `Workbench.executeCommand` matches them.
const CREATE_ENV_COMMAND = 'Deepnote: Create Environment';
const SELECT_ENV_COMMAND = 'Deepnote: Select Environment for Notebook';

const NOTEBOOK_FILE_NAME = 'hello-world.deepnote';
const EXPECTED_OUTPUT = 'hello world';

// Timeouts (ms). UI ops are slow and the first kernel start is the slowest step.
const WORKBENCH_TIMEOUT = 60_000;
const QUICK_PICK_TIMEOUT = 30_000;
const ENV_CREATED_TIMEOUT = 120_000;
const KERNEL_CONNECT_TIMEOUT = 300_000;
const OUTPUT_TIMEOUT = 300_000;
// How often to re-issue "Run All" while waiting for output — the first run can be dropped right
// after the kernel connects.
const RUN_ALL_REISSUE_INTERVAL = 25_000;
const INTERPRETER_RETRY_DELAY = 5_000;
const MAX_CREATE_ATTEMPTS = 6;
// The in-window simple file/folder dialog needs a beat to resolve a typed path before it accepts.
const DIALOG_RESOLVE_DELAY = 1_500;
const FOLDER_OPEN_ATTEMPTS = 5;
const FOLDER_RELOAD_TIMEOUT = 12_000;

// Selectors that only exist inside the notebook output iframe (`#active-frame`),
// so reading them cannot accidentally match the cell's source in the editor.
const OUTPUT_SELECTOR = '.output_container, .output, .rendered-output';

describe('Deepnote E2E — run "hello world"', function () {
    // Per-test timeout for the whole suite (overrides the mocharc default for these tests).
    this.timeout(22 * 60 * 1000);

    let driver: WebDriver;
    let notebookFile: string;
    // A stable name: createEnvironment is idempotent (it treats "already exists" as success), so a
    // leftover environment from a previous or retried run is reused rather than colliding — which
    // also lets a persistent test instance reuse the already-provisioned venv.
    const environmentName = 'E2E Hello Env';

    before(async function () {
        driver = VSBrowser.instance.driver;

        // Open a throwaway copy so execution-dirtied notebook state never touches the source tree.
        const source = path.resolve(process.cwd(), 'test', 'e2e', 'fixtures', NOTEBOOK_FILE_NAME);
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-e2e-'));
        notebookFile = path.join(tempDir, NOTEBOOK_FILE_NAME);
        fs.copyFileSync(source, notebookFile);

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Open the temp directory as a workspace folder FIRST. The Deepnote serializer reads a
        // "snapshot" during deserialization and, with no workspace folder open, blocks on a
        // `showWarningMessage('Cannot read snapshot: No workspace folders found.')` that never
        // resolves headlessly — leaving the notebook blank. A workspace folder also provides the
        // requirements.txt path the kernel auto-selector needs. (Opening a folder reloads the
        // window, so we re-wait for the workbench afterwards.)
        await openFolderViaDialog(tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Open the notebook by driving the running window directly. ExTester's `openResources`
        // shells out to `code -r <file>` (reuse-window over IPC), which silently no-ops in a
        // sandboxed/headless environment. Now that the containing folder is the workspace, the
        // notebook is reachable by name through Quick Open ("Go to File...").
        await openWorkspaceFile(NOTEBOOK_FILE_NAME);

        // The native notebook editor opens because the extension registers a serializer for
        // the `deepnote` notebook type; a single-notebook file resolves to its default notebook.
        await driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((t) => t.includes(NOTEBOOK_FILE_NAME)),
            WORKBENCH_TIMEOUT,
            'Deepnote notebook editor did not open'
        );
    });

    after(async function () {
        // Defensive cleanup: never leave the driver stuck inside a webview frame, and close tabs.
        await new WebView().switchBack().catch(() => undefined);
        await new EditorView().closeAllEditors().catch(() => undefined);
    });

    it('creates an environment, connects the kernel, runs the cell and renders output', async function () {
        await createEnvironment(environmentName);
        await selectEnvironmentForNotebook(environmentName);

        const renderedOutput = await runAndAwaitOutput(EXPECTED_OUTPUT, OUTPUT_TIMEOUT);
        expect(renderedOutput).to.contain(EXPECTED_OUTPUT);
    });

    /**
     * Drives `deepnote.environments.create`: pick interpreter -> name -> skip packages ->
     * skip description. Retries when the Python extension has not finished discovering an
     * interpreter yet (the command shows an error and returns instead of opening a quick pick).
     */
    async function createEnvironment(name: string): Promise<void> {
        let lastError: unknown;

        for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt++) {
            await new Workbench().executeCommand(CREATE_ENV_COMMAND);

            // Either the interpreter quick pick opens, or (no interpreter discovered yet) the
            // command shows a "No Python interpreters found" notification and returns.
            const interpreterPick = await tryOpenInputBox(5_000);
            if (!interpreterPick) {
                await dismissAllNotifications();
                await driver.sleep(INTERPRETER_RETRY_DELAY);
                lastError = new Error('interpreter quick pick did not appear (interpreter discovery not ready?)');
                continue;
            }

            try {
                await driver.wait(
                    async () => (await interpreterPick.getQuickPicks()).length > 0,
                    QUICK_PICK_TIMEOUT,
                    'no Python interpreters were listed'
                );
            } catch (error) {
                await interpreterPick.cancel().catch(() => undefined);
                await dismissAllNotifications();
                await driver.sleep(INTERPRETER_RETRY_DELAY);
                lastError = error;
                continue;
            }

            await interpreterPick.selectQuickPick(0);

            const nameBox = await InputBox.create();
            await nameBox.setText(name);
            await nameBox.confirm();

            // Packages (optional) — leave empty.
            await (await InputBox.create()).confirm();

            // Description (optional) — leave empty.
            await (await InputBox.create()).confirm();

            // Treat both the success toast and the "already exists" guard as success: a leftover
            // environment from a previous/retried run is fine — it will be selected next.
            await waitForNotification(/created successfully|already exists/i, ENV_CREATED_TIMEOUT, false);
            return;
        }

        throw new Error(
            `Failed to create a Deepnote environment after ${MAX_CREATE_ATTEMPTS} attempts. ` +
                `Ensure the Python extension is installed and an interpreter is discoverable. ` +
                `Last error: ${String(lastError)}`
        );
    }

    /**
     * Drives `deepnote.environments.selectForNotebook`. Selecting the environment rebuilds and
     * explicitly selects the notebook's kernel controller (provisioning the venv + toolkit),
     * which is what "wait for the kernel to connect" means in this extension.
     */
    async function selectEnvironmentForNotebook(name: string): Promise<void> {
        // The command requires an active `deepnote` notebook — make sure it's focused.
        await new EditorView().openEditor(NOTEBOOK_FILE_NAME);

        // Clear the "select an environment" prompt and any other toasts; they can overlap the
        // quick pick and intercept clicks.
        await dismissAllNotifications();

        await new Workbench().executeCommand(SELECT_ENV_COMMAND);

        const environmentPick = await InputBox.create(QUICK_PICK_TIMEOUT);
        // Filter to the environment by name and accept with Enter rather than clicking the row:
        // the quick-pick row contains a description `<p>` that can intercept a positional click.
        await environmentPick.setText(name);
        await driver.wait(
            async () => (await environmentPick.getQuickPicks()).length > 0,
            QUICK_PICK_TIMEOUT,
            'environment quick pick was empty'
        );
        await environmentPick.confirm();

        // Best-effort wait for the "switched successfully" toast; the authoritative gate is the
        // rendered output below, so a missed (auto-dismissed) toast must not fail the test.
        await waitForNotification(/switched successfully/i, KERNEL_CONNECT_TIMEOUT, false);
    }

    /**
     * Clicks the notebook editor toolbar's "Run All" button. The command-palette entry for
     * `deepnote.runallcells` ("Jupyter: Run All Cells") is gated behind context keys
     * (`deepnote.ispythonornativeactive`, …) that are not reliably set under automation, so driving
     * it through `Workbench.executeCommand` can silently miss and trigger the wrong command.
     */
    async function clickRunAll(): Promise<void> {
        await new EditorView().openEditor(NOTEBOOK_FILE_NAME);

        const runAllButton = await driver.wait(
            async () => {
                const [button] = await driver.findElements(By.css('a.action-label[aria-label="Run All"]'));

                return button;
            },
            WORKBENCH_TIMEOUT,
            'notebook "Run All" button did not appear'
        );
        await runAllButton.click();
    }

    /**
     * Opens a file that lives in the currently-open workspace folder via Quick Open ("Go to
     * File..."), matching by file name. Unlike the simple Open File dialog (where Enter does not
     * accept a typed path), Quick Open reliably opens the highlighted match on confirm.
     */
    async function openWorkspaceFile(fileName: string): Promise<void> {
        await new Workbench().executeCommand('Go to File...');

        const quickOpen = await InputBox.create(QUICK_PICK_TIMEOUT);
        await quickOpen.setText(fileName);
        await driver.wait(
            async () => (await quickOpen.getQuickPicks()).length > 0,
            QUICK_PICK_TIMEOUT,
            `"${fileName}" did not appear in Quick Open`
        );
        await quickOpen.confirm();
    }

    /**
     * Opens an absolute folder path as the workspace root via "File: Open Folder...". Opening a
     * folder reloads the VS Code window. In the simple folder dialog, Enter navigates *into* a
     * directory rather than accepting it as the workspace — the deterministic accept is the dialog's
     * "OK" button — so we type the path, click OK, and wait for the pre-reload workbench element to
     * detach (reload started). We retry the whole interaction defensively. The caller then waits for
     * the new workbench to mount.
     */
    async function openFolderViaDialog(folder: string): Promise<void> {
        for (let attempt = 1; attempt <= FOLDER_OPEN_ATTEMPTS; attempt++) {
            const previousWorkbench = await driver.findElement(By.css('.monaco-workbench'));

            await new Workbench().executeCommand('File: Open Folder...');
            const dialog = await InputBox.create(QUICK_PICK_TIMEOUT);
            await dialog.setText(folder);

            // The simple dialog resolves the typed path asynchronously (listing the enclosing
            // directory); wait for that listing and add a short settle before accepting.
            await driver
                .wait(
                    async () => (await dialog.getQuickPicks()).length > 0,
                    QUICK_PICK_TIMEOUT,
                    'dialog did not resolve path'
                )
                .catch(() => undefined);
            await driver.sleep(DIALOG_RESOLVE_DELAY);

            const accepted = await clickDialogOkButton();
            if (!accepted) {
                await new InputBox().cancel().catch(() => undefined);
                continue;
            }

            const reloaded = await driver
                .wait(async () => {
                    try {
                        await previousWorkbench.getTagName();

                        return false;
                    } catch {
                        return true;
                    }
                }, FOLDER_RELOAD_TIMEOUT)
                .then(() => true)
                .catch(() => false);
            if (reloaded) {
                return;
            }

            // The folder did not open this time; dismiss any lingering dialog and retry.
            await new InputBox().cancel().catch(() => undefined);
        }

        throw new Error(`Failed to open folder "${folder}" after ${FOLDER_OPEN_ATTEMPTS} attempts`);
    }

    /** Clicks the simple file/folder dialog's "OK" button. Returns false if it could not be found. */
    async function clickDialogOkButton(): Promise<boolean> {
        const buttons = await driver
            .findElements(By.css('.quick-input-widget .monaco-button.monaco-text-button'))
            .catch(() => []);
        for (const button of buttons) {
            const text = (await button.getText().catch(() => '')).trim();
            if (text === 'OK') {
                await button.click();

                return true;
            }
        }

        return false;
    }

    /**
     * Clicks "Run All" and polls the notebook output webview until the expected text renders,
     * re-issuing "Run All" periodically. The first run can be dropped when the kernel has only just
     * finished connecting, so we keep nudging it until output appears (re-running `print(...)` is
     * harmless).
     */
    async function runAndAwaitOutput(expected: string, timeout: number): Promise<string> {
        const deadline = Date.now() + timeout;
        let lastRunAt = 0;
        let lastText = '';

        while (Date.now() < deadline) {
            if (Date.now() - lastRunAt > RUN_ALL_REISSUE_INTERVAL) {
                await clickRunAll().catch(() => undefined);
                lastRunAt = Date.now();
            }

            lastText = await readRenderedOutput();
            if (lastText.includes(expected)) {
                return lastText;
            }

            await driver.sleep(2_000);
        }

        throw new Error(
            `Timed out after ${timeout}ms waiting for rendered output to contain "${expected}". ` +
                `Last observed output: ${JSON.stringify(lastText)}`
        );
    }

    /**
     * Reads the notebook cell output once.
     *
     * Output lives two iframes deep (iframe.webview.ready -> #active-frame). We only attempt to
     * switch when an output webview iframe actually exists (`getViewToSwitchTo`), and we read
     * output-specific elements inside the frame — so we never match the cell's source code that
     * is visible in the editor of the main document. Returns '' when no output is present yet.
     */
    async function readRenderedOutput(): Promise<string> {
        const webView = new WebView();
        const outputFrame = await webView.getViewToSwitchTo().catch(() => undefined);
        if (!outputFrame) {
            return '';
        }

        let text = '';
        try {
            await webView.switchToFrame(5_000);
            const elements = await webView.findWebElements(By.css(OUTPUT_SELECTOR));
            const texts = await Promise.all(elements.map((element) => element.getText().catch(() => '')));
            text = texts.join('\n').trim();

            // Fallback: if the renderer used unexpected classes, read the frame body — safe here
            // because we have confirmed we are inside the output iframe, not the editor.
            if (!text) {
                const body = await webView.findWebElement(By.css('body')).catch(() => undefined);
                text = body ? (await body.getText().catch(() => '')).trim() : '';
            }
        } catch {
            // Frame went stale or output not painted yet — treat as no output this tick.
        } finally {
            await webView.switchBack().catch(() => undefined);
        }

        return text;
    }

    async function tryOpenInputBox(timeout: number): Promise<InputBox | undefined> {
        try {
            return await InputBox.create(timeout);
        } catch {
            return undefined;
        }
    }

    async function dismissAllNotifications(): Promise<void> {
        const notifications = await new Workbench().getNotifications().catch(() => [] as Notification[]);
        for (const notification of notifications) {
            await notification.dismiss().catch(() => undefined);
        }
    }

    async function waitForNotification(
        pattern: RegExp,
        timeout: number,
        required: boolean
    ): Promise<Notification | undefined> {
        try {
            return (await driver.wait(
                async () => {
                    const notifications = await new Workbench().getNotifications().catch(() => [] as Notification[]);
                    for (const notification of notifications) {
                        const message = await notification.getMessage().catch(() => '');
                        if (pattern.test(message)) {
                            return notification;
                        }
                    }
                    return undefined;
                },
                timeout,
                `timed out waiting for a notification matching ${pattern}`
            )) as Notification;
        } catch (error) {
            if (required) {
                throw error;
            }
            return undefined;
        }
    }
});
```

---

## 7. How the hard parts work

### 7.1 Reading rendered output from nested iframes

ExTester has **no notebook page object**. VS Code renders cell output inside **two nested
iframes**:

```
main VS Code document
└─ iframe.webview.ready                 ← outer  (ExTester locator: iframe[class='webview ready'])
   └─ iframe#active-frame               ← inner  (ExTester locator: #active-frame)
      └─ .output_container .output      ← the rendered output lives here
```

ExTester's `WebView.switchToFrame()` descends **exactly those two levels** (verified in its
`WebviewMixin` source), which is why it lines up with the notebook output area. The test's
`waitForRenderedOutput` helper:

1. Constructs `new WebView()` and calls `getViewToSwitchTo()` — this returns the outer
   webview iframe **only if one exists**. The output iframe is created lazily once a cell
   produces output, so before execution it returns `undefined` and we simply keep polling.
   **This gate is what prevents a false positive**: without it, `switchToFrame()` would
   no-op (stay in the main document) and reading the body would match the cell's *source*
   `print("hello world")` shown in the editor.
2. Once a frame exists, `switchToFrame(5_000)` descends both levels.
3. Reads **output-scoped** elements (`.output_container, .output, .rendered-output`) — not
   the whole body — and joins their text. (A body-text fallback is used only when those
   classes are absent, and it's safe there because we've confirmed we are inside the output
   iframe.)
4. **Always `switchBack()` in `finally`** — touching the main document while switched into
   a frame throws `StaleElementReferenceError`.
5. Loops until the text contains `hello world` or the timeout elapses.

**Fallback if `WebView` ever mis-targets the frame** (e.g. VS Code adds a class so the
exact `iframe[class='webview ready']` locator misses): drive Selenium directly —
`driver.switchTo().frame(driver.findElement(By.css('iframe.webview')))` then
`driver.switchTo().frame(driver.findElement(By.id('active-frame')))`, read, then
`driver.switchTo().defaultContent()`.

**Note on shadow DOM:** rich/widget renderers may render into a shadow root (unreachable by
plain CSS). Plain stdout text (our case) renders in light DOM and is reachable.

### 7.2 Driving QuickPicks & InputBoxes

`Workbench.executeCommand(label)` opens the palette and matches the **friendly command
title** (category + title), so we pass e.g. `'Deepnote: Create Environment'`, not the
command id. Since VS Code 1.44, `InputBox` represents both text prompts and QuickPicks; we
re-create it between steps because each step replaces the DOM.

Flakiness guards built into the test:

- **Interpreter-discovery latency.** The Python extension populates
  `api.environments.known` asynchronously; if empty, the create command shows *"No Python
  interpreters found"* and returns (no quick pick). The test detects the missing quick pick
  (`tryOpenInputBox` times out), dismisses notifications, waits, and **retries up to 6
  times**.
- **Idempotent environment creation** with a stable name (`E2E Hello Env`): `createEnvironment`
  treats the "name already exists" guard as success, so a leftover env from a Mocha retry (or a
  persistent local instance) is reused rather than colliding — and its venv is reused too.
- **Notification waits are best-effort** for the transient success toasts; the authoritative
  gate is the rendered output, so an auto-dismissed toast never fails the test.
- **`driver.wait(...)`** is used for every asynchronous UI state instead of bare sleeps
  where possible.

---

## 8. Running it

`extest setup-and-run` loads the extension from the **built** `dist/` output and launches a
real VS Code window. First-time sequence:

```bash
npm run compile      # build the extension under test (produces dist/extension.node.js)
npm run setup:e2e    # download test VS Code + ChromeDriver and install ms-python.python (one-time)
npm run compile-e2e  # build the test sources (test/e2e → out/e2e); or run compile-e2e-watch
npm run test:e2e     # extest packages the extension, downloads/launches VS Code, runs the tests
```

- **Linux is headless** → install the Electron/Chromium system libraries and Xvfb (§0), then
  wrap the run:
  ```bash
  xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24' npm run test:e2e
  ```
  macOS/Windows run directly. (ExTester always launches VS Code with `--no-sandbox`, so the
  Ubuntu 24.04 AppArmor user-namespace restriction does not block the test — no sysctl needed;
  inside a container where that sysctl is read-only, `--no-sandbox` is what makes it work.)
- A **venv-capable Python interpreter** must be discoverable (§0), and creating the environment
  installs the Deepnote toolkit (**network required**); the first kernel start can take minutes.
- ExTester caches VS Code/ChromeDriver under `test-resources/` (by default
  `$TMPDIR/test-resources`, e.g. `/tmp/test-resources`) after the first download.
- Failure screenshots are written under `test-resources/**/_screenshots/` (and any
  `_screenshots` under `out/e2e/`).

**Compatibility note:** ExTester `8.23.0` supports a floating window of recent VS Code
minors; `-c max` picks the newest. Our extension's `engines.vscode` is `^1.95.0`, so any
1.x ≥ 1.95 (including `max`) is compatible. Node should be an active LTS (the repo's
`.nvmrc`; local dev uses Node 22).

---

## 9. CI integration

Add a dedicated job (separate from lint/typecheck/unit so its weight and flakiness are
isolated). Linux must run under a virtual framebuffer.

```yaml
e2e:
  name: E2E (ExTester)
  runs-on: ubuntu-latest
  timeout-minutes: 45
  steps:
    - uses: actions/checkout@v6
    - uses: actions/setup-node@v6
      with: { cache: npm, node-version-file: .nvmrc }
    - uses: actions/setup-python@v5        # interpreter for the Deepnote environment
      with: { python-version: '3.12' }
    - run: npm ci --prefer-offline --no-audit
    - run: npm run compile                 # build the extension under test
    # Electron/Chromium runtime libraries (the test VS Code won't launch without them) + Xvfb
    - run: |
        sudo apt-get update
        sudo apt-get install -y xvfb \
          libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libgtk-3-0t64 libgdk-pixbuf-2.0-0 \
          libgbm1 libasound2t64 libnss3 libnspr4 libxss1 libxshmfence1 libdrm2 libxkbcommon0 \
          libxcomposite1 libxdamage1 libxrandr2 libxfixes3 libxext6 libxrender1 libpango-1.0-0 \
          libcairo2 libatspi2.0-0 libx11-xcb1 libxcb-dri3-0 libxtst6 libsecret-1-0 \
          libgssapi-krb5-2 libdbus-1-3 libexpat1 python3.12-venv python3-pip
    # Download the test VS Code and install ms-python.python (§0). ExTester always launches with
    # --no-sandbox, so no AppArmor sysctl is required; no proposed-API patch is needed either.
    - run: npm run setup:e2e
    - name: Run E2E
      uses: nick-fields/retry@v4           # absorb transient UI flakiness
      with:
        timeout_minutes: 40
        max_attempts: 2
        command: xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24' npm run test:e2e
    - uses: actions/upload-artifact@v7
      if: failure()
      with:
        name: e2e-screenshots
        path: |
          test-resources/**/_screenshots/**/*.png
          out/e2e/**/_screenshots/**/*.png
```

Notes:
- ExTester caches VS Code/ChromeDriver under `test-resources/` itself; optionally cache that
  directory to speed reruns.
- On macOS/Windows runners drop the `xvfb-run` wrapper.
- **Network**: creating the environment installs the Deepnote toolkit (pip). The runner
  needs outbound network, or a pre-seeded/offline toolkit — the single biggest portability
  risk; flag it when enabling the job.

---

## 10. Gotchas & flakiness mitigation

- **Bump timeouts.** Mocha's 2 s default is unusable; the suite uses `timeout: 1500000` (25 min)
  and the test sets a 22-minute per-test timeout (overrides the suite default).
- **Prefer `executeCommand` over clicking** *for palette commands that are always enabled* — but
  some are not. `deepnote.runallcells` is gated behind context keys that don't hold under
  automation, so the test clicks the toolbar's "Run All" button instead (§0).
- **The simple file dialog accepts via its "OK" button, not Enter.** Enter navigates into a
  directory. Type the path, then click `.quick-input-widget .monaco-button.monaco-text-button`
  whose text is "OK" (§0, `clickDialogOkButton`).
- **Re-issue "Run All"** while polling for output — the first run can be dropped right after the
  kernel connects (§0, `runAndAwaitOutput`).
- **Always `switchBack()` in `finally`** around any webview interaction.
- **Use the safe constructors** (`await InputBox.create()`, `await EditorView().openEditor(...)`)
  rather than `new InputBox()` when the element may not be ready.
- **Clean up** in `after`: `switchBack()` defensively and `closeAllEditors()`.
- **macOS caveat** (if you extend the suite): native title-bar menus, native context menus,
  and native file dialogs are unsupported by ExTester — use command-palette equivalents and
  VS Code "simple" dialogs (we already force `files.simpleDialog.enable`).
- **`getCurrentChannel`/`getLaunchConfiguration`** are broken on Windows/Linux for VS Code
  ≥ 1.87 — avoid them.
- **chai v5** is ESM-only — stay on chai v4 (the repo's version).

---

## 11. Where ExTester fits vs the other test layers

This repo already has three layers; ExTester is a fourth that fills the "real rendered UX"
gap. It **replaces nothing**.

| Layer | Runner | Covers |
| --- | --- | --- |
| Unit (`*.unit.test.ts`) | Mocha + Chai (`build/.mocha.unittests.js.json`) | Pure logic, no VS Code host. |
| Integration (`*.vscode.test.ts`) | `@vscode/test-electron` (`src/test/standardTest.node.ts`) | Runs **inside** the extension host with the `vscode` API. |
| Smoke (`src/smoke`) | custom harness | Broad checks. |
| **E2E (this) (`*.e2e.test.ts`)** | **ExTester** (`test/e2e`) | **Black-box, real VS Code UI** — open → env → kernel → run → rendered output. |

**Rule of thumb:** assert *rendered pixels* with ExTester; assert *output data/semantics*
with the integration layer. For output-heavy correctness, the in-host API route (what
upstream microsoft/vscode-jupyter does — drive `notebook.cell.execute`, read
`cell.outputs[].items[].data` via `TextDecoder`, no iframes) is more reliable; add such
tests as the volume layer over time. Reserve ExTester for a *small* number of high-value
end-to-end smoke tests like the one shipped here.

---

## 12. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| No notebook page object in ExTester | Use `WebView` (its 2-level frame switch matches the notebook output iframes); assert on output-scoped selectors; raw-Selenium fallback documented (§7.1). |
| Reading editor source as if it were output | Gate frame switching on `getViewToSwitchTo()` and read output-scoped selectors only (§7.1). |
| Python interpreter not discovered in time | Install `ms-python.python`; retry the create command up to 6×; `setup-python` in CI. |
| Env creation needs network (pip toolkit) | Documented prerequisite; consider an offline/seeded toolkit for CI. |
| First kernel start is slow | Long polls (5 min on output / kernel connect); 13-min per-test timeout; `nick-fields/retry`. |
| Linux GUI / sandbox | `xvfb-run`; AppArmor sysctl on Ubuntu 24.04. |
| UI flakiness | `driver.wait` everywhere; `switchBack` in `finally`; screenshots on failure; one Mocha retry. |
| chai v5 ESM breakage | Pin chai v4 (already the repo's version). |
| Workspace-trust modal blocks automation | `security.workspace.trust.enabled: false` in test settings. |

---

## Appendix A — ExTester API surface used

All imported from `vscode-extension-tester` (re-exported from `@redhat-developer/page-objects`,
`@redhat-developer/locators`, and `selenium-webdriver`). Signatures verified against the
installed `8.23.0`.

| Symbol | Member | Notes |
| --- | --- | --- |
| `VSBrowser` | `instance` | singleton |
| | `instance.driver` | the selenium `WebDriver` (`.wait`, `.sleep`, …) |
| | `openResources(...paths, cb?)` | open files/folders (absolute paths) |
| | `waitForWorkbench(timeout?)` | wait until workbench is ready |
| | `takeScreenshot(name)` | manual screenshot → `<storage>/_screenshots` |
| `Workbench` | `executeCommand(label)` | matches the friendly command **title** |
| | `getNotifications()` | current toast notifications |
| `EditorView` | `openEditor(title)` | focus/return an editor tab |
| | `getOpenEditorTitles()` | open tab titles |
| | `closeAllEditors()` | cleanup |
| `InputBox` | `static create(timeout?)` | safe constructor; represents prompts **and** QuickPicks |
| | `setText` / `confirm` / `cancel` | text prompts |
| | `getQuickPicks()` / `selectQuickPick(idxOrText)` / `findQuickPick` | quick picks (substring match) |
| | `hasProgress()` | true while the input shows a progress bar |
| `WebView` | `getViewToSwitchTo()` | returns the outer webview iframe element or `undefined` |
| | `switchToFrame(timeout?)` / `switchBack()` | descend into / out of the (2-level) webview iframes |
| | `findWebElement(locator)` / `findWebElements(locator)` | query inside the frame |
| `Notification` | `getMessage()` / `getType()` / `dismiss()` / `takeAction(title)` | toast inspection |
| `By`, `until`, `Key`, `WebDriver` | — | re-exported selenium primitives |

---

## Appendix B — Deepnote command-id reference

The commands this test drives, with their command ids and palette labels (from
`package.json` + `package.nls.json`):

| Palette label (used in the test) | Command id | Category |
| --- | --- | --- |
| `Deepnote: Create Environment` | `deepnote.environments.create` | Deepnote |
| `Deepnote: Select Environment for Notebook` | `deepnote.environments.selectForNotebook` | Deepnote |
| `Jupyter: Run All Cells` | `deepnote.runallcells` | Jupyter |

Notebook type registered for `.deepnote`: **`deepnote`**
(`contributes.notebooks[].type`, selector `*.deepnote`).

---

## References

ExTester:
- Repo / wiki: https://github.com/redhat-developer/vscode-extension-tester ·
  https://github.com/redhat-developer/vscode-extension-tester/wiki
- Test setup (CLI): https://github.com/redhat-developer/vscode-extension-tester/wiki/Test-Setup
- WebView page object: https://github.com/redhat-developer/vscode-extension-tester/wiki/WebView
- Workbench / Input: https://github.com/redhat-developer/vscode-extension-tester/wiki/Workbench ·
  https://github.com/redhat-developer/vscode-extension-tester/wiki/Input
- Example project: https://github.com/redhat-developer/vscode-extension-tester-example
- Known issues (AppArmor, etc.): https://github.com/redhat-developer/vscode-extension-tester/blob/main/KNOWN_ISSUES.md

Real-world usage studied: redhat-developer/{vscode-quarkus, vscode-server-connector,
vscode-rsp-ui} and the framework's own `tests/test-project`.

VS Code notebook internals (output DOM / iframes): VS Code source `webviewPreloads.ts`,
`pre/index.html`; Notebook API guide
https://code.visualstudio.com/api/extension-guides/notebook ; built-in commands
https://code.visualstudio.com/api/references/commands

Upstream test approach (API-driven alternative): microsoft/vscode-jupyter
`src/test/datascience/notebook/helper.ts`.

Codebase anchors: `src/notebooks/deepnote/deepnoteKernelAutoSelector.node.ts`,
`src/kernels/deepnote/environments/deepnoteEnvironmentsView.node.ts`,
`src/notebooks/deepnote/deepnoteSerializer.ts`.
