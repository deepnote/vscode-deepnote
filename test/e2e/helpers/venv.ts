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
 * The exact pip specs deepnoteToolkitInstaller installs, read out of the extension source.
 *
 * The installer itself cannot be reused: it is an injected class built on `workspace.fs`, `l10n` and
 * cancellation tokens, and it runs in the extension host — this runs in the Mocha process, where
 * `vscode` does not resolve. Reading its inputs is the next best thing, and it means a version bump
 * or a new package cannot leave the tests provisioning something production never has.
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
 * Whether the venv already satisfies every spec, checked against installed distribution metadata
 * rather than by importing anything.
 *
 * `import deepnote_toolkit` — what the extension itself uses — executes the whole package, which
 * takes seconds and emits a page of import warnings. This runs on every suite, so it reads
 * `importlib.metadata` instead: same guarantee that the right versions are present, in milliseconds
 * and silently.
 */
function isUsable(specs: string[]): boolean {
    if (!fs.existsSync(venvPython())) {
        return false;
    }

    // 'deepnote-toolkit[server]==2.1.1' -> ['deepnote-toolkit', '2.1.1']; extras do not affect the
    // distribution name, and a spec without `==` is satisfied by any version.
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
 * Guarantees a venv with the Deepnote toolkit installed, and returns its interpreter.
 *
 * Suites adopt this venv instead of letting the extension build one per environment:
 * `getVenvPathIfInVenv` makes the extension take over any interpreter that already lives in a venv,
 * and `ensureVenvAndToolkit` returns early once the toolkit imports, so the whole pip install is
 * skipped.
 *
 * Cheap when it already exists — one metadata lookup — so suites can call it unconditionally and CI
 * can restore it from a cache and pay only that check. A venv that does not satisfy every spec is
 * discarded and rebuilt, which also covers a restored cache whose base interpreter has moved and a
 * package added to the extension's install list.
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

    // Mirrors deepnoteToolkitInstaller.installVenvAndToolkit, so the venv satisfies the same checks
    // the extension would have made after building it itself.
    execFileSync(venvPython(), ['-m', 'pip', 'install', '--upgrade', 'pip'], { stdio: 'inherit' });
    execFileSync(venvPython(), ['-m', 'pip', 'install', '--upgrade', ...specs], { stdio: 'inherit' });

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
