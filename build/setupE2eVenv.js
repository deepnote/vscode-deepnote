// Prepares the pre-baked toolkit venv the E2E suites adopt, and reports where it ended up.
// Exits explicitly so a handle left open by the pip subprocesses cannot hold the step open.

try {
    const { ensureManagedVenv } = require('../out/e2e/helpers/venv');

    console.log(`[e2e-venv] ready: ${ensureManagedVenv()}`);
    process.exit(0);
} catch (error) {
    console.error('[e2e-venv] could not prepare the toolkit venv:', error);
    process.exit(1);
}
