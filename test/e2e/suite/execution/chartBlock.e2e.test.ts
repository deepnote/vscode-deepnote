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
    copyFixtureToTempDir,
    createEnvironment,
    openFolderViaDialog,
    openWorkspaceFile,
    runOnceAndAwaitOutput,
    selectEnvironmentForNotebook
} from '../../helpers';

const NOTEBOOK_FILE_NAME = 'chart-uuid.deepnote';

// Vega draws SVG, so axis titles and tick labels are readable text. The x axis title appears only
// once VegaFusion has produced a spec and the renderer has drawn it, which is what makes it a usable
// wait marker.
const CHART_X_AXIS_TITLE = 'trace_id';
const CHART_Y_AXIS_TITLE = 'amount';

// UUID values only reach the axis as text if the toolkit stringified them. Axis labels are truncated,
// so match a prefix rather than a whole UUID.
const CHART_UUID_TICK_LABEL = '00000000-0000';

// The VegaFusion serialization failure, the vega renderer's own two failure strings (`ErrorFallback`
// and the `renderOutputItem` catch), and a traceback from the chart block itself.
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
