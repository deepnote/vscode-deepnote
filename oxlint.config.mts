import { defineConfig } from 'oxlint';

/**
 * Faithful port of the old `.eslintrc.cjs` (21 active rules — `extends: ['prettier']` only
 * disabled rules, it added none). Zero policy change in the port itself; every rule dropped
 * below carries its reason. Prettier still owns formatting and is untouched by this file.
 *
 * Deliberate drops:
 *   import/no-unresolved - `tsc -p ./ --noEmit` (the CI `typecheck` job) already reports
 *     unresolved imports as TS2307; oxlint has no equivalent rule.
 *   react/jsx-uses-react, react/jsx-uses-vars - existed only to feed ESLint's `no-unused-vars`
 *     with JSX usage info; oxlint's native `no-unused-vars` is JSX-aware natively.
 *   the `gulpfile.js`/`build/**\/*.js` override - moot here, since `**\/*.js` and `build/` are
 *     both globally ignored below.
 */

/** The rule map `defineConfig` accepts. Annotating each block gives us option checking. */
type Rules = NonNullable<Parameters<typeof defineConfig>[0]['rules']>;

/** Architecture layering zones, copied verbatim from `import/no-restricted-paths`. */
const restrictedPathZones: Rules['import-plugin/no-restricted-paths'] = [
    'error',
    {
        zones: [
            {
                target: './src/**[!test]**/**/*[!.unit].ts',
                from: './src/test/**/*.ts',
                message: 'Importing test modules from ./src/test into extension code is not allowed.'
            },
            {
                target: './src/**[!test]**/**/*[!.node|.unit].ts',
                from: './src/**/*.node.ts',
                message: 'Importing node modules into non node files is not allowed.'
            },
            {
                target: './src/**[!test]**/**/*[!.web|.unit].ts',
                from: './src/**/*.web.ts',
                message: 'Importing web modules into non web files is not allowed.'
            },
            {
                target: './src/extension.node.ts',
                from: './src/**/*.web.ts',
                message: 'Importing web modules into extension.node.ts is not allowed.'
            },
            {
                target: './src/extension.web.ts',
                from: './src/**/*.node.ts',
                message: 'Importing node modules into extension.web.ts is not allowed.'
            },
            {
                target: './src/kernels/**/*[!.unit].ts',
                from: './src/**[!platform,telemetry,kernels,codespaces]**/**/*.ts',
                message:
                    'Only modules from ./src/platform, ./src/telemetry and ./src/codespaces can be imported into ./src/kernels.'
            },
            {
                target: './src/notebooks/**/*[!.unit].ts',
                from: './src/**[!platform,telemetry,kernels,notebooks,codespaces]**/**/*.ts',
                message:
                    'Only modules from ./src/platform, ./src/telemetry, ./src/kernels and ./src/codespaces can be imported into ./src/notebooks.'
            },
            {
                target: './src/interactive-window/**/*[!.unit].ts',
                from: './src/**webview**/**/*.ts',
                message:
                    'Only modules from ./src/platform, ./src/telemetry, ./src/kernels and ./src/notebooks can be imported into ./src/interactive-window.'
            },
            {
                target: './src/**[!test,standalone,webviews]**/**/*.ts',
                from: './src/webviews/**/*.ts',
                message:
                    'Importing modules from ./src/webviews into core components (platform, kernels, notebooks, interactive-window) is not allowed.'
            },
            {
                target: './src/**[!test,standalone]**/*.ts',
                from: './src/standalone/**/*.ts',
                message: 'Importing modules from ./src/standalone into other components is not allowed.'
            },
            {
                target: './src/telemetry/**/**[!types]**.ts',
                from: './src/**[!telemetry,platform]**/**/*.ts',
                message: 'Importing non-telemetry modules into telemetry files is not allowed.'
            },
            {
                target: './src/platform/**/*[!.unit].ts',
                from: './src/**[!platform]**/**/*.ts',
                message: 'Importing non-platform modules into platform files is not allowed.'
            }
        ]
    }
];

/** Applies to every linted file. */
const baseRules: Rules = {
    'no-only-tests/no-only-tests': ['error', { block: ['test', 'suite'], focus: ['only'] }],

    // Overriding ESLint rules with Typescript-specific ones
    'typescript/ban-ts-comment': ['error', { 'ts-ignore': 'allow-with-description' }],
    'no-dupe-class-members': 'error',
    'no-empty-function': ['error'],
    'typescript/no-explicit-any': 'error',
    'no-unused-vars': ['warn', { argsIgnorePattern: '_\\w*', varsIgnorePattern: '_\\w*' }],
    'no-use-before-define': ['error', { functions: false }],
    'no-useless-constructor': 'error',
    'typescript/no-floating-promises': ['error', { ignoreVoid: true }],

    // Other rules
    'no-labels': 'error',
    'no-with': 'error',
    'local-rules/no-for-in': 'error',
    'no-void': ['error', { allowAsStatement: true }],
    'react/jsx-filename-extension': ['warn', { extensions: ['.tsx'] }],
    'no-restricted-imports': [
        'error',
        {
            paths: ['lodash', 'lodash/noop'],
            patterns: [
                {
                    group: ['@jupyterlab/*'],
                    message: 'Convert to `import type` or dynamic import',
                    allowTypeImports: true
                }
            ]
        }
    ],
    'import-plugin/no-restricted-paths': restrictedPathZones,
    // Node-builtin detection now runs through oxlint's native rule (see overrides below for
    // the .node.ts/.test.ts exceptions); the custom rule only still handles the `path` ban.
    // `path`/`node:path` are allowed here so that ban is reported exactly once, by the custom
    // rule — it names vscode-path and, unlike the native rule, stays on in .node.ts/.test.ts.
    'import/no-nodejs-modules': ['error', { allow: ['events', 'path', 'node:path'] }],
    'local-rules/node-imports': 'error',
    'local-rules/dont-use-process': ['error'],
    'local-rules/dont-use-fspath': ['error'],
    'local-rules/dont-use-filename': ['error']
};

export default defineConfig({
    plugins: ['eslint', 'typescript', 'react', 'import'],
    // Only rules listed below run. Without pinning every category off, naming a plugin
    // pulls in its whole `correctness` set — far wider than the 21 rules ESLint enforced.
    categories: {
        correctness: 'off',
        suspicious: 'off',
        pedantic: 'off',
        perf: 'off',
        style: 'off',
        restriction: 'off',
        nursery: 'off'
    },
    options: { typeAware: true },
    // Rules with no native oxlint implementation, run through their original ESLint plugins.
    jsPlugins: [
        // Alias matches the existing `eslint-disable local-rules/...` comments — load-bearing.
        { name: 'local-rules', specifier: 'eslint-plugin-local-rules' },
        { name: 'no-only-tests', specifier: 'eslint-plugin-no-only-tests' },
        // 'import' is a reserved native oxlint plugin name, so the real eslint-plugin-import
        // (needed for no-restricted-paths, which oxlint's native import plugin doesn't have)
        // is aliased to avoid the collision.
        { name: 'import-plugin', specifier: 'eslint-plugin-import' }
    ],
    // Resolver settings eslint-plugin-import needs to turn './foo' into foo.ts for
    // no-restricted-paths — without these it silently never fires.
    settings: {
        'import/extensions': ['.ts', '.tsx', '.d.ts', '.js', '.jsx'],
        'import/external-module-folders': ['node_modules', 'node_modules/@types'],
        'import/parsers': {
            '@typescript-eslint/parser': ['.ts', '.tsx', '.d.ts']
        },
        'import/resolver': {
            node: {
                extensions: ['.ts', '.tsx', '.d.ts', '.js', '.jsx']
            }
        }
    },
    ignorePatterns: ['**/*.js', 'vscode.d.ts', 'vscode.*.d.ts', 'types', 'build/'],
    rules: baseRules,
    overrides: [
        {
            files: ['src/kernels/**/*.ts', 'src/notebooks/**/*.ts', 'src/webviews/**/*.ts'],
            rules: { 'no-restricted-imports': 'off' }
        },
        {
            files: ['**/*.test.ts', 'src/test/**/*.ts'],
            rules: {
                'typescript/no-explicit-any': 'off',
                'no-restricted-imports': 'off',
                'no-empty-function': 'off',
                'import/no-nodejs-modules': 'off'
            }
        },
        {
            files: ['**/*.node.ts'],
            rules: { 'import/no-nodejs-modules': 'off' }
        },
        {
            files: ['src/*.d.ts'],
            rules: {
                // Keep the *.d.ts files clean of any linting suppressions.
                // These files will be distributed as is as part of the npm package.
                'typescript/no-explicit-any': 'off',
                'no-unused-vars': 'off'
            }
        }
    ]
});
