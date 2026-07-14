/**
 * End-to-end UI test driven by ExTester (vscode-extension-tester).
 *
 * It proves the `.deepnote.env.yaml` -> `env:` -> dotenv -> integration -> kernel-injection path end to
 * end through the *real* VS Code UI:
 *   1. open a one-notebook `.deepnote` file declaring a single `pgsql` integration ("Prod Postgres")
 *      whose only cell prints `os.environ.get('PROD_POSTGRES_HOST')`
 *   2. write `.deepnote.env.yaml` (the integration's `host` = `env:DEMO_DB_HOST`) and `.env`
 *      (`DEMO_DB_HOST=injected-host.example.com`) into the temp workspace
 *   3. create a Deepnote environment + select it for the notebook (builds and connects the kernel)
 *   4. run the cell and assert the rendered output contains `injected-host.example.com`
 *
 * Why the cell reads `PROD_POSTGRES_HOST` (not `DEMO_DB_HOST`): integration env vars are derived from the
 * integration *name* — `convertToEnvironmentVariableName('Prod Postgres')` + `_HOST` = `PROD_POSTGRES_HOST`
 * (via `@deepnote/database-integrations`' `getEnvironmentVariablesForIntegrations`). The file config is
 * loaded by `IntegrationsFileConfigProvider`, merged in `SqlIntegrationEnvironmentVariablesProvider`, and
 * gathered by the toolkit server at spawn — so a rendered `PROD_POSTGRES_HOST` exercises exactly this path.
 *
 * Why the `.env` key is the DISTINCT name `DEMO_DB_HOST`: the extension's pre-existing `.env` support
 * (`customEnvironmentVariablesProvider`) injects `.env` keys *directly* into the kernel, so a cell reading
 * `DEMO_DB_HOST` would pass even if this feature did nothing. `DEMO_DB_HOST` only becomes
 * `PROD_POSTGRES_HOST` by being resolved *through* the `.deepnote.env.yaml` `env:` ref — so asserting on
 * `PROD_POSTGRES_HOST` isolates the new file-config path from that direct `.env` injection.
 *
 * The reusable interaction helpers live in `test/e2e/helpers/`; this file is only the suite wiring.
 *
 * Prerequisites (same as helloWorld.e2e.test.ts):
 *   - The Python extension (`ms-python.python`) must be installed in the test instance
 *     (`npm run setup:e2e:deps`) and at least one Python interpreter must be discoverable.
 *   - Creating the environment provisions a venv and the Deepnote toolkit, which needs network
 *     access; the first kernel start can take a few minutes.
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
// `PROD_POSTGRES_HOST` so the assertion cannot be satisfied by direct `.env` injection (see file header).
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

    before(async function () {
        // Work on a throwaway copy so execution-dirtied notebook state never touches the source tree.
        const { cleanup, tempDir } = copyFixtureToTempDir(NOTEBOOK_FILE_NAME);
        cleanupTempDir = cleanup;

        // Write the env files next to the notebook BEFORE opening the workspace so the loader sees them
        // when the kernel first starts. `.deepnote.env.yaml` carries the integration; `.env` resolves its
        // `env:` ref.
        fs.writeFileSync(path.join(tempDir, INTEGRATIONS_ENV_FILE_NAME), INTEGRATIONS_ENV_YAML);
        fs.writeFileSync(path.join(tempDir, DOTENV_FILE_NAME), DOTENV_CONTENT);

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Open the temp directory as a workspace folder FIRST. The Deepnote serializer reads a
        // "snapshot" during deserialization and, with no workspace folder open, blocks on a
        // `showWarningMessage('Cannot read snapshot: No workspace folders found.')` that never
        // resolves headlessly — leaving the notebook blank. A workspace folder also provides the
        // requirements.txt path the kernel auto-selector needs. (Opening a folder reloads the
        // window, so we re-wait for the workbench afterwards.)
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

    it('resolves the integration host from `.env` and injects it as `PROD_POSTGRES_HOST`', async function () {
        await createEnvironment(environmentName);
        await selectEnvironmentForNotebook(environmentName, NOTEBOOK_FILE_NAME);

        const renderedOutput = await runOnceAndAwaitOutput(NOTEBOOK_FILE_NAME, EXPECTED_OUTPUT, FIRST_RUN_OUTPUT_TIMEOUT);
        expect(renderedOutput).to.contain(EXPECTED_OUTPUT);
    });
});
