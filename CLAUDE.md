## Code Style & Organization
- Order method, fields and properties, first by accessibility and then by alphabetical order.
- Don't add the Microsoft copyright header to new files.

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