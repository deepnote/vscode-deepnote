// Coverage support for the unit test run.
//
// The unit tests execute the compiled `out/**/*.js` files as ES modules through
// `build/mocha-esm-loader.js`. nyc's `require` hook never sees those modules, which is why a
// plain `nyc.wrap()` produced an empty report. Instead we instrument the module source inside
// the loader (see `instrumentSource`) and turn the counters the instrumented code leaves on
// `globalThis.__coverage__` into an lcov report once the run finishes (`writeCoverageReport`).

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(PROJECT_ROOT, 'out');
const COVERAGE_DIR = path.join(PROJECT_ROOT, 'coverage');

// Paths (relative to `out/`, posix separators) that are test scaffolding rather than shipped code.
// `*.bundle.js` is the esbuild output `npm run compile` leaves beside the tsc files; its source map
// points at every bundled dependency, so instrumenting it charges all of node_modules to us.
const EXCLUDED_PATHS = [
    /^test\//,
    /^e2e\//,
    /\/ipywidgets\//,
    /\.test\.js$/,
    /\.testvirtualenvs\.js$/,
    /\.bundle\.js$/
];

let instrumenter;

/**
 * True when the caller asked for an instrumented run (set by CI and by `npm run test:cover`).
 */
export function isCoverageEnabled() {
    return !!process.env.VSC_JUPYTER_INSTRUMENT_CODE_FOR_COVERAGE;
}

/**
 * Decides whether a compiled file in `out/` should be counted towards coverage.
 * @param {string} filePath Absolute path of a file under `out/`.
 */
export function shouldInstrument(filePath) {
    const relativePath = path.relative(OUT_DIR, filePath).split(path.sep).join('/');

    if (relativePath.startsWith('..') || !relativePath.endsWith('.js')) {
        return false;
    }

    return !EXCLUDED_PATHS.some((pattern) => pattern.test(relativePath));
}

/**
 * Adds istanbul counters to a compiled module. The adjacent source map is passed through so the
 * report is attributed to the original TypeScript rather than to the emitted JavaScript.
 * @param {string} source
 * @param {string} filePath
 */
export function instrumentSource(source, filePath) {
    return getInstrumenter().instrumentSync(source, filePath, readSourceMap(filePath));
}

/**
 * Writes `coverage/lcov.info` (plus a console summary, and HTML when requested) from the counters
 * the instrumented modules accumulated on `globalThis.__coverage__`.
 */
export async function writeCoverageReport() {
    const libCoverage = require('istanbul-lib-coverage');
    const libReport = require('istanbul-lib-report');
    const libSourceMaps = require('istanbul-lib-source-maps');
    const reports = require('istanbul-reports');

    const coverageMap = libCoverage.createCoverageMap(globalThis.__coverage__ || {});

    addUncoveredFiles(coverageMap);

    // Attribute the counters to the original .ts sources via each file's inputSourceMap.
    const transformed = await libSourceMaps.createSourceMapStore().transformCoverage(coverageMap);
    const finalMap = transformed && transformed.map ? transformed.map : transformed;

    const context = libReport.createContext({
        dir: COVERAGE_DIR,
        coverageMap: finalMap,
        defaultSummarizer: 'nested'
    });

    const reporters = ['lcovonly', 'text-summary'];
    if (process.env.VSC_JUPYTER_INSTRUMENT_CODE_FOR_COVERAGE_HTML) {
        reporters.push('html');
    }

    for (const reporter of reporters) {
        reports.create(reporter, {}).execute(context);
    }
}

/**
 * Files that were never imported by a test still belong in the report - without them coverage is
 * measured only against the code the tests already touch. Instrumenting them yields their
 * statement/branch maps with all counters at zero.
 * @param {import('istanbul-lib-coverage').CoverageMap} coverageMap
 */
function addUncoveredFiles(coverageMap) {
    const covered = new Set(coverageMap.files());

    for (const filePath of listInstrumentableFiles(OUT_DIR)) {
        if (covered.has(filePath)) {
            continue;
        }

        try {
            const instrumenterInstance = getInstrumenter();
            instrumenterInstance.instrumentSync(fs.readFileSync(filePath, 'utf8'), filePath, readSourceMap(filePath));
            coverageMap.addFileCoverage(instrumenterInstance.lastFileCoverage());
        } catch {
            // A file we cannot parse simply stays out of the report rather than failing the run.
        }
    }
}

function getInstrumenter() {
    if (!instrumenter) {
        const { createInstrumenter } = require('istanbul-lib-instrument');

        instrumenter = createInstrumenter({
            esModules: true,
            compact: true,
            produceSourceMap: false,
            coverageGlobalScope: 'globalThis',
            coverageGlobalScopeFunc: false
        });
    }

    return instrumenter;
}

function listInstrumentableFiles(directory) {
    const files = [];

    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            files.push(...listInstrumentableFiles(entryPath));
        } else if (entry.isFile() && shouldInstrument(entryPath)) {
            files.push(entryPath);
        }
    }

    return files;
}

function readSourceMap(filePath) {
    try {
        return JSON.parse(fs.readFileSync(`${filePath}.map`, 'utf8'));
    } catch {
        return undefined;
    }
}
