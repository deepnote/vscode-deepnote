/**
 * ExTester E2E for the chart-block path: a `visualization` block executes as `_dntk.DeepnoteChart(...)`,
 * comes back as `application/vnd.vega.v5+json`, and is drawn by the `deepnote-vega-renderer`.
 *
 * The fixture charts a `uuid.UUID` column on purpose: Arrow infers the `arrow.uuid` extension type
 * (`FixedSizeBinary(16)`) for such columns and VegaFusion cannot serialize that to JSON, so the
 * toolkit stringifies them before charting.
 */

import { expect } from 'chai';
import { EditorView, VSBrowser, WebView } from 'vscode-extension-tester';

import {
    FIRST_RUN_OUTPUT_TIMEOUT,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    awaitRenderedChart,
    copyFixtureToTempDir,
    createEnvironment,
    openFolderViaDialog,
    openWorkspaceFile,
    runOnceAndAwaitOutput,
    selectEnvironmentForNotebook
} from '../../helpers';

const NOTEBOOK_FILE_NAME = 'chart-uuid.deepnote';

// Only establishes that the kernel ran the notebook; the chart itself is asserted on its Vega root.
const DATA_CELL_OUTPUT = 'chart data ready';

// What each known failure mode renders into the output: VegaFusion's serialization error, the vega
// renderer's own message (shared by its `ErrorFallback` and its `renderOutputItem` catch), a traceback.
const FORBIDDEN_OUTPUT = [
    'Unsupported datatype for JSON serialization',
    'Error rendering chart',
    'Traceback (most recent call last)'
];

describe('Deepnote E2E — render a chart block', function () {
    this.timeout(SUITE_TIMEOUT);

    const environmentName = 'E2E Chart Env';

    let cleanupTempDir: (() => void) | undefined;

    before(async function () {
        const { cleanup, tempDir } = copyFixtureToTempDir(NOTEBOOK_FILE_NAME);
        cleanupTempDir = cleanup;

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        await openFolderViaDialog(tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        await openWorkspaceFile(NOTEBOOK_FILE_NAME);

        await VSBrowser.instance.driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((t) => t.includes(NOTEBOOK_FILE_NAME)),
            WORKBENCH_TIMEOUT,
            'Deepnote notebook editor did not open'
        );
    });

    after(async function () {
        await new WebView().switchBack().catch((error) => {
            console.warn('[deepnote-e2e] switch back from webview during cleanup:', error);
        });
        await new EditorView().closeAllEditors().catch((error) => {
            console.warn('[deepnote-e2e] close all editors during cleanup:', error);
        });

        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[deepnote-e2e] remove throwaway workspace dir during cleanup:', error);
        }
    });

    it('charts a dataframe with a UUID column without a serialization error', async function () {
        await createEnvironment(environmentName);
        await selectEnvironmentForNotebook(environmentName, NOTEBOOK_FILE_NAME);

        const renderedOutput = await runOnceAndAwaitOutput(
            NOTEBOOK_FILE_NAME,
            DATA_CELL_OUTPUT,
            FIRST_RUN_OUTPUT_TIMEOUT
        );

        // One assertion carrying the whole output: the default failure message truncates away the
        // traceback a raising chart block leaves here.
        const failureText = FORBIDDEN_OUTPUT.filter((forbidden) => renderedOutput.includes(forbidden));
        expect(
            failureText,
            `chart output contained failure text. Full output: ${JSON.stringify(renderedOutput)}`
        ).to.deep.equal([]);

        await awaitRenderedChart(FIRST_RUN_OUTPUT_TIMEOUT, 'chart block output');
    });
});
