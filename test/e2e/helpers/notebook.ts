import { By, EditorView, VSBrowser, WebView } from 'vscode-extension-tester';

import { OUTPUT_FRAME_SWITCH_TIMEOUT, OUTPUT_POLL_INTERVAL, OUTPUT_SELECTOR, WORKBENCH_TIMEOUT } from './constants';
import { dismissAllNotifications } from './notifications';

/**
 * Focuses the given notebook editor and clicks its toolbar "Run All" button. The command-palette
 * entry for `deepnote.runallcells` ("Jupyter: Run All Cells") is gated behind context keys
 * (`deepnote.ispythonornativeactive`, …) that are not reliably set under automation, so driving it
 * through `Workbench.executeCommand` can silently miss and trigger the wrong command.
 */
export async function clickRunAll(notebookFileName: string): Promise<void> {
    const driver = VSBrowser.instance.driver;

    await new EditorView().openEditor(notebookFileName);

    // Locate AND click inside the same wait loop. The notebook toolbar can re-render between finding
    // the button and clicking it (the editor re-focuses, kernel status / notifications change), which
    // would otherwise surface as a StaleElementReferenceError. Re-finding and clicking on the next
    // tick is still a SINGLE "Run All" — the run is only issued once the click actually lands, so
    // this does not re-run a notebook whose first execution was accepted.
    await driver.wait(
        async () => {
            try {
                const [button] = await driver.findElements(By.css('a.action-label[aria-label="Run All"]'));
                if (!button) {
                    return false;
                }

                await button.click();

                return true;
            } catch (error) {
                console.warn('[deepnote-e2e] locate/click notebook Run All (retrying):', error);

                return false;
            }
        },
        WORKBENCH_TIMEOUT,
        'notebook "Run All" button did not appear or could not be clicked'
    );
}

/**
 * Runs `read` inside the notebook webview (iframe.webview.ready -> #active-frame) and switches back
 * afterwards. `read` only ever sees the webview, never the cell source in the main document — the
 * guarantee callers rely on to avoid matching a cell's own text. Returns '' when the frame is absent,
 * went stale, or has painted nothing yet, so callers can poll.
 */
async function readInsideNotebookWebview(read: (webView: WebView) => Promise<string>): Promise<string> {
    const driver = VSBrowser.instance.driver;
    const webView = new WebView();
    const frame = await webView.getViewToSwitchTo().catch((error) => {
        console.warn('[deepnote-e2e] locate notebook webview:', error);

        return undefined;
    });
    if (!frame) {
        return '';
    }

    try {
        await webView.switchToFrame(OUTPUT_FRAME_SWITCH_TIMEOUT);

        // switchToFrame re-resolves the view and returns silently when it has gone, leaving the
        // driver on the workbench document — where a body read would scrape the editor, and the cell
        // source with it. Confirm we actually descended before letting `read` run.
        if (await driver.executeScript<boolean>('return window.self === window.top')) {
            return '';
        }

        return (await read(webView)).trim();
    } catch (error) {
        console.warn('[deepnote-e2e] read inside notebook webview:', error);

        return '';
    } finally {
        await webView.switchBack().catch((error) => {
            console.warn('[deepnote-e2e] switch back from notebook webview:', error);
        });
    }
}

/**
 * Reads everything the notebook webview currently paints — rendered markdown cells as well as cell
 * outputs. Use it when a rendered markdown cell is part of the assertion, since `readRenderedOutput`
 * deliberately narrows to output-only elements.
 */
export async function readNotebookWebviewText(): Promise<string> {
    return readInsideNotebookWebview(async (webView) => (await webView.findWebElement(By.css('body'))).getText());
}

/** Reads the notebook cell output once, falling back to the whole frame if the renderer used unexpected classes. */
export async function readRenderedOutput(): Promise<string> {
    return readInsideNotebookWebview(async (webView) => {
        const elements = await webView.findWebElements(By.css(OUTPUT_SELECTOR));
        const texts = await Promise.all(
            elements.map((element) =>
                element.getText().catch((error) => {
                    console.warn('[deepnote-e2e] read output element text:', error);

                    return '';
                })
            )
        );
        const text = texts.join('\n').trim();

        // Safe as a fallback because we have already confirmed we are inside the webview, not the editor.
        return text || (await webView.findWebElement(By.css('body'))).getText();
    });
}

/**
 * Issues a SINGLE "Run All" after the kernel has been selected and polls the notebook output webview
 * until the expected text renders. It deliberately does NOT re-issue "Run All" when output is
 * missing: the kernel is already bound before we get here (`selectEnvironmentForNotebook` waits for
 * the post-binding "switched successfully" toast), so a first run that renders nothing means the
 * execution request was dropped — exactly the kernel-binding regression this suite must catch.
 * Re-running until output eventually appeared would mask that bug.
 */
export async function runOnceAndAwaitOutput(
    notebookFileName: string,
    expected: string,
    timeout: number
): Promise<string> {
    const driver = VSBrowser.instance.driver;

    // Clear the "switched successfully" toast so it cannot intercept the single toolbar click.
    await dismissAllNotifications().catch((error) => {
        console.warn('[deepnote-e2e] dismiss notifications before Run All:', error);
    });

    await clickRunAll(notebookFileName);

    const deadline = Date.now() + timeout;
    let lastText = '';

    while (Date.now() < deadline) {
        lastText = await readRenderedOutput();
        if (lastText.includes(expected)) {
            return lastText;
        }

        await driver.sleep(OUTPUT_POLL_INTERVAL);
    }

    throw new Error(
        `Timed out after ${timeout}ms waiting for the first "Run All" to render output containing ` +
            `"${expected}". No re-run was issued, so a dropped first execution (kernel not bound to a ` +
            `NotebookEditor) surfaces here. Last observed output: ${JSON.stringify(lastText)}`
    );
}
