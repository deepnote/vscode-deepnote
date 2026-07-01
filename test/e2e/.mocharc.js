// Mocha configuration for the ExTester (vscode-extension-tester) E2E suite.
// UI tests are slow: the 2s Mocha default is unusable. Individual waits inside the
// tests are the real guard rails; this is a generous suite-level safety net.
module.exports = {
    timeout: 1500000, // 25 min — env creation + first kernel start (venv + toolkit) can be slow
    retries: 1, // absorb transient UI flakiness with a single retry
    reporter: 'spec',
    color: true
};
