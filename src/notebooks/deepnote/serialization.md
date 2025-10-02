# Deepnote Serialization Architecture

This document explains how Deepnote notebooks are serialized and deserialized between the Deepnote YAML format and VS Code's notebook format.

## Overview

The serialization system converts Deepnote blocks to VS Code cells and vice versa while preserving all Deepnote-specific metadata. This is accomplished through a converter pattern and a "pocket" system for storing extra data.

## Key Concepts

### The Pocket System

The **pocket** is a special metadata field (`__deepnotePocket`) that stores Deepnote-specific block information that doesn't have a direct equivalent in VS Code's notebook format. This ensures perfect round-trip conversion without data loss.

Pocket fields include:
- `id`: Deepnote block ID
- `type`: Deepnote block type (e.g., 'code', 'markdown', 'text-cell-h1')
- `sortingKey`: Deepnote sorting key for block ordering
- `executionCount`: Execution count for code blocks
- `outputs`: Original Deepnote outputs (for round-trip preservation)
- `blockGroup`: Deepnote block group identifier

### The Converter Pattern

Each Deepnote block type has a corresponding converter that knows how to:
1. Convert a Deepnote block to a VS Code cell (`convertToCell`)
2. Apply changes from a VS Code cell back to a Deepnote block (`applyChangesToBlock`)

Converters are registered in a `ConverterRegistry` and retrieved based on block type.

## Serialization Flow (Deepnote → VS Code)

When opening a Deepnote notebook in VS Code:

```text
Deepnote YAML File
    ↓
Parse YAML (js-yaml)
    ↓
Extract blocks from selected notebook
    ↓
For each block:
    1. Find converter for block.type
    2. converter.convertToCell(block) → creates VS Code cell
    3. Store Deepnote fields in cell.metadata
    4. addPocketToCellMetadata(cell) → moves fields to __deepnotePocket
    5. transformOutputsForVsCode(block.outputs) → convert outputs
    ↓
VS Code NotebookData with cells
```

**Key functions:**
- `deepnoteDataConverter.ts::convertBlocksToCells(blocks)` - Main entry point
- `pocket.ts::addPocketToCellMetadata(cell)` - Creates the pocket
- `deepnoteDataConverter.ts::transformOutputsForVsCode(outputs)` - Converts outputs

## Deserialization Flow (VS Code → Deepnote)

When saving a notebook in VS Code:

```text
VS Code NotebookData with cells
    ↓
For each cell:
    1. createBlockFromPocket(cell, index) → creates base block
    2. Find converter for block.type
    3. converter.applyChangesToBlock(block, cell) → updates content
    4. If needed: transformOutputsForDeepnote(cell.outputs) → convert new outputs
    ↓
Array of Deepnote blocks
    ↓
Update project YAML structure
    ↓
Serialize to YAML (js-yaml)
    ↓
Deepnote YAML File
```

**Key functions:**
- `deepnoteDataConverter.ts::convertCellsToBlocks(cells)` - Main entry point
- `pocket.ts::createBlockFromPocket(cell, index)` - Extracts block from pocket
- `deepnoteDataConverter.ts::transformOutputsForDeepnote(outputs)` - Converts outputs

## Adding Support for a New Block Type

Follow these steps to add support for a new Deepnote block type:

### 1. Create a Converter Class

Create a new file in `src/notebooks/deepnote/converters/`:

```typescript
// src/notebooks/deepnote/converters/myBlockConverter.ts
import { NotebookCellData, NotebookCellKind } from 'vscode';
import type { BlockConverter } from './blockConverter';
import type { DeepnoteBlock } from '../deepnoteTypes';

export class MyBlockConverter implements BlockConverter {
    // Block types this converter handles
    get blockTypes(): string[] {
        return ['my-block-type'];
    }

    // Convert Deepnote block to VS Code cell
    convertToCell(block: DeepnoteBlock): NotebookCellData {
        // Choose appropriate cell kind
        const cell = new NotebookCellData(
            NotebookCellKind.Markup,  // or NotebookCellKind.Code
            block.content || '',
            'markdown'  // or 'python', etc.
        );

        return cell;
    }

    // Apply VS Code cell changes back to Deepnote block
    applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        // Update the block content from the cell
        block.content = cell.value || '';

        // Apply any transformations needed
        // (e.g., strip prefixes, convert formats, etc.)
    }
}
```

### 2. Register the Converter

Add your converter to the registry in `deepnoteDataConverter.ts`:

```typescript
import { MyBlockConverter } from './converters/myBlockConverter';

export class DeepnoteDataConverter {
    private readonly registry = new ConverterRegistry();

    constructor() {
        this.registry.register(new CodeBlockConverter());
        this.registry.register(new TextBlockConverter());
        this.registry.register(new MarkdownBlockConverter());
        this.registry.register(new MyBlockConverter());  // Add this line
    }
    // ...
}
```

### 3. Create Tests

Create comprehensive tests in `src/notebooks/deepnote/converters/myBlockConverter.unit.test.ts`:

```typescript
import { assert } from 'chai';
import { NotebookCellKind } from 'vscode';
import { MyBlockConverter } from './myBlockConverter';
import type { DeepnoteBlock } from '../deepnoteTypes';

suite('MyBlockConverter', () => {
    let converter: MyBlockConverter;

    setup(() => {
        converter = new MyBlockConverter();
    });

    suite('convertToCell', () => {
        test('converts my-block-type to cell', () => {
            const block: DeepnoteBlock = {
                id: 'block1',
                type: 'my-block-type',
                content: 'Hello World',
                sortingKey: 'a0'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Markup);
            assert.strictEqual(cell.value, 'Hello World');
            assert.strictEqual(cell.languageId, 'markdown');
        });
    });

    suite('applyChangesToBlock', () => {
        test('applies cell changes to block', () => {
            const block: DeepnoteBlock = {
                id: 'block1',
                type: 'my-block-type',
                content: '',
                sortingKey: 'a0'
            };

            const cell = new NotebookCellData(
                NotebookCellKind.Markup,
                'Updated content',
                'markdown'
            );

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'Updated content');
        });
    });
});
```

### 4. Add Round-Trip Tests

Ensure your converter preserves data correctly in `deepnoteDataConverter.unit.test.ts`:

```typescript
test('my-block-type round-trips correctly', () => {
    const originalBlock: DeepnoteBlock = {
        id: 'block1',
        type: 'my-block-type',
        content: 'Test content',
        sortingKey: 'a0',
        metadata: { custom: 'data' }
    };

    const cell = converter.convertBlocksToCells([originalBlock])[0];
    const roundTripBlock = converter.convertCellsToBlocks([cell])[0];

    assert.deepStrictEqual(roundTripBlock, originalBlock);
});
```

## Important Guidelines

### DO:

- ✅ Use the pocket system for Deepnote-specific fields
- ✅ Preserve all block metadata during conversion
- ✅ Test round-trip conversion (blocks → cells → blocks)
- ✅ Handle both empty and undefined fields correctly
- ✅ Use `assert.deepStrictEqual()` for object comparisons in tests

### DON'T:

- ❌ Store Deepnote-specific data directly in cell metadata (use the pocket)
- ❌ Modify the pocket in converters (it's managed automatically)
- ❌ Assume all optional fields exist (check for undefined)
- ❌ Convert undefined to empty arrays/objects (preserve exact structure)

## Example: TextBlockConverter

Here's a real example showing header transformations:

```typescript
export class TextBlockConverter implements BlockConverter {
    get blockTypes(): string[] {
        return ['text-cell-h1', 'text-cell-h2', 'text-cell-h3', 'text-cell'];
    }

    convertToCell(block: DeepnoteBlock): NotebookCellData {
        let content = block.content || '';

        // Add markdown prefix based on block type
        if (block.type === 'text-cell-h1') {
            content = `# ${content}`;
        } else if (block.type === 'text-cell-h2') {
            content = `## ${content}`;
        } else if (block.type === 'text-cell-h3') {
            content = `### ${content}`;
        }

        return new NotebookCellData(NotebookCellKind.Markup, content, 'markdown');
    }

    applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        let value = cell.value || '';

        // Strip markdown prefix when converting back
        if (block.type === 'text-cell-h1') {
            value = value.replace(/^#\s+/, '');
        } else if (block.type === 'text-cell-h2') {
            value = value.replace(/^##\s+/, '');
        } else if (block.type === 'text-cell-h3') {
            value = value.replace(/^###\s+/, '');
        }

        block.content = value;
    }
}
```

This example shows:
1. Supporting multiple block types in one converter
2. Transforming content during conversion (adding markdown prefixes)
3. Reversing the transformation when converting back (stripping prefixes)
4. Preserving the original block type through the pocket system

## Testing Your Converter

Run the tests to ensure everything works:

```bash
# Run all tests
npm test

# Run only your converter tests
npx mocha --config ./build/.mocha.unittests.js.json ./out/notebooks/deepnote/converters/myBlockConverter.unit.test.js
```

Make sure:
1. All tests pass
2. Round-trip conversion preserves all data
3. The real Deepnote notebook test still passes
