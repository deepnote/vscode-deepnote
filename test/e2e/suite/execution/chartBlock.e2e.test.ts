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

// stdout from the first cell, which only establishes that the kernel ran the notebook. The chart is
// asserted through its rendered Vega root instead: the field names appear in the visualization
// block's own JSON source and in any traceback quoting them, so no text match can tell a drawn chart
// apart from a failed one.
const DATA_CELL_OUTPUT = 'chart data ready';

// A chart block that fails renders its error into the output: the VegaFusion serialization failure,
// the vega renderer's own two failure strings (`ErrorFallback` and the `renderOutputItem` catch),
// and a Python traceback.
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

        for (const forbidden of FORBIDDEN_OUTPUT) {
            expect(renderedOutput).to.not.contain(forbidden);
        }

        await awaitRenderedChart(FIRST_RUN_OUTPUT_TIMEOUT, 'chart block output');
    });
});
