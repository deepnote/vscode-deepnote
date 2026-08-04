// Mocha configuration for the ExTester (vscode-extension-tester) E2E suite.
// UI tests are slow: the 2s Mocha default is unusable. Individual waits inside the
// tests are the real guard rails; this is a generous suite-level safety net.
const path = require('path');

// Loaded here rather than declared via mocha's `require` option, which only the mocha CLI acts on:
// ExTester hands this config straight to `new Mocha(config)` (vscode-extension-tester
// suite/runner.js), and the constructor reads `rootHooks` — already-resolved hook objects — while
// ignoring `require` entirely. Declared the other way the file is never loaded and the hooks below
// silently never run.
//
// Requires compiled output, so compile-e2e must run first; a missing build now fails here rather
// than passing with the hooks quietly absent.
const { mochaHooks } = require(path.resolve(__dirname, '..', '..', 'out', 'e2e', 'rootHooks.js'));

module.exports = {
    timeout: 1500000, // 25 min — env creation + first kernel start (venv + toolkit) can be slow
    retries: 1, // absorb transient UI flakiness with a single retry
    reporter: 'spec',
    color: true,
    // Dismiss notification toasts between tests so they don't accumulate across the one shared
    // VS Code instance.
    rootHooks: mochaHooks
};
