// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as path from 'path';
import * as esbuild from 'esbuild';
import colors from 'colors';
import type { BuildOptions, Charset, Loader, Plugin, SameShape } from 'esbuild';
import { lessLoader } from 'esbuild-plugin-less';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createRequire } from 'module';
import { getZeroMQPreBuildsFoldersToKeep, getBundleConfiguration, bundleConfiguration } from '../webpack/common';
import ImportGlobPluginModule from 'esbuild-plugin-import-glob';
import postcss from 'postcss';

const ImportGlobPlugin = ImportGlobPluginModule.default || ImportGlobPluginModule;
import tailwindcss from '@tailwindcss/postcss';
import autoprefixer from 'autoprefixer';
import plugin from 'node-stdlib-browser/helpers/esbuild/plugin';
import stdLibBrowser from 'node-stdlib-browser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// These will not be in the main desktop bundle, but will be in the web bundle.
// In desktop, we will bundle/copye each of these separately into the node_modules folder.
const deskTopNodeModulesToExternalize = [
    'pdfkit/js/pdfkit.standalone',
    'crypto-js',
    'fontkit',
    'png-js',
    'zeromq', // Copy, do not bundle
    'zeromqold', // Copy, do not bundle
    // Its loaded by node-fetch (which is now bundled), & since that is lazy loaded
    // there's no need to include into the main bundle.
    'iconv-lite',
    // Its loaded by ivonv-lite, & since that is lazy loaded
    // there's no need to include into the main bundle.
    'fontkit',
    'svg-to-pdfkit',
    // Lazy loaded modules.
    'vscode-languageclient/node',
    '@jupyterlab/nbformat',
    'vscode-jsonrpc',
    // vega-lite uses top-level await (through vega-canvas), must be external
    'vega-lite'
];
const commonExternals = [
    'log4js',
    'vscode',
    'commonjs',
    'vscode-jsonrpc', // Used by a few modules, might as well pull this out, instead of duplicating it in separate bundles.
    // Ignore telemetry specific packages that are not required.
    'applicationinsights-native-metrics',
    '@opentelemetry/tracing',
    '@azure/opentelemetry-instrumentation-azure-sdk',
    '@opentelemetry/instrumentation',
    '@azure/functions-core',
    // Node.js builtins (with node: prefix)
    'node:child_process',
    'node:crypto',
    'node:fs/promises',
    'node:os',
    'node:path',
    'node:util',
    'ansi-regex' // Used by regexp utils
];
// Create separate copies to avoid shared-state mutations
// For web, add Node.js native modules that can't run in browser
const webExternals = [
    ...commonExternals,
    'canvas', // Native module used by vega for server-side rendering, not needed in browser
    'mathjax-electron' // Uses Node.js path module, MathJax rendering handled differently in browser
];
const desktopExternals = [...commonExternals, ...deskTopNodeModulesToExternalize];
const bundleConfig = getBundleConfiguration();
const isDevbuild = !process.argv.includes('--production');
const watchAll = process.argv.includes('--watch-all');
const isWatchMode = watchAll || process.argv.includes('--watch');
const extensionFolder = path.join(__dirname, '..', '..');

// Security pins copied from the root `overrides` into the generated sql-lsp-modules package.json,
// which npm installs in isolation and would otherwise resolve to vulnerable versions.
const sqlLspOverridesToPropagate = ['ip-address', 'ssh2', 'tar', '@tootallnate/once'];

interface StylePluginOptions {
    /**
     * whether to minify the css code.
     * @default true
     */
    minify?: boolean;

    /**
     * css charset.
     * @default 'utf8'
     */
    charset?: Charset;
}
const loader: { [ext: string]: Loader } = {
    '.woff': 'dataurl',
    '.woff2': 'dataurl',
    '.eot': 'dataurl',
    '.ttf': 'dataurl',
    '.gif': 'dataurl',
    '.svg': 'dataurl',
    '.png': 'dataurl'
};

// https://github.com/evanw/esbuild/issues/20#issuecomment-802269745
// https://github.com/hyrious/esbuild-plugin-style
function style({
    minify = true,
    charset = 'utf8',
    enableTailwind = false
}: StylePluginOptions & { enableTailwind?: boolean } = {}): Plugin {
    return {
        name: 'style',
        setup({ onResolve, onLoad }) {
            const cwd = process.cwd();
            const opt: BuildOptions = { logLevel: 'silent', bundle: true, write: false, charset, minify };

            onResolve({ filter: /\.css$/, namespace: 'file' }, (args) => {
                const absPath = path.join(args.resolveDir, args.path);
                const relPath = path.relative(cwd, absPath);
                const resolved = fs.existsSync(absPath) ? relPath : args.path;
                return { path: resolved, namespace: 'style-stub' };
            });

            onResolve({ filter: /\.css$/, namespace: 'style-stub' }, (args) => {
                return { path: args.path, namespace: 'style-content' };
            });

            onResolve({ filter: /^__style_helper__$/, namespace: 'style-stub' }, (args) => ({
                path: args.path,
                namespace: 'style-helper',
                sideEffects: false
            }));

            onLoad({ filter: /.*/, namespace: 'style-helper' }, async () => ({
                contents: `
            export function injectStyle(text) {
              if (typeof document !== 'undefined') {
                var style = document.createElement('style')
                var node = document.createTextNode(text)
                style.appendChild(node)
                document.head.appendChild(style)
              }
            }
          `
            }));

            onLoad({ filter: /.*/, namespace: 'style-stub' }, async (args) => ({
                contents: `
            import { injectStyle } from "__style_helper__"
            import css from ${JSON.stringify(args.path)}
            injectStyle(css)
          `
            }));

            onLoad({ filter: /.*/, namespace: 'style-content' }, async (args) => {
                // Process with PostCSS/Tailwind if enabled and file exists
                if (enableTailwind && args.path.includes('tailwind.css') && fs.existsSync(args.path)) {
                    try {
                        const cssContent = await fs.readFile(args.path, 'utf8');
                        const result = await postcss([tailwindcss, autoprefixer]).process(cssContent, {
                            from: args.path,
                            to: args.path
                        });

                        const options = { ...opt, stdin: { contents: result.css, loader: 'css' } };
                        options.loader = options.loader || {};
                        // Add the same loaders we add for other places
                        Object.keys(loader).forEach((key) => {
                            if (options.loader && !options.loader[key]) {
                                options.loader[key] = loader[key];
                            }
                        });
                        const { errors, warnings, outputFiles } = await esbuild.build(options);
                        return { errors, warnings, contents: outputFiles![0].text, loader: 'text' };
                    } catch (error) {
                        console.error(`PostCSS processing failed for ${args.path}:`, error);
                        throw error;
                    }
                }

                // Default behavior for other CSS files
                const options = { entryPoints: [args.path], ...opt };
                options.loader = options.loader || {};
                // Add the same loaders we add for other places
                Object.keys(loader).forEach((key) => {
                    if (options.loader && !options.loader[key]) {
                        options.loader[key] = loader[key];
                    }
                });

                const { errors, warnings, outputFiles } = await esbuild.build(options);

                return { errors, warnings, contents: outputFiles![0].text, loader: 'text' };
            });
        }
    };
}

function createConfig(
    source: string,
    outfile: string,
    target: 'desktop' | 'web',
    watch: boolean
): SameShape<BuildOptions, BuildOptions> {
    const inject: string[] = [];
    const isWebTestSource = source.endsWith(path.join('web', 'index.ts'));
    const plugins: Plugin[] = [];
    let define: SameShape<BuildOptions, BuildOptions>['define'] = undefined;
    if (target === 'web') {
        // Enable Tailwind processing for dataframe renderer
        const enableTailwind = source.includes(path.join('dataframe-renderer', 'index.ts'));
        plugins.push(style({ enableTailwind }));
        plugins.push(lessLoader());

        define = {
            BROWSER: 'true', // From webacpk scripts we had.
            global: 'this'
        };

        if (isWebTestSource) {
            define.global = 'global'; // global:'global' is required for mocha tests to work in the browser.
            define.process = 'process';
            define.Buffer = 'Buffer';
            plugins.push(ImportGlobPlugin());
            plugins.push(plugin(stdLibBrowser));
            inject.push(require.resolve('node-stdlib-browser/helpers/esbuild/shim'));
        } else {
            inject.push(path.join(__dirname, isDevbuild ? 'process.development.js' : 'process.production.js'));
        }
    }
    if (target === 'desktop') {
        // Empty when unset locally; src/platform/analytics/constants.ts falls back to safe defaults.
        define = {
            POSTHOG_API_KEY_BUILD: JSON.stringify(process.env.POSTHOG_API_KEY ?? ''),
            POSTHOG_CHANNEL_BUILD: JSON.stringify(process.env.POSTHOG_CHANNEL ?? '')
        };
    }
    if (source.endsWith(path.join('data-explorer', 'index.tsx'))) {
        inject.push(path.join(__dirname, 'jquery.js'));
    }
    // Create a copy to avoid mutating the original arrays
    let external = [...(target === 'web' ? webExternals : commonExternals)];
    if (source.toLowerCase().endsWith('extension.node.ts')) {
        external.push(...desktopExternals);
    }
    // When building vscode-languageclient, bundle vscode-jsonrpc into it
    // to avoid ESM/CommonJS interop issues at runtime
    if (source.includes('vscode-languageclient')) {
        external = external.filter((e) => e !== 'vscode-jsonrpc');
    }
    const isPreRelease = isDevbuild || process.env.IS_PRE_RELEASE_VERSION_OF_JUPYTER_EXTENSION === 'true';
    const releaseVersionScriptFile = isPreRelease ? 'release.pre-release.js' : 'release.stable.js';
    const alias: Record<string, string> = {
        moment: path.join(extensionFolder, 'build', 'webpack', 'moment.js'),
        'vscode-jupyter-release-version': path.join(__dirname, releaseVersionScriptFile),
        // Stub for @nteract/presentational-components to avoid pulling in vulnerable dependencies
        '@nteract/presentational-components': path.join(
            extensionFolder,
            'src',
            'renderers',
            'client',
            'stubs',
            'nteract-presentational-components.tsx'
        )
    };
    // Use ESM entry for jsonc-parser to avoid UMD internal require() issues when bundling
    if (target === 'desktop') {
        alias['jsonc-parser'] = path.join(extensionFolder, 'node_modules', 'jsonc-parser', 'lib', 'esm', 'main.js');
    }
    // @deepnote/runtime-core needs Node built-ins (net, child_process) and is excluded from the VSIX;
    // externalizing it (like desktop) would leave an unresolvable bare import in the web bundle.
    if (target === 'web') {
        alias['@deepnote/runtime-core'] = path.join(
            extensionFolder,
            'src',
            'notebooks',
            'deepnote',
            'runtimeCore.web.ts'
        );
    }
    // Desktop builds use CommonJS for VS Code/Cursor compatibility
    // Web builds use ESM for browser compatibility
    const config: SameShape<BuildOptions, BuildOptions> = {
        entryPoints: [source],
        outfile,
        bundle: true,
        external,
        alias,
        format: target === 'desktop' ? 'cjs' : 'esm',
        metafile: isDevbuild && !watch,
        define,
        target: target === 'desktop' ? 'node18' : 'es2018',
        platform: target === 'desktop' ? 'node' : 'browser',
        minify: !isDevbuild,
        logLevel: 'info',
        sourcemap: isDevbuild,
        inject,
        plugins,
        loader: target === 'desktop' ? {} : loader
    };

    return config;
}
async function build(source: string, outfile: string, options: { watch: boolean; target: 'desktop' | 'web' }) {
    if (options.watch) {
        const context = await esbuild.context(createConfig(source, outfile, options.target, options.watch));
        await context.watch();
    } else {
        const result = await esbuild.build(createConfig(source, outfile, options.target, options.watch));
        const size = fs.statSync(outfile).size;
        const relativePath = `./${path.relative(extensionFolder, outfile)}`;
        console.log(`asset ${colors.green(relativePath)} size: ${(size / 1024).toFixed()} KiB`);
        if (isDevbuild && result.metafile) {
            const metafile = `${outfile}.esbuild.meta.json`;
            await fs.writeFile(metafile, JSON.stringify(result.metafile));
            console.log(`metafile ${colors.green(`./${path.relative(extensionFolder, metafile)}`)}`);
        }
    }
}

async function buildAll() {
    // First build the less file format, convert to css, and then build tsx to use the css
    // The source imports the css files.
    const getLessBuilders = (watch = isWatchMode) => {
        return [
            build(
                path.join(
                    extensionFolder,
                    'src',
                    'webviews',
                    'webview-side',
                    'interactive-common',
                    'variableExplorerGrid.less'
                ),
                path.join(
                    extensionFolder,
                    'src',
                    'webviews',
                    'webview-side',
                    'interactive-common',
                    'variableExplorerGrid.css'
                ),
                { watch, target: 'web' }
            ),
            build(
                path.join(extensionFolder, 'src', 'webviews', 'webview-side', 'react-common', 'seti', 'seti.less'),
                path.join(extensionFolder, 'src', 'webviews', 'webview-side', 'react-common', 'seti', 'seti.css'),
                { watch, target: 'web' }
            )
        ];
    };
    await Promise.all(getLessBuilders(false));

    const builders: Promise<void>[] = [];

    if (watchAll) {
        // Run less builders again, in case we are in watch mode.
        builders.push(...getLessBuilders(true));
    }
    // WebViews, widgets, etc
    builders.push(
        build(
            path.join(extensionFolder, 'src', 'webviews', 'webview-side', 'ipywidgets', 'kernel', 'index.ts'),
            path.join(extensionFolder, 'dist', 'webviews', 'webview-side', 'ipywidgetsKernel', 'ipywidgetsKernel.js'),
            { target: 'web', watch: watchAll }
        ),
        build(
            path.join(extensionFolder, 'src', 'webviews', 'webview-side', 'ipywidgets', 'renderer', 'index.ts'),
            path.join(
                extensionFolder,
                'dist',
                'webviews',
                'webview-side',
                'ipywidgetsRenderer',
                'ipywidgetsRenderer.js'
            ),
            { target: 'web', watch: watchAll }
        ),
        build(
            path.join(extensionFolder, 'src', 'webviews', 'webview-side', 'dataframe-renderer', 'index.ts'),
            path.join(extensionFolder, 'dist', 'webviews', 'webview-side', 'dataframeRenderer', 'dataframeRenderer.js'),
            { target: 'web', watch: isWatchMode }
        ),
        build(
            path.join(extensionFolder, 'src', 'webviews', 'webview-side', 'chart-big-number-renderer', 'index.ts'),
            path.join(
                extensionFolder,
                'dist',
                'webviews',
                'webview-side',
                'chartBigNumberRenderer',
                'chartBigNumberRenderer.js'
            ),
            { target: 'web', watch: isWatchMode }
        ),
        build(
            path.join(extensionFolder, 'src', 'webviews', 'webview-side', 'vega-renderer', 'index.ts'),
            path.join(extensionFolder, 'dist', 'webviews', 'webview-side', 'vegaRenderer', 'vegaRenderer.js'),
            { target: 'web', watch: isWatchMode }
        ),
        build(
            path.join(extensionFolder, 'src', 'webviews', 'webview-side', 'sql-metadata-renderer', 'index.ts'),
            path.join(
                extensionFolder,
                'dist',
                'webviews',
                'webview-side',
                'sqlMetadataRenderer',
                'sqlMetadataRenderer.js'
            ),
            { target: 'web', watch: isWatchMode }
        ),
        build(
            path.join(extensionFolder, 'src', 'webviews', 'webview-side', 'variable-view', 'index.tsx'),
            path.join(extensionFolder, 'dist', 'webviews', 'webview-side', 'viewers', 'variableView.js'),
            { target: 'web', watch: watchAll }
        ),
        build(
            path.join(extensionFolder, 'src', 'webviews', 'webview-side', 'plot', 'index.tsx'),
            path.join(extensionFolder, 'dist', 'webviews', 'webview-side', 'viewers', 'plotViewer.js'),
            { target: 'web', watch: watchAll }
        ),
        build(
            path.join(extensionFolder, 'src', 'webviews', 'webview-side', 'data-explorer', 'index.tsx'),
            path.join(extensionFolder, 'dist', 'webviews', 'webview-side', 'viewers', 'dataExplorer.js'),
            { target: 'web', watch: watchAll }
        ),
        build(
            path.join(extensionFolder, 'src', 'webviews', 'webview-side', 'integrations', 'index.tsx'),
            path.join(extensionFolder, 'dist', 'webviews', 'webview-side', 'integrations', 'index.js'),
            { target: 'web', watch: watchAll }
        ),
        build(
            path.join(extensionFolder, 'src', 'webviews', 'webview-side', 'selectInputSettings', 'index.tsx'),
            path.join(extensionFolder, 'dist', 'webviews', 'webview-side', 'selectInputSettings', 'index.js'),
            { target: 'web', watch: watchAll }
        ),
        build(
            path.join(extensionFolder, 'src', 'webviews', 'webview-side', 'bigNumberComparisonSettings', 'index.tsx'),
            path.join(extensionFolder, 'dist', 'webviews', 'webview-side', 'bigNumberComparisonSettings', 'index.js'),
            { target: 'web', watch: watchAll }
        ),
        // Notebook renderers (integrated from jupyter-renderers)
        build(
            path.join(extensionFolder, 'src', 'renderers', 'client', 'index.tsx'),
            path.join(extensionFolder, 'dist', 'renderers', 'client', 'renderers.js'),
            { target: 'web', watch: watchAll }
        ),
        build(
            path.join(extensionFolder, 'src', 'renderers', 'client', 'builtinRendererHooks.ts'),
            path.join(extensionFolder, 'dist', 'renderers', 'client', 'builtinRendererHooks.js'),
            { target: 'web', watch: watchAll }
        ),
        build(
            path.join(extensionFolder, 'src', 'renderers', 'client', 'markdown.ts'),
            path.join(extensionFolder, 'dist', 'renderers', 'client', 'markdown.js'),
            { target: 'web', watch: watchAll }
        ),
        build(
            path.join(extensionFolder, 'src', 'renderers', 'client', 'preload.ts'),
            path.join(extensionFolder, 'dist', 'renderers', 'client', 'preload.js'),
            { target: 'web', watch: watchAll }
        )
    );

    // Copy ipywidgets from node_modules
    builders.push(copyIPyWidgets7(), copyIPyWidgets8());

    if (isDevbuild) {
        builders.push(
            build(
                path.join(extensionFolder, 'src', 'test', 'datascience', 'widgets', 'rendererUtils.ts'),
                path.join(extensionFolder, 'dist', 'webviews', 'webview-side', 'widgetTester', 'widgetTester.js'),
                { target: 'web', watch: watchAll }
            )
        );
    }
    if (bundleConfig !== 'desktop') {
        builders.push(
            build(
                path.join(extensionFolder, 'src', 'extension.web.ts'),
                path.join(extensionFolder, 'dist', 'extension.web.bundle.js'),
                { target: 'web', watch: watchAll }
            )
        );
        builders.push(
            build(
                path.join(extensionFolder, 'src', 'test', 'web', 'index.ts'),
                path.join(extensionFolder, 'out', 'extension.web.bundle.js'),
                { target: 'web', watch: watchAll }
            )
        );
    }
    if (bundleConfig !== 'web') {
        builders.push(
            build(
                path.join(extensionFolder, 'src', 'extension.node.ts'),
                path.join(extensionFolder, 'dist', 'extension.node.js'),
                { target: 'desktop', watch: isWatchMode }
            )
        );
        builders.push(
            ...deskTopNodeModulesToExternalize
                // zeromq will be manually bundled, vega-lite uses top-level await (can't be CJS bundled)
                .filter((module) => !['zeromq', 'zeromqold', 'vscode-jsonrpc', 'vega-lite'].includes(module))

                .map(async (module) => {
                    const fullPath = require.resolve(module);
                    return build(
                        fullPath,
                        path.join(extensionFolder, 'dist', 'node_modules', `${path.join(module, 'index.js')}`),
                        {
                            target: 'desktop',
                            // These almost never change, easier to re-run copmilation if packges change.
                            watch: false
                        }
                    );
                })
        );
        builders.push(
            copyJQuery(),
            copyAminya(),
            copyZeroMQ(),
            copyZeroMQOld(),
            copyNodeGypBuild(),
            buildVSCodeJsonRPC(),
            buildSqlLanguageServer()
        );
    }

    await Promise.all(builders);
}

/**
 * TODO: Who uses JQuery?
 * Possibly shipped for widgets.
 * Need to verify this, if this is the case, then possibly best shipped with renderers.
 */
async function copyJQuery() {
    const source = require.resolve('jquery').replace('jquery.js', 'jquery.min.js');
    const target = path.join(extensionFolder, 'dist', 'node_modules', 'jquery', 'out', 'jquery.min.js');
    const license = require.resolve('jquery').replace(path.join('out', 'jquery.js'), 'LICENSE.txt');
    await fs.ensureDir(path.dirname(target));
    await Promise.all([
        fs.copyFile(source, target),
        fs.copyFile(license, path.join(extensionFolder, 'dist', 'node_modules', 'jquery', 'LICENSE.txt'))
    ]);
}

async function copyAminya() {
    const source = path.join(extensionFolder, 'node_modules', '@aminya/node-gyp-build');
    const target = path.join(extensionFolder, 'dist', 'node_modules', '@aminya/node-gyp-build');
    await fs.ensureDir(path.dirname(target));
    await fs.ensureDir(target);
    await fs.copy(source, target, { recursive: true });
}
async function copyZeroMQ() {
    const source = path.join(extensionFolder, 'node_modules', 'zeromq');
    const target = path.join(extensionFolder, 'dist', 'node_modules', 'zeromq');
    await fs.ensureDir(target);
    await fs.copy(source, target, {
        recursive: true,
        filter: (src) => shouldCopyFileFromZmqFolder(src)
    });
}
async function copyZeroMQOld() {
    const source = path.join(extensionFolder, 'node_modules', 'zeromqold');
    const target = path.join(extensionFolder, 'dist', 'node_modules', 'zeromqold');
    await fs.ensureDir(path.dirname(target));
    await fs.ensureDir(target);
    await fs.copy(source, target, {
        recursive: true,
        filter: (src) => shouldCopyFileFromZmqFolder(src)
    });
}
async function copyNodeGypBuild() {
    const source = path.join(extensionFolder, 'node_modules', 'node-gyp-build');
    const target = path.join(extensionFolder, 'dist', 'node_modules', 'node-gyp-build');
    await fs.ensureDir(path.dirname(target));
    await fs.ensureDir(target);
    await fs.copy(source, target, { recursive: true });
}

/**
 * Helper to copy a bundle file if it exists, with clear error messaging
 */
async function copyBundleIfExists(source: string, target: string, description: string): Promise<void> {
    const exists = await fs.pathExists(source);
    if (!exists) {
        console.warn(
            colors.yellow(`Warning: ${description} not found at ${source}. `) +
                colors.yellow('Skipping copy. Install the package if this feature is needed.')
        );
        return;
    }
    await fs.ensureDir(path.dirname(target));
    await fs.copyFile(source, target);
}

/**
 * Copy @vscode/jupyter-ipywidgets7 pre-built bundle for IPyWidget v7 support
 */
async function copyIPyWidgets7() {
    const source = path.join(
        extensionFolder,
        'node_modules',
        '@vscode',
        'jupyter-ipywidgets7',
        'dist',
        'ipywidgets.js'
    );
    const target = path.join(extensionFolder, 'dist', 'renderers', 'ipywidgets7', 'ipywidgets.js');
    await copyBundleIfExists(source, target, '@vscode/jupyter-ipywidgets7 bundle');
}

/**
 * Copy @vscode/jupyter-ipywidgets8 pre-built bundle for IPyWidget v8 support
 */
async function copyIPyWidgets8() {
    const source = path.join(
        extensionFolder,
        'node_modules',
        '@vscode',
        'jupyter-ipywidgets8',
        'dist',
        'ipywidgets.js'
    );
    const target = path.join(extensionFolder, 'dist', 'renderers', 'ipywidgets8', 'ipywidgets.js');
    await copyBundleIfExists(source, target, '@vscode/jupyter-ipywidgets8 bundle');
}

async function buildSqlLanguageServer() {
    // Bundle the sql-language-server with all its dependencies into a single file
    const entryPoint = path.join(
        extensionFolder,
        'node_modules',
        '@deepnote',
        'sql-language-server',
        'dist',
        'bin',
        'vscodeExtensionServer.js'
    );
    const outfile = path.join(extensionFolder, 'dist', 'sqlLanguageServer.cjs');

    await esbuild.build({
        entryPoints: [entryPoint],
        bundle: true,
        platform: 'node',
        target: 'node18',
        outfile,
        format: 'cjs',
        external: [
            // These are optional database drivers - exclude to reduce bundle size
            // They will be loaded dynamically if available
            'sqlite3',
            'mysql2',
            'pg',
            'pg-native',
            '@google-cloud/bigquery',
            // SSH tunneling dependencies with native modules - must be copied separately
            'ssh2',
            'cpu-features',
            'node-ssh-forward'
        ],
        minify: false,
        sourcemap: false
    });

    // Copy ALL node_modules that the sql-language-server needs
    // This includes the full transitive dependency tree for:
    // - node-ssh-forward (SSH tunneling)
    // - mysql2, pg, sqlite3 (database drivers)
    // Instead of manually tracking dependencies, we copy all required packages
    const sqlLspNodeModules = path.join(extensionFolder, 'dist', 'sql-lsp-modules');
    await fs.ensureDir(sqlLspNodeModules);

    // Create a minimal package.json and install dependencies
    const rootPackageJson = await fs.readJSON(path.join(extensionFolder, 'package.json'));
    const rootOverrides: Record<string, string> = rootPackageJson.overrides || {};
    const overrides: Record<string, string> = {};

    for (const name of sqlLspOverridesToPropagate) {
        if (typeof rootOverrides[name] === 'string') {
            overrides[name] = rootOverrides[name];
        } else {
            throw new Error(
                `Expected a string "${name}" entry in the root package.json overrides to propagate to sql-lsp-modules.`
            );
        }
    }

    const packageJson = {
        name: 'sql-lsp-deps',
        version: '1.0.0',
        dependencies: {
            'node-ssh-forward': '^0.6.3',
            mysql2: '^3.22.0',
            pg: '^8.9.0',
            sqlite3: '^5.0.3',
            '@google-cloud/bigquery': '^8.1.1'
        },
        overrides
    };

    const packageJsonPath = path.join(sqlLspNodeModules, 'package.json');
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));

    // Run npm install in the sql-lsp-modules directory
    const { execSync } = require('child_process');

    try {
        execSync('npm install --omit=dev --ignore-scripts', {
            cwd: sqlLspNodeModules,
            stdio: 'inherit'
        });
    } catch (error) {
        console.error('Failed to install sql-lsp dependencies:', error);
        throw error;
    }

    // Keep package.json for debugging/audit purposes, remove only lock file
    await fs.remove(path.join(sqlLspNodeModules, 'package-lock.json'));
}

async function buildVSCodeJsonRPC() {
    const source = path.join(extensionFolder, 'node_modules', 'vscode-jsonrpc');
    const target = path.join(extensionFolder, 'dist', 'node_modules', 'vscode-jsonrpc', 'index.js');
    await fs.ensureDir(path.dirname(target));
    const fullPath = require.resolve(source);
    // ESM re-export for node.js entry point
    const contents = `export * from './index.js';`;
    await fs.writeFile(path.join(path.dirname(target), 'node.js'), contents);
    // Add package.json for ESM module resolution
    const packageJson = JSON.stringify({ type: 'module', main: './index.js' }, null, 2);
    await fs.writeFile(path.join(path.dirname(target), 'package.json'), packageJson);
    return build(fullPath, target, {
        target: 'desktop',
        watch: false
    });
}

function shouldCopyFileFromZmqFolder(resourcePath) {
    const parentFolder = path.dirname(resourcePath);
    if (fs.statSync(resourcePath).isDirectory()) {
        return true;
    }
    // return true;
    const filename = path.basename(resourcePath);
    // Ensure the code is platform agnostic.
    resourcePath = (resourcePath || '').toString().toLowerCase().replace(/\\/g, '/');
    // We do not need to bundle these folders
    const foldersToIgnore = ['build', 'script', 'src', 'node_modules', 'vendor'];
    if (
        foldersToIgnore.some((folder) =>
            resourcePath.toLowerCase().startsWith(path.join(parentFolder, folder).replace(/\\/g, '/').toLowerCase())
        )
    ) {
        return false;
    }

    if (
        resourcePath.endsWith('.js') ||
        resourcePath.endsWith('.json') ||
        resourcePath.endsWith('.md') ||
        resourcePath.endsWith('license')
    ) {
        return true;
    }
    // if (!resourcePath.includes(path.join(parentFolder, 'prebuilds').replace(/\\/g, '/').toLowerCase())) {
    if (!parentFolder.includes(`${path.sep}prebuilds${path.sep}`)) {
        // We do not ship any other sub directory.
        return false;
    }
    if (filename.includes('electron.') && resourcePath.endsWith('.node')) {
        // We do not ship electron binaries.
        return false;
    }
    const preBuildsFoldersToCopy = getZeroMQPreBuildsFoldersToKeep();
    if (preBuildsFoldersToCopy.length === 0) {
        // Copy everything from all prebuilds folder.
        return true;
    }
    // Copy if this is a prebuilds folder that needs to be copied across.
    // Use path.sep as the delimiter, as we do not want linux-arm64 to get compiled with search criteria is linux-arm.
    if (preBuildsFoldersToCopy.some((folder) => resourcePath.includes(`${folder.toLowerCase()}/`))) {
        return true;
    }
    return false;
}

const started = Date.now();
buildAll();
