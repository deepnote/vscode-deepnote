// Prepares the pre-baked toolkit venv the E2E suites adopt, and reports where it ended up.
// Exits explicitly so a handle left open by the pip subprocesses cannot hold the step open.

try {
    const { ensureManagedVenv, writeGeneratedSettings } = require('../out/e2e/helpers/venv');

    const venvPath = ensureManagedVenv();
    console.log(`[e2e-venv] ready: ${venvPath}`);

    const settingsPath = writeGeneratedSettings();
    console.log(`[e2e-venv] settings: ${settingsPath}`);
    process.exit(0);
} catch (error) {
    console.error('[e2e-venv] could not prepare the toolkit venv:', error);
    process.exit(1);
}
