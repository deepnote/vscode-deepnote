import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { PREBAKED_VENV_DIR_NAME } from './constants';

const REPO_ROOT = process.cwd();
const VENV_DIR = path.join(REPO_ROOT, PREBAKED_VENV_DIR_NAME);
const TOOLKIT_SPEC_SOURCE = path.join(REPO_ROOT, 'src', 'kernels', 'deepnote', 'types.ts');

function venvPython(): string {
    return process.platform === 'win32'
        ? path.join(VENV_DIR, 'Scripts', 'python.exe')
        : path.join(VENV_DIR, 'bin', 'python');
}

/**
 * The pip specs deepnoteToolkitInstaller installs, read from source so they cannot drift. The
 * installer itself needs `vscode`, which does not resolve in the Mocha process.
 */
function toolkitPipSpecs(): string[] {
    const source = fs.readFileSync(TOOLKIT_SPEC_SOURCE, 'utf8');

    const version = source.match(/DEEPNOTE_TOOLKIT_VERSION\s*=\s*'([^']+)'/)?.[1];
    // Terminated on `];` rather than the first `]`, which sits inside 'python-lsp-server[all]'.
    const packages = source.match(/DEEPNOTE_TOOLKIT_PACKAGES\s*=\s*\[([\s\S]*?)\];/)?.[1];
    if (!version || packages === undefined) {
        throw new Error(`Could not read the toolkit install spec from ${TOOLKIT_SPEC_SOURCE}`);
    }

    return [
        `deepnote-toolkit[server]==${version}`,
        ...[...packages.matchAll(/'([^']+)'/g)].map((match) => match[1])
    ];
}

/**
 * Whether the venv satisfies every spec. Checked via distribution metadata rather than
 * `import deepnote_toolkit`, which costs seconds and floods the log on every suite.
 */
function isUsable(specs: string[]): boolean {
    if (!fs.existsSync(venvPython())) {
        return false;
    }

    // 'deepnote-toolkit[server]==2.1.1' -> name 'deepnote-toolkit', version '2.1.1'.
    const required = specs.map((spec) => {
        const [name, version] = spec.split('==');

        return { name: name.replace(/\[.*\]$/, ''), version };
    });

    const check = required
        .map(({ name, version }) =>
            version ? `assert v('${name}') == '${version}'` : `assert v('${name}')`
        )
        .join('; ');

    try {
        execFileSync(venvPython(), ['-c', `from importlib.metadata import version as v; ${check}`], {
            stdio: 'ignore'
        });

        return true;
    } catch {
        return false;
    }
}

/**
 * Guarantees a venv with the toolkit installed and returns its interpreter. The extension adopts it
 * rather than provisioning its own, and a venv failing any spec is discarded and rebuilt.
 */
export function ensureManagedVenv(): string {
    const specs = toolkitPipSpecs();

    if (isUsable(specs)) {
        return venvPython();
    }

    if (fs.existsSync(VENV_DIR)) {
        console.log(`[e2e-venv] discarding unusable venv at ${VENV_DIR}`);
        fs.rmSync(VENV_DIR, { recursive: true, force: true });
    }

    console.log(`[e2e-venv] creating ${VENV_DIR} — this only happens once`);
    execFileSync(process.env.PYTHON ?? 'python3', ['-m', 'venv', VENV_DIR], { stdio: 'inherit' });

    // Mirrors deepnoteToolkitInstaller.installVenvAndToolkit.
    execFileSync(venvPython(), ['-m', 'pip', 'install', '--upgrade', 'pip'], { stdio: 'inherit' });
    execFileSync(venvPython(), ['-m', 'pip', 'install', '--upgrade', ...specs], { stdio: 'inherit' });

    return venvPython();
}

/**
 * Points a workspace at the venv through `python.venvPath`, which makes the Python extension offer
 * it by its real path.
 *
 * Deliberately not a `.venv` symlink inside the workspace: the extension names the kernel spec after
 * the venv directory and writes it INTO the venv, keeping the first one it finds
 * (deepnoteToolkitInstaller.installKernelSpec). Every workspace reaching one shared venv through its
 * own `.venv` link therefore inherits the absolute interpreter path of whichever workspace got there
 * first — a path that is deleted the moment that suite cleans up.
 */
export function pointWorkspaceAtManagedVenv(workspaceFolder: string): void {
    const settingsDir = path.join(workspaceFolder, '.vscode');
    fs.mkdirSync(settingsDir, { recursive: true });

    ensureManagedVenv();
    fs.writeFileSync(
        path.join(settingsDir, 'settings.json'),
        `${JSON.stringify({ 'python.venvPath': REPO_ROOT }, undefined, 4)}\n`,
        'utf8'
    );
}
