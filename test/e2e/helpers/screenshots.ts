import * as fs from 'fs';
import * as path from 'path';
import { VSBrowser } from 'vscode-extension-tester';

// ExTester's own screenshot helper writes flat and cannot create per-test sub-paths, so we organise
// output into one directory per test spec (resolved from cwd, matching fixtures.ts).
const SCREENSHOT_ROOT = path.resolve(process.cwd(), 'test', 'e2e', 'screenshots');

function stripSpecExtension(basename: string): string {
    return basename.replace(/\.e2e\.test\.(js|ts)$/i, '').replace(/\.(js|ts)$/i, '');
}

function resolveSpecFile(context: Mocha.Context): string | undefined {
    // runnable() resolves the file even from a before/after hook, where context.test may be unset.
    const runnable = context.runnable();

    if (!runnable) {
        return undefined;
    }

    if (runnable.file) {
        return runnable.file;
    }

    return runnable.parent?.file;
}

// Throws when the spec file cannot be resolved (e.g. an arrow-function test, where `this` is unbound).
function specSlug(context: Mocha.Context): string {
    const file = resolveSpecFile(context);

    if (!file) {
        throw new Error(
            'Cannot derive a screenshot directory: no spec file on the Mocha context. Call ' +
                'captureScreenshot/createScreenshotter from a `function () {}` test or hook (not an arrow function).'
        );
    }

    const slug = stripSpecExtension(path.basename(file));

    if (!slug) {
        throw new Error(`Cannot derive a screenshot directory from spec file "${file}".`);
    }

    return slug;
}

function slugifyLabel(label: string): string {
    return (
        label
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'shot'
    );
}

/** Captures a full-window screenshot into `test/e2e/screenshots/<spec>/<name>.png` and returns the path. */
export async function captureScreenshot(context: Mocha.Context, name: string): Promise<string> {
    const dir = path.join(SCREENSHOT_ROOT, specSlug(context));
    fs.mkdirSync(dir, { recursive: true });

    const file = path.join(dir, `${slugifyLabel(name)}.png`);
    const image = await VSBrowser.instance.driver.takeScreenshot();
    fs.writeFileSync(file, image, 'base64');
    console.log(`[e2e] screenshot -> ${file}`);

    return file;
}

/** Returns a screenshot function bound to the current test; each call auto-numbers `NN-<label>.png`. */
export function createScreenshotter(context: Mocha.Context): (label: string) => Promise<string> {
    let sequence = 0;

    return (label: string) => {
        sequence += 1;

        return captureScreenshot(context, `${String(sequence).padStart(2, '0')}-${label}`);
    };
}
