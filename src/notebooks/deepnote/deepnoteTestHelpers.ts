import { DeepnoteFile, serializeDeepnoteFile } from '@deepnote/blocks';
import {
    NotebookCell,
    NotebookCellKind,
    NotebookCellOutput,
    NotebookDocument,
    TextDocument,
    Uri,
    WorkspaceFolder
} from 'vscode';

import { generateUuid } from '../../platform/common/uuid';

type DeepnoteProjectData = DeepnoteFile['project'];
type DeepnoteNotebookData = DeepnoteProjectData['notebooks'][number];
type DeepnoteBlockData = DeepnoteNotebookData['blocks'][number];
type DeepnoteCodeBlock = Extract<DeepnoteBlockData, { type: 'code' }>;

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
        metadata
    } as NotebookDocument;
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
        getWordRangeAtPosition: () => undefined
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

/** A Deepnote code block (whole-file YAML shape); override any field. */
export function createDeepnoteBlock(overrides: Partial<DeepnoteCodeBlock> = {}): DeepnoteCodeBlock {
    return { id: 'block-1', type: 'code', blockGroup: 'g', sortingKey: 'a0', content: '', metadata: {}, ...overrides };
}

/** A Deepnote notebook (no blocks by default); override any field. */
export function createDeepnoteNotebook(overrides: Partial<DeepnoteNotebookData> = {}): DeepnoteNotebookData {
    return { id: 'notebook-1', name: 'Notebook', blocks: [], ...overrides };
}

/** A Deepnote project (one empty notebook by default); override any field. */
export function createDeepnoteProject(overrides: Partial<DeepnoteProjectData> = {}): DeepnoteProjectData {
    return { id: 'project-1', name: 'Test Project', notebooks: [createDeepnoteNotebook()], ...overrides };
}

/** A whole `.deepnote` file; override any field (build `project` with {@link createDeepnoteProject}). */
export function createDeepnoteFile(overrides: Partial<DeepnoteFile> = {}): DeepnoteFile {
    return {
        version: '1.0.0',
        metadata: { createdAt: '2020-01-01T00:00:00Z' },
        project: createDeepnoteProject(),
        ...overrides
    };
}

/** A VS Code {@link WorkspaceFolder} from a `Uri` (name = last path segment). */
export function createWorkspaceFolder(uri: Uri, index = 0): WorkspaceFolder {
    return { uri, name: uri.path.split('/').pop() ?? '', index };
}

/** The serialized YAML of a minimal `.deepnote` file carrying `projectId`, for stubbing a file read. */
export function serializeProjectFile(projectId: string): string {
    return serializeDeepnoteFile(createDeepnoteFile({ project: createDeepnoteProject({ id: projectId }) }));
}
