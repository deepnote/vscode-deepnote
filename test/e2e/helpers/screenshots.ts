import * as fs from 'fs';
import * as path from 'path';
import { VSBrowser } from 'vscode-extension-tester';

// Root for the intentional, step-by-step screenshots these suites capture. ExTester's own
// `VSBrowser.takeScreenshot` writes flat into `TEST_RESOURCES/screenshots/<run-timestamp>/` and
// cannot create per-test sub-paths, so we build on the same underlying `driver.takeScreenshot()`
// primitive but organise output into one directory per test spec under `test/e2e/screenshots/`
// (resolved from cwd, matching how `fixtures.ts` locates `test/e2e/fixtures`).
const SCREENSHOT_ROOT = path.resolve(process.cwd(), 'test', 'e2e', 'screenshots');

/** Strips the compiled-spec suffix (`.e2e.test.js`/`.ts`, then a bare `.js`/`.ts`) from a basename. */
function stripSpecExtension(basename: string): string {
    return basename.replace(/\.e2e\.test\.(js|ts)$/i, '').replace(/\.(js|ts)$/i, '');
}

/** Resolves the running spec's file path from the Mocha context — a test/hook runnable, or its suite. */
function resolveSpecFile(context: Mocha.Context): string | undefined {
    // `context.runnable()` returns the active test OR hook, so this also resolves the file when a
    // screenshot is captured from a `before`/`after` hook (where `context.test` may be unset).
    const runnable = context.runnable();

    if (!runnable) {
        return undefined;
    }

    if (runnable.file) {
        return runnable.file;
    }

    return runnable.parent?.file;
}

/**
 * Derives a stable per-spec slug from the running Mocha context — the spec file's basename with the
 * `.e2e.test.(js|ts)` suffix stripped (e.g. `splitMultiNotebook.e2e.test.js` -> `splitMultiNotebook`).
 * Throws when the spec file cannot be resolved (e.g. called from an arrow-function test, where `this`
 * is not bound to the Mocha context).
 */
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

/** Makes a label safe to embed in a filename. */
function slugifyLabel(label: string): string {
    return (
        label
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'shot'
    );
}

/**
 * Captures a full-window screenshot into `test/e2e/screenshots/<spec>/<name>.png` and returns the path.
 * The directory is derived from the running spec so different suites never collide.
 *
 * Prefer {@link createScreenshotter} in a test body — it binds the context once and auto-numbers.
 *
 * @param context The Mocha context (`this` inside a `function () {}` test/hook)
 * @param name The file name (without extension), e.g. `01-split-prompt`
 */
export async function captureScreenshot(context: Mocha.Context, name: string): Promise<string> {
    const dir = path.join(SCREENSHOT_ROOT, specSlug(context));
    fs.mkdirSync(dir, { recursive: true });

    const file = path.join(dir, `${slugifyLabel(name)}.png`);
    const image = await VSBrowser.instance.driver.takeScreenshot();
    fs.writeFileSync(file, image, 'base64');
    console.log(`[e2e] screenshot -> ${file}`);

    return file;
}

/**
 * Returns a screenshot function bound to the current test. Each call writes the next
 * `NN-<label>.png` (auto-incrementing, zero-padded) into `test/e2e/screenshots/<spec>/`, so callers only
 * supply a descriptive label and get deterministic ordering for free.
 *
 * @param context The Mocha context (`this` inside a `function () {}` test)
 * @example
 *   const screenshot = createScreenshotter(this);
 *   await screenshot('before-open');   // -> test/e2e/screenshots/splitMultiNotebook/01-before-open.png
 *   await screenshot('split-prompt');  // -> test/e2e/screenshots/splitMultiNotebook/02-split-prompt.png
 */
export function createScreenshotter(context: Mocha.Context): (label: string) => Promise<string> {
    let sequence = 0;

    return (label: string) => {
        sequence += 1;

        return captureScreenshot(context, `${String(sequence).padStart(2, '0')}-${label}`);
    };
}
