import { By, EditorView, VSBrowser, WebView } from 'vscode-extension-tester';

import { OUTPUT_POLL_INTERVAL, OUTPUT_SELECTOR, RUN_ALL_REISSUE_INTERVAL, WORKBENCH_TIMEOUT } from './constants';

/**
 * Focuses the given notebook editor and clicks its toolbar "Run All" button. The command-palette
 * entry for `deepnote.runallcells` ("Jupyter: Run All Cells") is gated behind context keys
 * (`deepnote.ispythonornativeactive`, …) that are not reliably set under automation, so driving it
 * through `Workbench.executeCommand` can silently miss and trigger the wrong command.
 */
export async function clickRunAll(notebookFileName: string): Promise<void> {
    const driver = VSBrowser.instance.driver;

    await new EditorView().openEditor(notebookFileName);

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
 * Reads the notebook cell output once.
 *
 * Output lives two iframes deep (iframe.webview.ready -> #active-frame). We only attempt to switch
 * when an output webview iframe actually exists (`getViewToSwitchTo`), and we read output-specific
 * elements inside the frame — so we never match the cell's source code that is visible in the editor
 * of the main document. Returns '' when no output is present yet.
 */
export async function readRenderedOutput(): Promise<string> {
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

        // Fallback: if the renderer used unexpected classes, read the frame body — safe here because
        // we have confirmed we are inside the output iframe, not the editor.
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

/**
 * Clicks "Run All" and polls the notebook output webview until the expected text renders, re-issuing
 * "Run All" periodically. The first run can be dropped when the kernel has only just finished
 * connecting, so we keep nudging it until output appears (re-running `print(...)` is harmless).
 */
export async function runAndAwaitOutput(notebookFileName: string, expected: string, timeout: number): Promise<string> {
    const driver = VSBrowser.instance.driver;
    const deadline = Date.now() + timeout;
    let lastRunAt = 0;
    let lastText = '';

    while (Date.now() < deadline) {
        if (Date.now() - lastRunAt > RUN_ALL_REISSUE_INTERVAL) {
            await clickRunAll(notebookFileName).catch(() => undefined);
            lastRunAt = Date.now();
        }

        lastText = await readRenderedOutput();
        if (lastText.includes(expected)) {
            return lastText;
        }

        await driver.sleep(OUTPUT_POLL_INTERVAL);
    }

    throw new Error(
        `Timed out after ${timeout}ms waiting for rendered output to contain "${expected}". ` +
            `Last observed output: ${JSON.stringify(lastText)}`
    );
}
