import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import toolkitSpec from '../../../src/platform/common/toolkitSpec.json';
import { PREBAKED_VENV_DIR_NAME } from './constants';

const REPO_ROOT = process.cwd();

/**
 * `set_notebook_path` drops every `sys.path` entry under the toolkit's notebook root (`$HOME/work`
 * unconfigured), so the venv has to sit outside it. The basename identifies the venv in the
 * interpreter quick pick, so it stays PREBAKED_VENV_DIR_NAME.
 */
const VENV_DIR = process.env.DEEPNOTE_E2E_VENV_DIR
    ? path.resolve(process.env.DEEPNOTE_E2E_VENV_DIR)
    : path.join(REPO_ROOT, PREBAKED_VENV_DIR_NAME);
const SETTINGS_SOURCE = path.join(REPO_ROOT, 'test', 'e2e', 'settings.json');
const SETTINGS_TARGET = path.join(REPO_ROOT, 'test', 'e2e', 'settings.generated.json');

/** The interpreter inside the pre-baked venv. Suites run against it as the active interpreter. */
function venvPython(): string {
    return process.platform === 'win32'
        ? path.join(VENV_DIR, 'Scripts', 'python.exe')
        : path.join(VENV_DIR, 'bin', 'python');
}

/** The pip specs deepnoteToolkitInstaller installs, off the spec file both sides share. */
function toolkitPipSpecs(): string[] {
    return [
        `deepnote-toolkit[server]==${toolkitSpec.version satisfies string}`,
        ...(toolkitSpec.packages satisfies string[])
    ];
}

/**
 * Whether the venv already has the toolkit version we want. Read from distribution metadata rather
 * than `import deepnote_toolkit`, which costs seconds and floods the log. The version arrives as
 * argv, and a mismatch exits non-zero on its own — `assert` would be stripped under PYTHONOPTIMIZE.
 *
 * Deliberate: metadata only, so a venv whose files were lost but whose metadata survived still reads
 * as usable; file integrity rides on the CI cache key hashing the build recipe.
 */
function isUsable(): boolean {
    if (!fs.existsSync(venvPython())) {
        return false;
    }

    try {
        execFileSync(
            venvPython(),
            [
                '-c',
                'import sys; from importlib.metadata import version; sys.exit(version("deepnote-toolkit") != sys.argv[1])',
                toolkitSpec.version
            ],
            { stdio: 'ignore' }
        );

        return true;
    } catch {
        return false;
    }
}

/**
 * Drops `deepnote-*` kernel specs inside the venv that launch some other interpreter.
 *
 * installKernelSpec names the spec after the venv directory and writes it INTO the venv, then keeps
 * the first one it finds. The venv outlives a run — it is cached in CI — so a spec left by an older
 * harness that reached it through a per-workspace `.venv` link still names a temp directory that is
 * long gone, sorts ahead of `deepnote-venv-e2e`, and wins. The kernel then fails to start on a path
 * that no longer exists.
 */
function pruneForeignKernelSpecs(): void {
    const kernelsDir = path.join(VENV_DIR, 'share', 'jupyter', 'kernels');
    if (!fs.existsSync(kernelsDir)) {
        return;
    }

    for (const entry of fs.readdirSync(kernelsDir)) {
        // Only the extension's own specs: `python3` is ipykernel's, and launches a relative `python`.
        if (!entry.startsWith('deepnote-')) {
            continue;
        }

        const specDir = path.join(kernelsDir, entry);
        const specFile = path.join(specDir, 'kernel.json');
        if (!fs.existsSync(specFile)) {
            continue;
        }

        let interpreter: unknown;
        try {
            interpreter = (JSON.parse(fs.readFileSync(specFile, 'utf8')) as { argv?: unknown[] }).argv?.[0];
        } catch {
            interpreter = undefined;
        }

        if (interpreter !== venvPython()) {
            console.log(`[e2e-venv] dropping kernel spec ${entry}, which launches ${String(interpreter)}`);
            fs.rmSync(specDir, { recursive: true, force: true });
        }
    }
}

/**
 * Guarantees a venv with the toolkit installed and returns its interpreter. The extension adopts it
 * rather than provisioning its own, and a venv on the wrong toolkit version is discarded and rebuilt.
 */
export function ensureManagedVenv(): string {
    if (!isUsable()) {
        if (fs.existsSync(VENV_DIR)) {
            console.log(`[e2e-venv] discarding unusable venv at ${VENV_DIR}`);
            fs.rmSync(VENV_DIR, { recursive: true, force: true });
        }

        console.log(`[e2e-venv] creating ${VENV_DIR} — this only happens once`);
        execFileSync(
            process.env.PYTHON ?? (process.platform === 'win32' ? 'py' : 'python3'),
            ['-m', 'venv', VENV_DIR],
            { stdio: 'inherit' }
        );

        // Mirrors deepnoteToolkitInstaller.installVenvAndToolkit.
        execFileSync(venvPython(), ['-m', 'pip', 'install', '--upgrade', 'pip'], { stdio: 'inherit' });
        execFileSync(venvPython(), ['-m', 'pip', 'install', '--upgrade', ...toolkitPipSpecs()], {
            stdio: 'inherit'
        });
    }

    pruneForeignKernelSpecs();

    return venvPython();
}

/**
 * Writes the settings file extest hands VS Code: the committed base plus the two interpreter
 * settings. Returns the path to pass to `extest -o`.
 *
 * `python.defaultInterpreterPath` is what makes every temp workspace resolve to an interpreter that
 * already has deepnote-toolkit, so opening a notebook registers a controller and running a cell goes
 * straight to execution — no consent prompt, no provisioning. A suite that needs a different
 * interpreter overrides it in its own workspace `.vscode/settings.json`; the setting is
 * `scope: machine-overridable`, so the workspace value wins.
 *
 * `python.venvPath` makes the Python extension discover the venv as an environment rather than a
 * bare path, which is what populates the `folderUri` the server starter reads.
 *
 * Generated rather than committed because both only take absolute paths, known at run time. They
 * have to land in *user* settings, which is where extest writes this file.
 *
 * Deliberately not a `.venv` symlink inside each workspace: the extension names the kernel spec after
 * the venv directory and writes it INTO the venv, keeping the first one it finds
 * (deepnoteToolkitInstaller.installKernelSpec). Every workspace reaching one shared venv through its
 * own `.venv` link therefore inherits the absolute interpreter path of whichever workspace got there
 * first — a path that is deleted the moment that suite cleans up.
 */
export function writeGeneratedSettings(): string {
    const base = JSON.parse(fs.readFileSync(SETTINGS_SOURCE, 'utf8')) as Record<string, unknown>;
    const settings = {
        ...base,
        'python.defaultInterpreterPath': venvPython(),
        'python.venvPath': path.dirname(VENV_DIR)
    };

    fs.writeFileSync(SETTINGS_TARGET, `${JSON.stringify(settings, undefined, 4)}\n`, 'utf8');

    return SETTINGS_TARGET;
}
