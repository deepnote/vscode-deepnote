/**
 * ExTester E2E for `.deepnote.env.yaml` integration injection: writes a `.deepnote.env.yaml` + `.env`, opens the
 * notebook, runs a cell printing `PROD_POSTGRES_HOST`, and asserts it resolves to the `.env` value (see consts below).
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { EditorView, VSBrowser, WebView } from 'vscode-extension-tester';

import {
    FIRST_RUN_OUTPUT_TIMEOUT,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureToTempDir,
    createEnvironment,
    openFolderViaDialog,
    openWorkspaceFile,
    runOnceAndAwaitOutput,
    selectEnvironmentForNotebook
} from '../helpers';

const NOTEBOOK_FILE_NAME = 'integrations-env-file.deepnote';
const EXPECTED_OUTPUT = 'injected-host.example.com';

const INTEGRATIONS_ENV_FILE_NAME = '.deepnote.env.yaml';
const DOTENV_FILE_NAME = '.env';

// `.deepnote.env.yaml`: one `pgsql` integration whose `host` is an `env:` ref resolved against `.env`; the
// remaining metadata are literals so the config is complete. `host`/`port` are quoted to keep them strings
// (`env:...` contains a colon; `5432` would otherwise parse as a number).
const INTEGRATIONS_ENV_YAML = `integrations:
  - id: e2e-pg-integration
    name: Prod Postgres
    type: pgsql
    metadata:
      host: "env:DEMO_DB_HOST"
      port: "5432"
      database: mydb
      user: root
      password: secret
`;

// `.env`: dotenv source for the `env:DEMO_DB_HOST` ref above. Deliberately a DISTINCT key from the printed
// `PROD_POSTGRES_HOST`, so a passing assertion can only come from the `.yaml` `env:` resolution — not the
// extension's direct `.env` injection (which would set `DEMO_DB_HOST`, a key the cell never reads).
const DOTENV_CONTENT = 'DEMO_DB_HOST=injected-host.example.com\n';

describe('Deepnote E2E — inject integration env var from `.deepnote.env.yaml`', function () {
    // Per-test timeout for the whole suite (overrides the mocharc default for these tests).
    this.timeout(SUITE_TIMEOUT);

    // A stable name: createEnvironment is idempotent (it treats "already exists" as success), so a
    // leftover environment from a previous or retried run is reused rather than colliding — which
    // also lets a persistent test instance reuse the already-provisioned venv.
    const environmentName = 'E2E Integrations Env';

    // Captured in `before` and invoked in `after` to remove the throwaway temp dir.
    let cleanupTempDir: (() => void) | undefined;
    // The temp workspace dir, so the live-refresh assertion can rewrite `.env`.
    let tempDir: string;

    before(async function () {
        // Work on a throwaway copy so execution-dirtied notebook state never touches the source tree.
        const copied = copyFixtureToTempDir(NOTEBOOK_FILE_NAME);
        cleanupTempDir = copied.cleanup;
        tempDir = copied.tempDir;

        // Write the env files next to the notebook BEFORE opening the workspace so the loader sees them
        // when the kernel first starts. `.deepnote.env.yaml` carries the integration; `.env` resolves its
        // `env:` ref.
        fs.writeFileSync(path.join(tempDir, INTEGRATIONS_ENV_FILE_NAME), INTEGRATIONS_ENV_YAML);
        fs.writeFileSync(path.join(tempDir, DOTENV_FILE_NAME), DOTENV_CONTENT);

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Open the folder as the workspace FIRST (the serializer's snapshot read blocks headlessly without one), then re-wait for the workbench after the reload.
        await openFolderViaDialog(tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Now that the containing folder is the workspace, the notebook is reachable by name.
        await openWorkspaceFile(NOTEBOOK_FILE_NAME);

        // The native notebook editor opens because the extension registers a serializer for the
        // `deepnote` notebook type; a single-notebook file resolves to its default notebook.
        await VSBrowser.instance.driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((t) => t.includes(NOTEBOOK_FILE_NAME)),
            WORKBENCH_TIMEOUT,
            'Deepnote notebook editor did not open'
        );
    });

    after(async function () {
        // Defensive cleanup: never leave the driver stuck inside a webview frame, and close tabs.
        await new WebView().switchBack().catch((error) => {
            console.warn('[deepnote-e2e] switch back from webview during cleanup:', error);
        });
        await new EditorView().closeAllEditors().catch((error) => {
            console.warn('[deepnote-e2e] close all editors during cleanup:', error);
        });

        // Remove the throwaway temp dir last so a failure above can't leak it.
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[deepnote-e2e] remove temp workspace dir during cleanup:', error);
        }
    });

    it('injects `PROD_POSTGRES_HOST` from `.env`, then live-refreshes it on a `.env` change without a restart', async function () {
        await createEnvironment(environmentName);
        await selectEnvironmentForNotebook(environmentName, NOTEBOOK_FILE_NAME);

        // Initial: the toolkit resolves PROD_POSTGRES_HOST from `.env` at kernel start.
        const first = await runOnceAndAwaitOutput(NOTEBOOK_FILE_NAME, EXPECTED_OUTPUT, FIRST_RUN_OUTPUT_TIMEOUT);
        expect(first).to.contain(EXPECTED_OUTPUT);

        // Live refresh: rewrite `.env`; the watcher runs `set_integration_env()` in the SAME running kernel
        // (no restart, no re-select), so a re-run must read the new value.
        fs.writeFileSync(path.join(tempDir, DOTENV_FILE_NAME), 'DEMO_DB_HOST=refreshed-host.example.com\n');
        // Wait out the watcher debounce + let it queue the hidden refresh on the kernel (which the kernel runs
        // before the next Run All).
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const second = await runOnceAndAwaitOutput(
            NOTEBOOK_FILE_NAME,
            'refreshed-host.example.com',
            FIRST_RUN_OUTPUT_TIMEOUT
        );
        expect(second).to.contain('refreshed-host.example.com');
    });
});
