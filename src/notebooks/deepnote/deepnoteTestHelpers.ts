import { NotebookCell, NotebookCellKind, NotebookCellOutput, NotebookDocument, TextDocument, Uri } from 'vscode';

import { generateUuid } from '../../platform/common/uuid';

/**
 * Options for creating a mock notebook cell.
 */
export interface CreateMockCellOptions {
    kind?: NotebookCellKind;
    languageId?: string;
    text?: string;
    metadata?: Record<string, unknown>;
    outputs?: NotebookCellOutput[];
    notebookType?: string;
    notebookUri?: Uri;
    notebookMetadata?: Record<string, unknown>;
    index?: number;
}

/**
 * Options for creating a mock notebook output.
 */
export interface CreateMockOutputOptions {
    mime?: string;
    data?: Uint8Array;
    metadata?: unknown;
}

/**
 * Options for creating a mock notebook document.
 */
export interface CreateMockNotebookOptions {
    notebookType?: string;
    uri?: Uri;
    metadata?: Record<string, unknown>;
}

/**
 * Creates a mock NotebookDocument for testing.
 *
 * @param options - Configuration options for the mock notebook
 * @returns A mock NotebookDocument
 */
export function createMockNotebook(options?: CreateMockNotebookOptions): NotebookDocument {
    const { notebookType = 'deepnote', uri = Uri.file('/test/notebook.deepnote'), metadata = {} } = options ?? {};

    return {
        uri,
        notebookType,
        metadata,
        cellCount: 0,
        cellAt: () => ({}) as NotebookCell,
        getCells: () => [],
        version: 1,
        isDirty: false,
        isUntitled: false,
        isClosed: false,
        save: async () => true
    } satisfies NotebookDocument;
}

/**
 * Creates a mock NotebookCellOutput for testing.
 *
 * @param options - Configuration options for the mock output
 * @returns A mock NotebookCellOutput
 */
export function createMockOutput(options?: CreateMockOutputOptions): NotebookCellOutput {
    const { mime = 'text/plain', data = new Uint8Array(), metadata = undefined } = options ?? {};

    return {
        id: generateUuid(),
        items: [{ mime, data }],
        metadata
    } as NotebookCellOutput;
}

/**
 * Creates a mock NotebookCell for testing.
 *
 * This is a configurable mock that covers all the use cases across the Deepnote test files:
 * - Full TextDocument mock with all properties
 * - Configurable cell kind, language, text content, and metadata
 * - Configurable notebook type, URI, and metadata
 *
 * @param options - Configuration options for the mock cell
 * @returns A mock NotebookCell
 */
export function createMockCell(options?: CreateMockCellOptions): NotebookCell {
    const opts = options ?? {};
    const {
        kind = NotebookCellKind.Code,
        languageId = 'python',
        text = '',
        outputs = [],
        notebookType = 'deepnote',
        notebookUri = Uri.file('/test/notebook.deepnote'),
        index = 0
    } = opts;

    // Preserve explicit undefined for metadata fields
    const metadata = Object.prototype.hasOwnProperty.call(opts, 'metadata') ? opts.metadata : {};
    const notebookMetadata = Object.prototype.hasOwnProperty.call(opts, 'notebookMetadata')
        ? opts.notebookMetadata
        : {};

    const notebook = createMockNotebook({
        notebookType,
        uri: notebookUri,
        metadata: notebookMetadata
    });

    const cellPath = `${notebookUri.path}#cell${index}`;

    const document = {
        uri: Uri.file(cellPath),
        fileName: cellPath,
        isUntitled: false,
        languageId,
        version: 1,
        isDirty: false,
        isClosed: false,
        getText: () => text,
        save: async () => true,
        eol: 1,
        lineCount: 1,
        lineAt: () => ({ text: '' }) as unknown,
        offsetAt: () => 0,
        positionAt: () => ({}) as unknown,
        validateRange: () => ({}) as unknown,
        validatePosition: () => ({}) as unknown,
        getWordRangeAtPosition: () => undefined,
        encoding: 'utf-8'
    } as unknown as TextDocument;

    return {
        index,
        notebook,
        kind,
        document,
        metadata,
        outputs,
        executionSummary: undefined
    } as unknown as NotebookCell;
}
