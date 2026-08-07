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
 * Clicks the notebook cell status bar item whose text contains `label`. Cell chrome lives in the
 * main window DOM (not the output iframe), so this switches out of the webview first and matches on
 * `textContent` — Selenium's `getText()` is empty for items scrolled out of view.
 */
export async function clickCellStatusBarItem(label: string): Promise<void> {
    const driver = VSBrowser.instance.driver;

    await new WebView().switchBack().catch((error) => {
        console.warn('[deepnote-e2e] switch back before clicking a cell status bar item:', error);
    });

    // Locate AND click in the same wait loop: the status bar re-renders as cells execute, which
    // would otherwise surface as a StaleElementReferenceError between finding and clicking.
    await driver.wait(
        async () => {
            try {
                for (const item of await driver.findElements(By.css('.cell-statusbar-container .cell-status-item'))) {
                    const text = (await item.getAttribute('textContent')) ?? '';
                    if (!text.includes(label)) {
                        continue;
                    }

                    await driver.executeScript('arguments[0].scrollIntoView({block: "center"})', item);
                    await item.click();

                    return true;
                }

                return false;
            } catch (error) {
                console.warn('[deepnote-e2e] locate/click cell status bar item (retrying):', error);

                return false;
            }
        },
        WORKBENCH_TIMEOUT,
        `notebook cell status bar item "${label}" did not appear or could not be clicked`
    );
}

/** Run `read` in the notebook output webview; '' if the frame is missing. */
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

/** Notebook webview body (markdown previews and outputs). */
export async function readNotebookWebviewText(): Promise<string> {
    return readInsideNotebookWebview(async (webView) => (await webView.findWebElement(By.css('body'))).getText());
}

/** Cell output once; falls back to frame body if output selectors miss. */
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
