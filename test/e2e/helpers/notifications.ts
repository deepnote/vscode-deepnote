import { Notification, VSBrowser, Workbench } from 'vscode-extension-tester';

import { catchAndLog, logCaughtError } from './logging';

/** Dismisses every currently-visible toast notification (best effort). */
export async function dismissAllNotifications(): Promise<void> {
    const notifications = await new Workbench()
        .getNotifications()
        .catch(catchAndLog('get notifications', [] as Notification[]));
    for (const notification of notifications) {
        await notification.dismiss().catch(catchAndLog('dismiss notification', undefined));
    }
}

/**
 * Waits for a toast notification whose message matches `pattern`. When `required` is false a missed
 * (or auto-dismissed) notification resolves to `undefined` instead of throwing — useful for
 * transient success toasts where the authoritative gate is elsewhere.
 */
export async function waitForNotification(
    pattern: RegExp,
    timeout: number,
    required: boolean
): Promise<Notification | undefined> {
    const driver = VSBrowser.instance.driver;

    try {
        return (await driver.wait(
            async () => {
                const notifications = await new Workbench()
                    .getNotifications()
                    .catch(catchAndLog('get notifications', [] as Notification[]));
                for (const notification of notifications) {
                    const message = await notification.getMessage().catch(catchAndLog('read notification message', ''));
                    if (pattern.test(message)) {
                        return notification;
                    }
                }

                return undefined;
            },
            timeout,
            `timed out waiting for a notification matching ${pattern}`
        )) as Notification;
    } catch (error) {
        if (required) {
            throw error;
        }

        logCaughtError(`wait for optional notification matching ${pattern}`, error);

        return undefined;
    }
}
