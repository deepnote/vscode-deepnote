import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { PREBAKED_VENV_DIR_NAME } from './constants';

const REPO_ROOT = process.cwd();
const VENV_DIR = path.join(REPO_ROOT, PREBAKED_VENV_DIR_NAME);
const TOOLKIT_VERSION_SOURCE = path.join(REPO_ROOT, 'src', 'kernels', 'deepnote', 'types.ts');

function venvPython(): string {
    return process.platform === 'win32'
        ? path.join(VENV_DIR, 'Scripts', 'python.exe')
        : path.join(VENV_DIR, 'bin', 'python');
}

/** Reads DEEPNOTE_TOOLKIT_VERSION from source so this cannot drift from what the extension installs. */
function toolkitVersion(): string {
    const match = fs.readFileSync(TOOLKIT_VERSION_SOURCE, 'utf8').match(/DEEPNOTE_TOOLKIT_VERSION\s*=\s*'([^']+)'/);
    if (!match) {
        throw new Error(`Could not read DEEPNOTE_TOOLKIT_VERSION from ${TOOLKIT_VERSION_SOURCE}`);
    }

    return match[1];
}

/** The same check the extension makes: can this interpreter import the toolkit? */
function isUsable(): boolean {
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

/**
 * Guarantees a venv with the Deepnote toolkit installed, and returns its interpreter.
 *
 * Suites adopt this venv instead of letting the extension build one per environment:
 * `getVenvPathIfInVenv` makes the extension take over any interpreter that already lives in a venv,
 * and `ensureVenvAndToolkit` returns early once the toolkit imports, so the whole pip install is
 * skipped.
 *
 * Cheap when it already exists — one `import deepnote_toolkit` — so suites can call it
 * unconditionally and CI can restore it from a cache and pay only that check. A venv that cannot
 * import the toolkit is discarded and rebuilt, which also covers a restored cache whose base
 * interpreter has moved.
 */
export function ensureManagedVenv(): string {
    if (isUsable()) {
        return venvPython();
    }

    if (fs.existsSync(VENV_DIR)) {
        console.log(`[e2e-venv] discarding unusable venv at ${VENV_DIR}`);
        fs.rmSync(VENV_DIR, { recursive: true, force: true });
    }

    console.log(`[e2e-venv] creating ${VENV_DIR} — this only happens once`);
    execFileSync(process.env.PYTHON ?? 'python3', ['-m', 'venv', VENV_DIR], { stdio: 'inherit' });

    // Mirrors deepnoteToolkitInstaller.installVenvAndToolkit, so the venv satisfies the same checks
    // the extension would have made after building it itself.
    execFileSync(venvPython(), ['-m', 'pip', 'install', '--upgrade', 'pip'], { stdio: 'inherit' });
    execFileSync(
        venvPython(),
        [
            '-m',
            'pip',
            'install',
            '--upgrade',
            `deepnote-toolkit[server]==${toolkitVersion()}`,
            'ipykernel',
            'python-lsp-server[all]',
            'deepnote-cli'
        ],
        { stdio: 'inherit' }
    );

    return venvPython();
}

/**
 * Links the managed venv into a workspace folder as `.venv`, which is where the Python extension
 * looks without any configuration. Doing it this way rather than pointing settings at an absolute
 * path keeps the venv cacheable at a fixed location while the workspace stays a throwaway directory.
 */
export function linkManagedVenvInto(workspaceFolder: string): void {
    const target = path.join(workspaceFolder, '.venv');
    if (fs.existsSync(target)) {
        return;
    }

    fs.symlinkSync(ensureManagedVenv().replace(/[/\\]bin[/\\]python$/, ''), target, 'dir');
}
