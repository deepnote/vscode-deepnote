# VSCode Deepnote Extension Architecture

This extension adds support for Deepnote notebooks in Visual Studio Code. Deepnote is a collaborative data science notebook platform, and this extension allows users to open, edit, and manage Deepnote project files (`.deepnote` files) directly within VS Code.

## Key Components

### 1. Notebook Serializer (`deepnoteSerializer.ts`)

The core component responsible for converting between Deepnote's YAML format and VS Code's notebook format.

**Responsibilities:**

-   **Deserialization**: Converts Deepnote YAML files into VS Code NotebookData format
-   **Serialization**: Converts VS Code notebook changes back to Deepnote YAML format
-   **State Management**: Maintains original project data for accurate serialization

**Key Methods:**

-   `deserializeNotebook()`: Parses YAML, converts blocks to cells
-   `serializeNotebook()`: Converts cells back to blocks, updates YAML  
-   `findCurrentNotebookId()`: Determines which notebook to deserialize using manager state

### 2. Data Converter (`deepnoteDataConverter.ts`)

Handles the transformation between Deepnote blocks and VS Code notebook cells.

**Responsibilities:**

-   Convert Deepnote blocks (code, markdown, SQL, etc.) to VS Code cells
-   Convert VS Code cells back to Deepnote blocks
-   Preserve block metadata and outputs during conversion

**Supported Block Types:**

-   Code blocks (Python, R, JavaScript, etc.)
-   Markdown blocks

### 3. Notebook Manager (`deepnoteNotebookManager.ts`)

Manages the state of Deepnote projects and notebook selections.

**Responsibilities:**

-   Store original project data for serialization
-   Track which notebook is selected for each project
-   Maintain project-to-notebook mapping using project IDs

**Key Features:**

-   In-memory caching of project data
-   Project-ID based notebook selection tracking
-   Support for multiple notebooks per project

**Key Methods:**

-   `getTheSelectedNotebookForAProject()`: Retrieves selected notebook ID for a project
-   `selectNotebookForProject()`: Associates a notebook ID with a project ID
-   `storeOriginalProject()`: Caches project data and sets current notebook

### 4. Explorer View (`deepnoteExplorerView.ts`)

Provides the sidebar UI for browsing and opening Deepnote notebooks.

**Responsibilities:**

-   Create and manage the tree view in VS Code's sidebar
-   Handle user interactions (clicking on notebooks/files)
-   Register commands for notebook operations

**Commands:**

-   `deepnote.refreshExplorer`: Refresh the file tree
-   `deepnote.openNotebook`: Open a specific notebook
-   `deepnote.openFile`: Open the raw .deepnote file
-   `deepnote.revealInExplorer`: Show active notebook info

### 5. Tree Data Provider (`deepnoteTreeDataProvider.ts`)

Implements VS Code's TreeDataProvider interface for the sidebar view.

**Responsibilities:**

-   Scan workspace for `.deepnote` files
-   Parse project files to extract notebook information
-   Provide tree structure for the explorer view
-   Watch for file system changes

**Features:**

-   Automatic workspace scanning
-   File system watching for real-time updates
-   Caching for performance optimization

### 6. Activation Service (`deepnoteActivationService.ts`)

Entry point for the Deepnote functionality within the extension.

**Responsibilities:**

-   Register the notebook serializer with VS Code
-   Initialize the explorer view
-   Set up extension lifecycle

## Data Flow

### Opening a Notebook

1. **User Action**: User clicks on a notebook in the sidebar
2. **Explorer View**: Handles the click, stores notebook selection using project ID
3. **Notebook Manager**: Associates the notebook ID with the project ID
4. **VS Code**: Opens the document using the base file URI and calls `deserializeNotebook()`
5. **Serializer**:
    - Uses `findCurrentNotebookId()` to determine which notebook to load
    - Reads the YAML file and finds the selected notebook  
    - Converts blocks to cells using the Data Converter
6. **Display**: VS Code displays the notebook in the editor

### Saving Changes

1. **User Action**: User makes changes and saves (Ctrl+S)
2. **VS Code**: Calls the serializer's `serializeNotebook()` method
3. **Serializer**:
    - Retrieves original project data from Notebook Manager
    - Converts cells back to blocks using the Data Converter
    - Updates the YAML structure
    - Writes back to file
4. **File System**: Updates the `.deepnote` file

## File Format

### Deepnote YAML Structure

```yaml
version: 1.0
metadata:
    modifiedAt: '2024-01-01T00:00:00Z'
project:
    id: 'project-uuid'
    name: 'Project Name'
    notebooks:
        - id: 'notebook-uuid'
          name: 'Notebook Name'
          blocks:
              - id: 'block-uuid'
                type: 'code'
                source: "print('Hello')"
                outputs: []
```

### VS Code Notebook Format

```typescript
interface NotebookData {
    cells: NotebookCellData[];
    metadata: {
        deepnoteProjectId: string;
        deepnoteProjectName: string;
        deepnoteNotebookId: string;
        deepnoteNotebookName: string;
        deepnoteVersion: string;
    };
}
```

## Multi-Notebook Support

The extension supports opening multiple notebooks from the same `.deepnote` file:

1. **Project-Based Selection**: The Notebook Manager tracks which notebook is selected for each project
2. **State Management**: When opening a notebook, the manager stores the project-to-notebook mapping
3. **Fallback Detection**: The serializer can detect the current notebook from VS Code's active document context

## Technical Decisions

### Why YAML?

Deepnote uses YAML for its file format, which provides:

-   Human-readable structure
-   Support for complex nested data
-   Easy to read Git diffs

### Why Project-ID Based Selection?

-   Simpler than URI-based tracking - uses straightforward project ID mapping
-   The VS Code NotebookSerializer interface doesn't provide URI context during deserialization
-   Allows for consistent notebook selection regardless of how the document is opened
-   Manager-based approach centralizes state management and reduces complexity
