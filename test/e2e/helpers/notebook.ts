import { By, EditorView, VSBrowser, WebView } from 'vscode-extension-tester';

import { OUTPUT_FRAME_SWITCH_TIMEOUT, OUTPUT_POLL_INTERVAL, OUTPUT_SELECTOR, WORKBENCH_TIMEOUT } from './constants';
import { dismissAllNotifications } from './notifications';

/**
 * Focuses the given notebook editor and clicks the toolbar button carrying `ariaLabel`. The
 * command-palette entries for these actions are gated behind context keys
 * (`deepnote.ispythonornativeactive`, …) that are not reliably set under automation, so driving them
 * through `Workbench.executeCommand` can silently miss and trigger the wrong command.
 */
async function clickNotebookToolbarButton(notebookFileName: string, ariaLabel: string): Promise<void> {
    const driver = VSBrowser.instance.driver;

    await new EditorView().openEditor(notebookFileName);

    // Locate AND click inside the same wait loop. The notebook toolbar can re-render between finding
    // the button and clicking it (the editor re-focuses, kernel status / notifications change), which
    // would otherwise surface as a StaleElementReferenceError. Re-finding and clicking on the next
    // tick still issues the action only ONCE — it is only issued when the click actually lands.
    await driver.wait(
        async () => {
            try {
                const [button] = await driver.findElements(By.css(`a.action-label[aria-label="${ariaLabel}"]`));
                if (!button) {
                    return false;
                }

                await button.click();

                return true;
            } catch (error) {
                console.warn(`[deepnote-e2e] locate/click notebook "${ariaLabel}" (retrying):`, error);

                return false;
            }
        },
        WORKBENCH_TIMEOUT,
        `notebook "${ariaLabel}" button did not appear or could not be clicked`
    );
}

export async function clickRunAll(notebookFileName: string): Promise<void> {
    return clickNotebookToolbarButton(notebookFileName, 'Run All');
}

/**
 * Clicks the toolbar's "Interrupt" button — VS Code's `notebook.interruptExecution`, shown while
 * `notebookHasSomethingRunning && notebookInterruptibleKernel`.
 *
 * It is the only toolbar action that reaches the controller's `interruptHandler`, and therefore the
 * only one that signals a running agent to stop. "Stop Execution" (`notebook.cancelExecution`,
 * which VS Code shows in its place for a kernel that declares no interrupt handler) cancels the
 * cells without ever telling the agent, so it must not stand in as a fallback here.
 */
export async function clickInterrupt(notebookFileName: string): Promise<void> {
    return clickNotebookToolbarButton(notebookFileName, 'Interrupt');
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
 * Polls the notebook webview until every marker in `markers` is rendered and none of `absentMarkers`
 * is, then returns the text it settled on. `context` names the state being waited for; it is only
 * used to make the timeout message say what did not happen.
 */
export async function awaitWebviewMarkers(
    markers: string[],
    timeout: number,
    context: string,
    absentMarkers: string[] = []
): Promise<string> {
    const driver = VSBrowser.instance.driver;
    const deadline = Date.now() + timeout;
    let text = '';

    while (Date.now() < deadline) {
        text = await readNotebookWebviewText();
        const missing = markers.filter((marker) => !text.includes(marker));
        const lingering = absentMarkers.filter((marker) => text.includes(marker));
        if (missing.length === 0 && lingering.length === 0) {
            return text;
        }

        await driver.sleep(OUTPUT_POLL_INTERVAL);
    }

    const missing = markers.filter((marker) => !text.includes(marker));
    const lingering = absentMarkers.filter((marker) => text.includes(marker));
    throw new Error(
        `Timed out after ${timeout}ms waiting for notebook webview (${context}). Missing: ${JSON.stringify(
            missing
        )}. ` + `Lingering: ${JSON.stringify(lingering)}. Last text: ${JSON.stringify(text)}`
    );
}

/**
 * Fails if any of `markers` renders in the notebook webview during the next `windowMs`. `requiredMarker`
 * must render on at least one poll — otherwise a webview that stays unreadable the whole window
 * (`readNotebookWebviewText` reads a missing, top-level, or unreadable frame as '') would find no
 * forbidden marker on every poll and pass without having checked anything.
 *
 * Non-occurrence needs a window rather than one read: the regressions this guards render the
 * forbidden text a beat *after* the state the test waited for — a batch that should have stopped
 * carries on into the agent's round trip to the local mock and then the trailing cell. Size the
 * window well above that round trip, since the whole window is spent on every passing run.
 */
export async function assertMarkersStayAbsent(
    markers: string[],
    windowMs: number,
    context: string,
    requiredMarker: string
): Promise<void> {
    const driver = VSBrowser.instance.driver;
    const deadline = Date.now() + windowMs;
    let sawRequiredMarker = false;

    while (Date.now() < deadline) {
        const text = await readNotebookWebviewText();
        const rendered = markers.filter((marker) => text.includes(marker));

        if (rendered.length > 0) {
            throw new Error(
                `Notebook webview rendered ${JSON.stringify(rendered)}, which must not appear (${context}). ` +
                    `Full text: ${JSON.stringify(text)}`
            );
        }

        sawRequiredMarker ||= text.includes(requiredMarker);

        await driver.sleep(OUTPUT_POLL_INTERVAL);
    }

    if (!sawRequiredMarker) {
        throw new Error(
            `Notebook webview never rendered required marker ${JSON.stringify(requiredMarker)} while confirming ` +
                `${JSON.stringify(markers)} stayed absent (${context}) — the webview may have been unreadable for ` +
                `the whole window, which would otherwise let this pass without checking anything.`
        );
    }
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
