import { StatusBar, VSBrowser } from 'vscode-extension-tester';

export const STATUS_BAR_READ_TIMEOUT = 10_000;
export const STATUS_BAR_POLL_INTERVAL = 500;

/** Reads the concatenated text of all status-bar items, polling until it shows `expected`. */
export async function readStatusBarText(
    expected: string,
    timeout: number = STATUS_BAR_READ_TIMEOUT,
    pollInterval: number = STATUS_BAR_POLL_INTERVAL
): Promise<string> {
    const driver = VSBrowser.instance.driver;
    const deadline = Date.now() + timeout;
    let joined = '';

    while (Date.now() < deadline) {
        const items = await new StatusBar().getItems().catch(() => [] as never[]);
        const texts = await Promise.all(items.map((item) => item.getText().catch(() => '')));
        joined = texts.join(' | ');

        if (joined.includes(expected)) {
            return joined;
        }

        await driver.sleep(pollInterval);
    }

    return joined;
}
