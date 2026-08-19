// Bakes the Python venv the E2E suite adopts instead of letting the extension build one per test
// run. `deepnoteEnvironmentManager.createEnvironment` adopts any interpreter that already lives in a
// venv (`getVenvPathIfInVenv`), and `ensureVenvAndToolkit` returns early once `import
// deepnote_toolkit` succeeds — so a pre-installed venv skips venv creation and the whole pip install.
//
// Also emits the settings file ExTester feeds VS Code, because the interpreter must be named by
// absolute path and that path is only known at run time.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
// Matches the `**/.venv*/` rule already in .gitignore.
const venvDir = path.join(repoRoot, '.venv-e2e');
const baseSettingsPath = path.join(repoRoot, 'test', 'e2e', 'settings.json');
const generatedSettingsPath = path.join(repoRoot, 'test', 'e2e', 'settings.generated.json');

/** Reads DEEPNOTE_TOOLKIT_VERSION from source so this script cannot drift from the extension. */
function toolkitVersion() {
    const types = fs.readFileSync(path.join(repoRoot, 'src', 'kernels', 'deepnote', 'types.ts'), 'utf8');
    const match = types.match(/DEEPNOTE_TOOLKIT_VERSION\s*=\s*'([^']+)'/);
    if (!match) {
        throw new Error('Could not read DEEPNOTE_TOOLKIT_VERSION from src/kernels/deepnote/types.ts');
    }

    return match[1];
}

function venvPython() {
    return process.platform === 'win32'
        ? path.join(venvDir, 'Scripts', 'python.exe')
        : path.join(venvDir, 'bin', 'python');
}

function run(command, args) {
    execFileSync(command, args, { stdio: 'inherit' });
}

/** True when the venv exists and already imports the toolkit — the same check the extension makes. */
function toolkitAlreadyInstalled() {
    if (!fs.existsSync(venvPython())) {
        return false;
    }
    try {
        execFileSync(venvPython(), ['-c', 'import deepnote_toolkit'], { stdio: 'ignore' });

        return true;
    } catch {
        return false;
    }
}

function bakeVenv() {
    if (toolkitAlreadyInstalled()) {
        console.log(`[e2e-venv] reusing ${venvDir}`);

        return;
    }

    // A half-built venv (interrupted run, partial cache) would make pip fail confusingly.
    if (fs.existsSync(venvDir)) {
        console.log(`[e2e-venv] discarding incomplete venv at ${venvDir}`);
        fs.rmSync(venvDir, { recursive: true, force: true });
    }

    console.log(`[e2e-venv] creating ${venvDir}`);
    run(process.env.PYTHON ?? 'python3', ['-m', 'venv', venvDir]);

    // Mirrors deepnoteToolkitInstaller.installVenvAndToolkit so the baked venv satisfies the same
    // checks the extension would have made after building it itself.
    run(venvPython(), ['-m', 'pip', 'install', '--upgrade', 'pip']);
    run(venvPython(), [
        '-m',
        'pip',
        'install',
        '--upgrade',
        `deepnote-toolkit[server]==${toolkitVersion()}`,
        'ipykernel',
        'python-lsp-server[all]',
        'deepnote-cli'
    ]);
}

function writeSettings() {
    const settings = JSON.parse(fs.readFileSync(baseSettingsPath, 'utf8'));

    // venvPath makes the Python extension discover the baked venv so it reaches the interpreter
    // quick pick; defaultInterpreterPath makes it the pick the suite lands on by default.
    settings['python.venvPath'] = repoRoot;
    settings['python.defaultInterpreterPath'] = venvPython();

    fs.writeFileSync(generatedSettingsPath, `${JSON.stringify(settings, null, 4)}\n`);
    console.log(`[e2e-venv] wrote ${path.relative(repoRoot, generatedSettingsPath)}`);
}

bakeVenv();
writeSettings();
