## Code Style & Organization

- Order method, fields and properties, first by accessibility and then by alphabetical order.
- Don't add the Microsoft copyright header to new files.
- Use `Uri.joinPath()` for constructing file paths to ensure platform-correct path separators (e.g., `Uri.joinPath(venvPath, 'share', 'jupyter', 'kernels')` instead of string concatenation with `/`)
- Follow established patterns, especially when importing new packages (e.g. instead of importing uuid directly, use the helper `import { generateUuid } from '../platform/common/uuid';`)

## Code conventions

- Always run `npx prettier` before committing

## Testing

- Unit tests use Mocha/Chai framework with `.unit.test.ts` extension
- Test files should be placed alongside the source files they test
- Run all tests: `npm test` or `npm run test:unittests`
- Run single test file: `npx mocha --config ./build/.mocha.unittests.js.json ./out/path/to/file.unit.test.js`
- Tests run against compiled JavaScript files in `out/` directory
- Use `assert.deepStrictEqual()` for object comparisons instead of checking individual properties

## Project Structure

- VSCode extension for Jupyter notebooks
- Uses dependency injection with inversify
- Follows separation of concerns pattern
- TypeScript codebase that compiles to `out/` directory

## Deepnote Integration

- Located in `src/notebooks/deepnote/`
- Refactored architecture:
  - `deepnoteTypes.ts` - Type definitions
  - `deepnoteNotebookManager.ts` - State management
  - `deepnoteNotebookSelector.ts` - UI selection logic
  - `deepnoteDataConverter.ts` - Data transformations
  - `deepnoteSerializer.ts` - Main serializer (orchestration)
  - `deepnoteActivationService.ts` - VSCode activation
- Whitespace is good for readability, add a blank line after const groups and before return statements
- Separate third-party and local file imports
- How the extension works is described in @specs/architecture.md

## Best Practices

### Resource Cleanup

- Always dispose `CancellationTokenSource` - never create inline without storing/disposing
- Use try/finally to ensure cleanup:
  ```typescript
  const cts = new CancellationTokenSource();
  try {
    await fn(cts.token);
  } finally {
    cts.dispose();
  }
  ```

### DRY Principle

- Extract duplicate logic into helper methods to prevent drift
- When similar logic appears in multiple places (e.g., placeholder controller setup, interpreter validation), consolidate it

### Magic Numbers

- Extract magic numbers (retry counts, delays, timeouts) as named constants near the top of the module

### Error Handling

- Use per-iteration error handling in loops - wrap each iteration in try/catch so one failure doesn't stop the rest
- Handle `withProgress` cancellation gracefully - it throws when user cancels, so wrap in try/catch and return appropriate value

### State Validation

- Verify state after async setup operations - methods can return early without throwing, so check expected state was created
- Validate cached state before early returns - before returning "already configured", verify the state is still valid (e.g., interpreter paths match, controllers aren't stale)

### Cancellation Tokens

- Use real cancellation tokens tied to lifecycle events instead of fake/never-cancelled tokens
- Create `CancellationTokenSource` tied to relevant events (e.g., notebook close, cell cancel)
