# Deepnote Blocks Architecture

This document explains how blocks work in the VSCode Deepnote extension. Blocks are the fundamental units of content in Deepnote notebooks, and understanding their lifecycle is crucial for working with this extension.

## Overview: Three Representations

Every Deepnote block exists in **three different representations** as it moves through the system:

1. **File Storage** - The block as stored in the `.deepnote` YAML file
2. **Editor Representation** - The block as a VS Code `NotebookCell` in the editor
3. **Kernel Execution** - The block converted to executable Python code

Understanding how data flows between these representations is key to working with this extension.

```
┌─────────────────┐
│  .deepnote File │
│  (YAML format)  │
└────────┬────────┘
         │ Deserialize (serializer)
         ▼
┌─────────────────┐
│   VS Code Cell  │
│  (with pocket)  │
└────────┬────────┘
         │ Execute (cellExecution)
         ▼
┌─────────────────┐
│  Python Code    │
│  (via blocks)   │
└─────────────────┘
```

## Representation 1: File Storage

Blocks are stored in `.deepnote` YAML files with this structure:

```yaml
project:
  notebooks:
    - id: 'notebook-uuid'
      name: 'My Notebook'
      blocks:
        - id: 'block-uuid'
          type: 'code'
          content: "df = pd.DataFrame({'a': [1, 2, 3]})\ndf"
          sortingKey: '001'
          blockGroup: 'default-group'
          executionCount: 1
          metadata:
            table_state_spec: '{"pageSize": 25, "pageIndex": 0}'
          outputs:
            - output_type: 'execute_result'
              execution_count: 1
              data:
                application/vnd.deepnote.dataframe.v3+json:
                  column_count: 1
                  row_count: 3
              metadata:
                table_state_spec: '{"pageSize": 25}'
```

Key fields in a block:
- `id` - Unique identifier
- `type` - Block type (code, text-cell-h1, markdown, etc.)
- `content` - The actual code or text content
- `sortingKey` - Controls block order
- `blockGroup` - Groups related blocks
- `metadata` - Arbitrary metadata (e.g., table state, input options)
- `outputs` - Execution outputs with their own metadata

**File:** `src/notebooks/deepnote/deepnoteTypes.ts:1-15`

The `DeepnoteBlock` type is defined in `@deepnote/blocks` package and includes all these fields.

## Representation 2: Editor Representation

When a `.deepnote` file is opened, blocks are converted to VS Code `NotebookCellData` objects. This happens in the **serializer** and **data converter**.

### The Conversion Process

**File:** `src/notebooks/deepnote/deepnoteDataConverter.ts:30-61`

```typescript
convertBlocksToCells(blocks: DeepnoteBlock[]): NotebookCellData[] {
    return blocks.map((block, index) => {
        const converter = this.registry.findConverter(block.type);
        const cell = converter.convertToCell(block);

        // Store Deepnote fields in metadata
        cell.metadata = {
            ...block.metadata,
            id: block.id,
            type: block.type,
            sortingKey: block.sortingKey,
            blockGroup: block.blockGroup,
            executionCount: block.executionCount,
            outputs: block.outputs
        };

        // Move Deepnote-specific fields to pocket
        addPocketToCellMetadata(cell);

        cell.outputs = this.transformOutputsForVsCode(block.outputs || [], ...);

        return cell;
    });
}
```

### The Pocket System

The **pocket** is a special metadata field (`__deepnotePocket`) that stores Deepnote-specific data that doesn't map to VS Code's notebook format. This allows round-trip conversion without data loss.

**File:** `src/notebooks/deepnote/pocket.ts:6-18`

```typescript
// These fields are moved into the pocket during editing
const deepnoteBlockSpecificFields = ['blockGroup', 'executionCount', 'sortingKey', 'type'];

export interface Pocket {
    blockGroup?: string;
    executionCount?: number;
    sortingKey?: string;
    type?: string;
}
```

**Important:** The `id` and `outputs` fields are **NOT** in the pocket:
- `id` stays at the top level of `cell.metadata` because it's needed at runtime for cell identification during execution
- `outputs` are managed natively by VS Code through `cell.outputs`, so there's no need to store them in the pocket

**File:** `src/notebooks/deepnote/pocket.ts:20-42`

The `addPocketToCellMetadata()` function:
1. Takes Deepnote-specific fields from cell metadata
2. Moves them into `cell.metadata.__deepnotePocket`
3. Leaves `id` at the top level for runtime access

Example of a cell after pocket conversion:

```typescript
{
    kind: NotebookCellKind.Code,
    value: "df = pd.DataFrame({'a': [1, 2, 3]})\ndf",
    languageId: 'python',
    metadata: {
        id: 'block-uuid',  // Stays at top level!
        table_state_spec: '{"pageSize": 25, "pageIndex": 0}',
        __deepnotePocket: {
            type: 'code',
            sortingKey: '001',
            blockGroup: 'default-group',
            executionCount: 1
        }
    },
    outputs: [...]  // Managed by VS Code, not in pocket
}
```

### Saving Back to File

When saving, the process reverses:

**File:** `src/notebooks/deepnote/deepnoteDataConverter.ts:69-88`

```typescript
convertCellsToBlocks(cells: NotebookCellData[]): DeepnoteBlock[] {
    return cells.map((cell, index) => {
        // Restore block from pocket
        const block = createBlockFromPocket(cell, index);

        const converter = this.registry.findConverter(block.type);
        converter.applyChangesToBlock(block, cell);

        return block;
    });
}
```

**File:** `src/notebooks/deepnote/pocket.ts:48-79`

The `createBlockFromPocket()` function:
1. Extracts the pocket from `cell.metadata.__deepnotePocket`
2. Gets `id` from top-level metadata
3. Removes pocket and Deepnote fields from metadata
4. Reconstructs a clean `DeepnoteBlock` with all fields in the right places
5. Outputs are handled separately via `cell.outputs` (not from pocket)

## Block Converters

Different block types need different conversion logic. The extension uses a **converter pattern** with specialized converters for each block type.

**File:** `src/notebooks/deepnote/converters/converterRegistry.ts`

Each converter implements:
- `canConvert(blockType)` - Returns true if it handles this type
- `convertToCell(block)` - Block → Cell
- `applyChangesToBlock(block, cell)` - Cell changes → Block

### Code Block Converter

**File:** `src/notebooks/deepnote/converters/codeBlockConverter.ts:6-24`

```typescript
export class CodeBlockConverter implements BlockConverter {
    canConvert(blockType: string): boolean {
        return blockType.toLowerCase() === 'code';
    }

    convertToCell(block: DeepnoteBlock): NotebookCellData {
        return new NotebookCellData(
            NotebookCellKind.Code,
            block.content || '',
            'python'
        );
    }

    applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        block.content = cell.value || '';
    }
}
```

Simple: just moves the content between block and cell.

### Text Block Converter

**File:** `src/notebooks/deepnote/converters/textBlockConverter.ts:7-51`

Text blocks (headings, bullets, todos, etc.) use the `@deepnote/blocks` package to convert between plain text and markdown:

```typescript
export class TextBlockConverter implements BlockConverter {
    protected static readonly textBlockTypes = [
        'text-cell-h1', 'text-cell-h2', 'text-cell-h3',
        'text-cell-p', 'text-cell-bullet', 'text-cell-todo',
        'text-cell-callout', 'separator'
    ];

    convertToCell(block: DeepnoteBlock): NotebookCellData {
        // Convert Deepnote text block to markdown for VS Code
        const markdown = createMarkdown(block);
        return new NotebookCellData(NotebookCellKind.Markup, markdown, 'markdown');
    }

    applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        // Convert markdown back to plain text for Deepnote
        block.content = cell.value || '';
        const textValue = stripMarkdown(block);
        block.content = textValue;
    }
}
```

This is crucial: **text blocks are stored as plain text in .deepnote files but displayed as markdown in VS Code**.

## Representation 3: Kernel Execution

When a cell is executed, it's converted back to a `DeepnoteBlock` and then transformed into executable Python code.

**File:** `src/kernels/execution/cellExecution.ts:411-423`

```typescript
private async execute(code: string, session: IKernelSession) {
    // Convert NotebookCell to Deepnote block
    const cellData = {
        kind: this.cell.kind,
        value: this.cell.document.getText(),
        languageId: this.cell.document.languageId,
        metadata: this.cell.metadata,
        outputs: [...(this.cell.outputs || [])]
    };
    const deepnoteBlock = createBlockFromPocket(cellData, this.cell.index);

    // Use createPythonCode to generate executable code
    code = createPythonCode(deepnoteBlock);

    // Send to kernel...
}
```

### The `createPythonCode()` Function

**File:** `node_modules/@deepnote/blocks/dist/index.d.ts:85-87`

```typescript
declare function createPythonCode(
    block: DeepnoteBlock,
    executionContext?: ButtonExecutionContext
): string;
```

This function from the `@deepnote/blocks` package converts a block into executable Python code. It handles:
- Regular code blocks - returns content as-is
- Input blocks - generates code to create variables based on metadata
- Chart blocks - generates plotting code
- SQL blocks - generates code to run queries
- Button blocks - generates callback code

The key insight: **Different block types generate different Python code**, even though they all start from the same `DeepnoteBlock` structure.

## Metadata Flow for Output Rendering

One of the most important features is how block metadata flows through to outputs so custom renderers can use it.

### Generating Outputs with Metadata

**File:** `src/kernels/execution/helpers.ts:188-217`

When execution produces an output, we attach metadata:

```typescript
function getOutputMetadata(
    output: nbformat.IOutput,
    cellId: string | undefined,
    cellIndex: number,
    blockMetadata: Record<string, unknown> | undefined
): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};

    if (cellId) {
        metadata.cellId = cellId;
    }

    // Merge block metadata (contains table_state_spec, etc.)
    if (blockMetadata) {
        Object.assign(metadata, blockMetadata);
    }

    metadata.cellIndex = cellIndex;

    // For execute_result/display_data, add execution count and merge output metadata
    if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
        metadata.executionCount = output.execution_count;

        // Output metadata wins conflicts (merged last)
        if (output.metadata) {
            Object.assign(metadata, output.metadata);
        }
    }

    return metadata;
}
```

Merge order is critical:
1. `cellId` (from block)
2. `blockMetadata` (from block.metadata - includes table_state_spec)
3. `cellIndex` (current position)
4. `executionCount` (from output)
5. `output.metadata` (wins conflicts)

### Custom Renderers

Custom renderers receive this metadata and use it to display outputs correctly.

**File:** `src/webviews/webview-side/dataframe-renderer/index.ts:10-45`

The dataframe renderer receives metadata:

```typescript
interface Metadata {
    cellId?: string;
    cellIndex?: number;
    executionCount: number;
    metadata?: DataframeMetadata;  // Contains table_state_spec!
    outputType: string;
}

export const activate: ActivationFunction = (context) => {
    return {
        renderOutputItem(outputItem: OutputItem, element: HTMLElement) {
            const data = outputItem.json();
            const metadata = outputItem.metadata as Metadata | undefined;

            const dataFrameMetadata = metadata?.metadata as DataframeMetadata | undefined;
            const cellId = metadata?.cellId;
            const cellIndex = metadata?.cellIndex;

            ReactDOM.render(
                React.createElement(DataframeRenderer, {
                    context,
                    data,
                    metadata: dataFrameMetadata,  // Has table_state_spec
                    cellId,
                    cellIndex
                }),
                root
            );
        }
    };
};
```

**File:** `src/webviews/webview-side/dataframe-renderer/DataframeRenderer.tsx:68-70`

The renderer uses `table_state_spec` to initialize pagination:

```typescript
const tableState = useMemo((): TableState =>
    JSON.parse(metadata?.table_state_spec || '{}'),
    [metadata]
);
const [pageSize, setPageSize] = useState(tableState.pageSize || 10);
const [pageIndex, setPageIndex] = useState(tableState.pageIndex || 0);
```

### Interactive Updates

When the user changes page size or navigates pages, the renderer sends a message back to the extension:

**File:** `src/webviews/webview-side/dataframe-renderer/DataframeRenderer.tsx:82-98`

```typescript
const handlePageSizeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const newPageSize = Number(event.target.value);
    setPageSize(newPageSize);

    context.postMessage?.({
        command: 'selectPageSize',
        cellId,
        size: newPageSize
    });
};
```

**File:** `src/webviews/extension-side/dataframe/dataframeController.ts:88-143`

The controller receives the message and re-executes the cell with updated metadata:

```typescript
private async handleSelectPageSize(editor: NotebookEditor, message: SelectPageSizeCommand) {
    const cell = editor.notebook.getCells().find(c => c.metadata.id === message.cellId);

    // Update table state in cell metadata
    const updatedTableState = {
        ...cell.metadata.deepnote_table_state,
        pageSize: message.size
    };

    const edit = NotebookEdit.updateCellMetadata(cell.index, {
        ...cell.metadata,
        deepnote_table_state: updatedTableState
    });

    await workspace.applyEdit(edit);

    // Re-execute to apply new page size
    await commands.executeCommand('notebook.cell.execute', {
        ranges: [{ start: cell.index, end: cell.index + 1 }]
    });
}
```

This creates a loop:
1. Block metadata → Cell metadata → Output metadata → Renderer
2. User interaction → Controller → Cell metadata update → Re-execution
3. Back to step 1

## Complete Example: Big Number Block Lifecycle

Let's walk through the complete lifecycle of a "big number block" - a Deepnote block type that displays a large numeric value with optional comparison.

### 1. File Storage

In the `.deepnote` file:

```yaml
blocks:
  - id: 'big-number-block-uuid'
    type: 'big-number'
    content: ''
    sortingKey: '001'
    blockGroup: 'default-group'
    metadata:
      deepnote_big_number_title: 'Customers'
      deepnote_big_number_value: 'customers'
      deepnote_big_number_format: 'number'
      deepnote_big_number_comparison_type: ''
      deepnote_big_number_comparison_title: ''
      deepnote_big_number_comparison_value: ''
      deepnote_big_number_comparison_format: ''
      deepnote_big_number_comparison_enabled: false
```

The metadata contains all the big number configuration.

### 2. Editor Representation

When opened in VS Code, the block becomes a cell with JSON content showing the configuration:

```typescript
{
    kind: NotebookCellKind.Code,
    value: JSON.stringify({
        title: 'Customers',
        value: 'customers',
        format: 'number',
        comparison_type: '',
        comparison_title: '',
        comparison_value: '',
        comparison_format: '',
        comparison_enabled: false
    }, null, 2),
    languageId: 'python',
    metadata: {
        id: 'big-number-block-uuid',
        deepnote_big_number_title: 'Customers',
        deepnote_big_number_value: 'customers',
        deepnote_big_number_format: 'number',
        deepnote_big_number_comparison_type: '',
        deepnote_big_number_comparison_title: '',
        deepnote_big_number_comparison_value: '',
        deepnote_big_number_comparison_format: '',
        deepnote_big_number_comparison_enabled: false,
        __deepnotePocket: {
            type: 'big-number',
            sortingKey: '001',
            blockGroup: 'default-group'
        }
    }
}
```

**The user sees JSON content** displaying the block's configuration, not an empty cell. This provides visibility into what the block represents while preserving all configuration in metadata.

### 3. Kernel Execution

When executed, `createPythonCode(deepnoteBlock)` generates Python code based on the metadata:

```python
# Generated from big number block metadata
# Evaluates the 'customers' variable and displays it
_deepnote_big_number_result = _dntk.execute_big_number({
    "id": 'big-number-block-uuid',
    "deepnote_big_number_title": 'Customers',
    "deepnote_big_number_value": 'customers',
    "deepnote_big_number_format": 'number',
    "deepnote_big_number_comparison_type": '',
    "deepnote_big_number_comparison_title": '',
    "deepnote_big_number_comparison_value": '',
    "deepnote_big_number_comparison_format": '',
    "deepnote_big_number_comparison_enabled": false,
})

_deepnote_big_number_result
```

The block's metadata is used to generate Python code that evaluates the variable and creates a display output!

### 4. Output Rendering

When executed, the output includes block metadata for the custom renderer:

```typescript
{
    items: [
        NotebookCellOutputItem.json({
            title: "Customers",
            value: 1523,
            format: "number"
        }, 'application/vnd.deepnote.big-number')
    ],
    metadata: {
        cellId: 'big-number-block-uuid',
        cellIndex: 0,
        deepnote_big_number_title: 'Customers',
        deepnote_big_number_value: 'customers',
        deepnote_big_number_format: 'number',
        deepnote_big_number_comparison_enabled: false
    }
}
```

A custom renderer uses this metadata to display a large, formatted number with the title "Customers" showing "1,523".

### 5. Saving Changes

When the user saves the notebook:

1. `createBlockFromPocket()` extracts fields from the pocket
2. The converter's `applyChangesToBlock()` updates the block content
3. Block metadata remains unchanged
4. The serializer writes back to the `.deepnote` file

All the input configuration survives the round trip!

## Key Takeaways

1. **Three Representations**: Blocks exist as YAML in files, as cells in the editor, and as Python code in the kernel.

2. **The Pocket**: Deepnote-specific fields (blockGroup, executionCount, sortingKey, type) are stored in `__deepnotePocket` during editing to keep cell metadata clean. The `id` stays at the top level for runtime access, and `outputs` are managed natively by VS Code.

3. **Converters**: Different block types have specialized converters. Text blocks are stored as plain text but displayed as markdown.

4. **Code Generation**: `createPythonCode()` from `@deepnote/blocks` transforms blocks into executable Python based on their type and metadata.

5. **Metadata Flow**: Block metadata flows through to outputs (cellId → blockMetadata → cellIndex → executionCount → output.metadata) so custom renderers can use it.

6. **Round-Trip Preservation**: The pocket system and converters ensure no data is lost when converting between representations.

7. **Interactive Outputs**: Custom renderers can send messages back to update cell metadata and trigger re-execution, creating interactive experiences.

## Related Files

- **Serialization**: `src/notebooks/deepnote/deepnoteSerializer.ts`
- **Data Conversion**: `src/notebooks/deepnote/deepnoteDataConverter.ts`
- **Pocket System**: `src/notebooks/deepnote/pocket.ts`
- **Converters**: `src/notebooks/deepnote/converters/`
- **Execution**: `src/kernels/execution/cellExecution.ts`
- **Metadata Handling**: `src/kernels/execution/helpers.ts`
- **Custom Renderers**: `src/webviews/webview-side/dataframe-renderer/`
- **Renderer Controllers**: `src/webviews/extension-side/dataframe/`

## Adding Support for New Block Types

To add support for a new Deepnote block type:

1. **Create a converter** in `src/notebooks/deepnote/converters/` implementing `BlockConverter`
2. **Register it** in `DeepnoteDataConverter` constructor
3. **Implement conversion logic**:
   - `convertToCell()` - How to display in VS Code
   - `applyChangesToBlock()` - How to save changes back
4. **Ensure metadata preservation** - Store configuration in `block.metadata`
5. **The `@deepnote/blocks` package** handles code generation - no changes needed unless you're modifying that package

The architecture is designed to make adding new block types straightforward while preserving all data through the entire lifecycle.
