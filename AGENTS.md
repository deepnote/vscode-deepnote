# Agent Development Guide

This document provides guidelines for AI coding agents working on the Deepnote extension for VS Code, Cursor, Windsurf, and Antigravity.

## Repository Overview

This repository is a fork of Microsoft's `vscode-jupyter` extension. Most of `src/` is inherited upstream Jupyter/notebook code that should change rarely and deliberately. Deepnote-specific work is concentrated in four directories:

- `src/notebooks/deepnote/` - `.deepnote` file parsing/serialization, block converters, the sidebar explorer, environment snapshots, and integrations wiring (the bulk of Deepnote-specific code)
- `src/kernels/deepnote/` - kernel auto-selection, the SQL language server client, and server startup for Deepnote projects
- `src/platform/deepnote/` and `src/platform/notebooks/deepnote/` - shared Deepnote types, telemetry, and integration config used across the platform layer
- `src/webviews/webview-side/integrations/` - the React UI for the database integrations panel

If a file isn't under one of these paths, assume it's inherited upstream code — read it for context, but don't restructure it as a side effect of a Deepnote change.

### Repository Routing

Start with the owning directory and its colocated tests before searching broadly. Avoid traversing unrelated inherited Jupyter code.

| When working on                                        | Start with                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `.deepnote` parsing, serialization, block conversion    | `src/notebooks/deepnote/deepnoteSerializer.ts`, `src/notebooks/deepnote/converters/`     |
| Explorer sidebar / tree view                             | `src/notebooks/deepnote/deepnoteExplorerView.ts`, `src/notebooks/deepnote/deepnoteTreeDataProvider.ts` |
| Environment snapshots & `requirements.txt` generation    | `src/notebooks/deepnote/snapshots/`                                                       |
| Database integrations (credentials, env refresh, webview) | `src/notebooks/deepnote/integrations/`, `src/webviews/webview-side/integrations/`       |
| Kernel selection, SQL LSP, server startup                | `src/kernels/deepnote/`                                                                   |
| Shared Deepnote types & platform config                  | `src/platform/deepnote/`, `src/platform/notebooks/deepnote/`                             |
| Core serializer architecture & data flow                 | `specs/architecture.md`                                                                   |
| Kernel management internals                               | `specs/DEBUGGING_KERNEL_MANAGEMENT.md`, `specs/DEEPNOTE_KERNEL_IMPLEMENTATION.md`         |
| Integration credentials & live env refresh                | `specs/INTEGRATIONS_CREDENTIALS.md`, `specs/INTEGRATION_ENV_LIVE_REFRESH.md`             |
| SQL language server behavior                              | `specs/LSP.md`                                                                             |
| End-to-end tests                                           | `test/e2e/`                                                                                |

## Development Workflow

Always run commands from the repository root, using the Node version pinned in `.nvmrc`.

### Setup

```bash
npm install
```

`postinstall` downloads the VS Code API typings and runs `build/ci/postInstall.js`.

### Testing

```bash
# Unit tests run against compiled JS, so build first
npm run compile-tsc
npm test                # same as npm run test:unittests

# Filter by suite/test name
npm run test:unittests -- --grep "SuiteName"

# Run a single compiled test file
npx mocha --config ./build/.mocha.unittests.js.json ./out/path/to/file.unit.test.js

# End-to-end tests (extest-driven VS Code + chromedriver)
npm run setup:e2e       # required first — see below
npm run compile-e2e     # E2E also runs against compiled JS
npm run test:e2e
```

- Unit tests use Mocha/Chai with the `.unit.test.ts` extension, colocated with the source they test.
- Use `assert.deepStrictEqual()` for object comparisons instead of checking individual properties.
- `npm run setup:e2e` fetches the test VS Code build, chromedriver, the Python extension and the mock
  LLM server, then runs `setup:e2e:venv`, which bakes the `deepnote-toolkit` venv into `.venv-e2e` and
  writes `test/e2e/settings.generated.json`. The suites adopt that venv instead of each provisioning
  their own, which is most of the runtime.
- `test:e2e` needs the generated settings file, because `python.venvPath` is a machine-scoped setting
  that only takes effect in user settings — extest reads it at launch and fails if it is missing. Re-run
  `npm run setup:e2e:venv` on its own to regenerate it.
- CI shards the suites by directory under `test/e2e/suite/<group>/` and runs one group per job via
  `E2E_GROUP=<group> npm run test:e2e:ci`. A new group directory must be added to the matrix in
  `.github/workflows/e2e.yml`, or the `verify-coverage` job fails the build.

### Type Checking

```bash
npm run typecheck
```

### Linting, Formatting & Spelling

```bash
npm run lint            # Oxlint check
npm run lint-fix        # Oxlint autofix
npm run format          # Prettier check
npm run format-fix      # Prettier write
npm run spell-check     # cspell
```

### Building

```bash
npm run compile         # tsc + esbuild, dev
npm run build           # production bundle
```

## Code Quality Standards

### After making changes

Always run `npm run format-fix`.

### Before committing

1. **Tests** - `npm test` - all tests must pass
2. **Type check** - `npm run typecheck` - no TypeScript errors
3. **Lint** - `npm run lint` - must pass Oxlint
4. **Format** - `npm run format` - must pass Prettier

The `pre-commit` hook already runs `lint-staged` (Oxlint + Prettier on staged files) and `pre-push` blocks direct pushes to `main` — running the full checks yourself catches issues earlier.

### TypeScript & Code Style

- Order methods, fields, and properties first by accessibility, then alphabetically.
- Don't add the Microsoft copyright header to new files.
- Use `Uri.joinPath()` for file paths instead of string concatenation, so path separators stay platform-correct.
- Reuse existing helpers instead of importing packages directly (e.g. `generateUuid` from `platform/common/uuid` instead of the `uuid` package).
- User-facing strings must go through constants in `src/platform/common/utils/localize.ts`, not inline literals.
- Separate third-party imports from local imports; add a blank line after const groups and before return statements.

## Deepnote-Specific Invariants

These aren't derivable from reading a single file — they're constraints that span the serializer and its callers:

- Snapshot mode must not persist execution-time metadata (e.g. `contentHash`); doing so causes false-dirty state. Track it in memory instead.
- `DeepnoteNotebookSerializer.detectContentChanges` must compare notebook-level fields (`name`, `executionMode`, `isModule`, `workingDirectory`) and detect removed notebooks, not just block-level diffs.

## Best Practices

### Resource Cleanup

Always dispose `CancellationTokenSource` - never create one inline without storing/disposing it. Use try/finally:

```typescript
const cts = new CancellationTokenSource();
try {
  await fn(cts.token);
} finally {
  cts.dispose();
}
```

Use real cancellation tokens tied to lifecycle events (e.g. notebook close, cell cancel) instead of fake/never-cancelled tokens.

### DRY

Extract duplicate logic into helper methods to prevent drift — e.g. when similar setup logic (placeholder controllers, interpreter validation) appears in multiple places, consolidate it.

### Magic Numbers

Extract magic numbers (retry counts, delays, timeouts) as named constants near the top of the module.

### Error Handling

- Use per-iteration error handling in loops - wrap each iteration in try/catch so one failure doesn't stop the rest.
- Handle `withProgress` cancellation gracefully - it throws when the user cancels, so wrap in try/catch and return an appropriate value.

### State Validation

- Verify state after async setup - methods can return early without throwing, so check that the expected state was actually created.
- Validate cached state before early returns - before returning "already configured," confirm the cached state is still valid (e.g. interpreter paths match, controllers aren't stale).

## Common Tasks

### Adding Tests

1. Create a `.unit.test.ts` file next to the source file.
2. Group related tests with Mocha `describe()`/`it()`.
3. Build and run: `npm run compile-tsc && npm test`.

### Fixing Lint or Format Issues

1. `npm run lint` / `npm run format` to see issues.
2. `npm run lint-fix` / `npm run format-fix` to autofix most of them.
3. Fix the rest manually, following the linter's suggestions.

### Fixing Type Errors

1. `npm run typecheck` to see all errors.
2. Add proper type annotations, use type guards for conditional access, and ensure function signatures match implementations.

## File Structure Conventions

- Source code: `src/`
- Tests: colocated with source as `*.unit.test.ts` (unit), `*.vscode.test*.ts` under `src/test/` (integration), or under `test/e2e/` (end-to-end)
- Reference docs for agents and contributors: `specs/`
- Build output: `out/` (compiled TS) and `dist/`/bundled output from esbuild (gitignored)
