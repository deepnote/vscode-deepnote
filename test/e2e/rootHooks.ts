import { dismissAllNotifications } from './helpers/notifications';

// Mocha root hooks (wired via .mocharc.js `require`). ExTester runs every spec in ONE shared VS Code
// instance; dismiss notification toasts between tests so they don't pile up and slow/overlap later specs.
//
// Only `afterEach` lives here. ExTester's runner does not fire `mochaHooks.beforeAll` — a root
// beforeAll returns before the first suite starts without ever executing — so anything that must run
// once before the suites has to arrange that itself. The shared fixtures workspace does exactly that:
// openFolderViaDialog opens it on the first request and no-ops afterwards.
export const mochaHooks = {
    async afterEach(): Promise<void> {
        await dismissAllNotifications().catch(() => undefined);
    }
};
