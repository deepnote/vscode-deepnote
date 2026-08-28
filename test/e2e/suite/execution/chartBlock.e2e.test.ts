/**
 * End-to-end UI test driven by ExTester (vscode-extension-tester).
 *
 * Covers the chart-block path, which reaches deepnote-toolkit code no other suite touches: a
 * `visualization` block executes as `_dntk.DeepnoteChart(...)` and comes back as
 * `application/vnd.vega.v5+json`, rendered by the extension's own `deepnote-vega-renderer`.
 *
 * The dataframe deliberately carries a `uuid.UUID` column. From pyarrow 24 the pandas -> Arrow
 * conversion infers the `arrow.uuid` extension type (FixedSizeBinary(16)), which VegaFusion cannot
 * serialize to JSON; the toolkit stringifies such columns before charting. The extension installs
 * the toolkit with an unbounded `pyarrow>=23.0.1` on Python 3.12+ — the version E2E CI runs — so a
 * pyarrow or toolkit change that silently reintroduced that failure would land here and nowhere else.
 *
 * Prerequisites are the same as `helloWorld.e2e.test.ts`.
 */

import { expect } from 'chai';
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
} from '../../helpers';

const NOTEBOOK_FILE_NAME = 'chart-uuid.deepnote';

// The chart renders as SVG, so its axis titles and tick labels are readable text. Waiting on the x
// axis title means the wait ends only once VegaFusion produced a spec and the renderer drew it.
const CHART_X_AXIS_TITLE = 'trace_id';
const CHART_Y_AXIS_TITLE = 'amount';

// A tick label from the UUID column. Its presence is the actual regression signal: the values only
// reach the axis as text if the toolkit stringified them before Arrow inferred `arrow.uuid`. The
// renderer truncates long labels, so match a prefix rather than a whole UUID.
const CHART_UUID_TICK_LABEL = '00000000-0000';

// Must not appear in the output. The first is the VegaFusion serialization failure the toolkit's UUID
// sanitization exists to prevent; the rest are the vega renderer's own failure strings (`ErrorFallback`
// and the `renderOutputItem` catch) and a Python traceback from the chart block itself.
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
            CHART_X_AXIS_TITLE,
            FIRST_RUN_OUTPUT_TIMEOUT
        );

        expect(renderedOutput).to.contain(CHART_Y_AXIS_TITLE);
        expect(renderedOutput).to.contain(CHART_UUID_TICK_LABEL);

        for (const forbidden of FORBIDDEN_OUTPUT) {
            expect(renderedOutput).to.not.contain(forbidden);
        }
    });
});
