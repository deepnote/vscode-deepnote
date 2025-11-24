# Language Server Protocol in Deepnote Toolkit

## Overview

Deepnote Toolkit integrates the Language Server Protocol (LSP) to provide IDE-quality code intelligence in Jupyter notebooks. This document explains what LSP is, how it works, and how Deepnote implements it.

## What is LSP?

The Language Server Protocol solves a classic problem in developer tooling: the M×N complexity of supporting multiple languages across multiple editors.

### The Problem Before LSP

Traditionally, every code editor needed custom plugins for each programming language to provide features like autocomplete, error detection, and go-to-definition. With 10 editors and 10 languages, you'd need 100 separate implementations.

### The LSP Solution

LSP transforms this into an M+N model:

- Each **language** provides one language server that speaks a standard protocol
- Each **editor** provides one LSP client
- Any editor can work with any language server

This separation means language experts can focus on building great language servers, while editor developers can focus on great editing experiences.

## How LSP Works

### Architecture

The LSP architecture has three main components:

```text
┌─────────────────┐         JSON-RPC          ┌─────────────────┐
│                 │ ◄──────────────────────► │                 │
│  Editor/IDE     │    (WebSocket/stdio)     │ Language Server │
│  (LSP Client)   │                          │                 │
└─────────────────┘                          └─────────────────┘
       │                                              │
       │                                              │
       ▼                                              ▼
  Displays UI                              Analyzes code
  Handles input                            Provides intelligence
```

### Communication Flow

1. **Initialization**: Editor connects to the language server and negotiates capabilities
2. **Document Sync**: As you type, the editor sends incremental changes to the server
3. **Intelligence Requests**: Editor requests features like completion, hover info, or diagnostics
4. **Server Response**: Language server analyzes code and returns structured results
5. **UI Rendering**: Editor displays the results to the user

### Key Features Provided

- **Autocomplete**: Context-aware code suggestions
- **Diagnostics**: Real-time error detection without execution
- **Hover Information**: Documentation and type hints
- **Go to Definition**: Jump to symbol definitions
- **Find References**: Locate all usages of a symbol
- **Code Actions**: Quick fixes and refactoring suggestions
- **Symbol Rename**: Safely rename variables across files

## Deepnote's LSP Implementation

### How It Starts

When you run `deepnote-toolkit server`, the toolkit automatically starts multiple server processes:

```bash
deepnote-toolkit server
```

This single command launches:

1. **Jupyter Server** (default port 8888)
2. **Python LSP Server** (for Python code intelligence)
3. **SQL LSP Server** (for SQL block intelligence)
4. **Streamlit Server** (for interactive apps)

The LSP servers run as background processes—you don't need to start them manually or configure them separately.

### Where It Runs

The LSP server is a **separate process** that runs alongside your notebook environment:

```text
┌──────────────────────────────────────────────┐
│  Deepnote Toolkit Environment                │
│                                              │
│  ┌────────────┐  ┌──────────────┐           │
│  │  Jupyter   │  │  LSP Server  │           │
│  │  Server    │  │  (Python)    │           │
│  └────────────┘  └──────────────┘           │
│        │                  │                  │
│        │         ┌──────────────┐            │
│        │         │  LSP Server  │            │
│        │         │  (SQL)       │            │
│        │         └──────────────┘            │
│        │                  │                  │
└────────┼──────────────────┼──────────────────┘
         │                  │
         ▼                  ▼
    ┌────────────────────────────┐
    │   Editor/Extension         │
    │   (VS Code, JupyterLab)    │
    └────────────────────────────┘
```

This separation is crucial because:

- Heavy analysis work doesn't block the interactive notebook
- The language server can maintain state across multiple notebooks
- Crashes in one component don't affect others
- Multiple editors can connect to the same server instances

### What It Does

#### Core Functionality

The LSP server provides IDE-quality features that traditional notebooks lack:

#### Real-Time Analysis

- Parses your code without executing it
- Tracks imports, variable definitions, and function signatures
- Provides instant feedback on syntax errors and potential issues

#### Context-Aware Intelligence

- Understands your project structure
- Knows about imported libraries and their APIs
- Tracks variable types and usage patterns

#### Multi-Language Support

- Python blocks get Python-specific intelligence
- SQL blocks get SQL-specific intelligence
- Seamless switching between block types

#### The Notebook Challenge

Notebooks present unique challenges for LSP because they're not traditional files. Here's how Deepnote solves this:

#### Virtual Document Model

```python
# Cell 1
import pandas as pd

# Cell 2
df = pd.read_csv('data.csv')

# Cell 3
df.head()  # ← LSP knows about 'df' and 'pd' here
```

The LSP integration:

1. Creates a **virtual document** by combining all cells
2. Maintains proper order and context
3. Updates the virtual document as you edit cells
4. Maps results back to individual cells

This allows the language server to understand:

- Imports from earlier cells
- Variables defined in previous cells
- The overall execution context of your notebook

#### Cell Independence

Unlike execution (which can happen in any order), LSP analysis respects cell order in the notebook. This means you get accurate intelligence even if you haven't executed cells yet.

### Language Servers Used

Deepnote maintains forks of well-established LSP servers:

**python-lsp-server** (formerly python-language-server)

- Provides Python code intelligence
- Built on top of Jedi for static analysis
- Supports plugins for additional features (linting, formatting)

#### sql-language-server

- Provides SQL-specific intelligence
- Understands database schemas
- Offers query optimization suggestions

## Benefits for Users

### Immediate Feedback

Get error detection and warnings before running code, saving time in the development loop.

### Better Code Quality

Access to type information, documentation, and linting helps write more correct code from the start.

### Faster Development

Autocomplete and go-to-definition features reduce context switching and speed up coding.

### Consistent Experience

Whether in VS Code, JupyterLab, or Deepnote Cloud, you get the same intelligent features.

## Benefits for Developers

### Standard Protocol

LSP is an open standard, making it easy to understand and extend.

### Language Agnostic

The same infrastructure works for Python, R, SQL, and any language with an LSP server.

### Separation of Concerns

Language intelligence is separate from the editor, making both easier to develop and maintain.

### Community Ecosystem

Leverage existing LSP servers and contribute back to the community.

## Technical Details

### Communication Protocol

LSP uses JSON-RPC 2.0 for all communication. Messages have a simple structure:

**Request Example:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "textDocument/completion",
  "params": {
    "textDocument": { "uri": "file:///notebook.py" },
    "position": { "line": 10, "character": 5 }
  }
}
```

**Response Example:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "items": [
      { "label": "read_csv", "kind": 3 },
      { "label": "read_json", "kind": 3 }
    ]
  }
}
```

### Process Management

The Deepnote Toolkit handles all process management automatically:

- Starts LSP servers on toolkit initialization
- Manages server lifecycle (start, restart, shutdown)
- Handles server crashes and reconnection
- Routes messages between editors and servers

### Configuration

LSP servers can be configured through:

- Jupyter server configuration files
- Environment variables
- Runtime configuration updates

The toolkit provides sensible defaults, so most users never need to configure anything.

## Comparison with Kernel-Based Completion

Traditional Jupyter notebooks use the kernel for code completion. Here's how LSP differs:

| Feature           | Kernel-Based                           | LSP-Based               |
| ----------------- | -------------------------------------- | ----------------------- |
| Speed             | Slower (requires kernel communication) | Faster (local analysis) |
| Scope             | Only executed code                     | All code in notebook    |
| Static Analysis   | No                                     | Yes                     |
| Error Detection   | Runtime only                           | Pre-execution           |
| Offline Support   | Requires running kernel                | Works without execution |
| Language Features | Limited                                | Comprehensive           |

LSP complements rather than replaces the kernel—you get the best of both worlds.

## VS Code Extension Integration

The Deepnote VS Code extension provides seamless LSP integration for `.deepnote` notebook files, bringing IDE-quality code intelligence directly into VS Code.

### Architecture

The extension integrates with LSP through a dedicated client manager:

```text
┌─────────────────────────────────────────────────────┐
│  VS Code Extension                                  │
│                                                     │
│  ┌──────────────────────────────────────────────┐  │
│  │  DeepnoteKernelAutoSelector                  │  │
│  │  (Manages kernel lifecycle)                  │  │
│  └────────────────┬─────────────────────────────┘  │
│                   │                                 │
│                   ▼                                 │
│  ┌──────────────────────────────────────────────┐  │
│  │  DeepnoteLspClientManager                    │  │
│  │  - Creates LanguageClient instances          │  │
│  │  - Manages client lifecycle                  │  │
│  │  - Handles multiple notebooks                │  │
│  └────────────────┬─────────────────────────────┘  │
│                   │                                 │
└───────────────────┼─────────────────────────────────┘
                    │
                    ▼
      ┌─────────────────────────────┐
      │  python-lsp-server          │
      │  (Running in venv)          │
      └─────────────────────────────┘
```

### How It Works

#### 1. Automatic Setup

When you open a `.deepnote` file in VS Code:

1. **Environment Creation**: The extension creates a dedicated virtual environment for the notebook
2. **Toolkit Installation**: Installs `deepnote-toolkit` and `python-lsp-server[all]` in the venv
3. **Kernel Launch**: Starts the Deepnote kernel using the toolkit
4. **LSP Activation**: Automatically starts the LSP client for code intelligence

#### 2. LSP Client Management

The `DeepnoteLspClientManager` (in `src/kernels/deepnote/deepnoteLspClientManager.node.ts`) handles:

#### Client Lifecycle
```typescript
// When kernel starts
await lspClientManager.startLspClients(
    serverInfo,      // Deepnote server connection info
    notebookUri,     // Notebook file URI
    interpreter      // Python environment from venv
);

// When notebook closes
await lspClientManager.stopLspClients(notebookUri);
```

#### Per-Notebook Isolation
- Each notebook gets its own LSP client instance
- Clients are isolated to prevent conflicts
- Automatic cleanup when notebooks close

#### Duplicate Prevention
- Prevents multiple clients for the same notebook
- Reuses existing clients when possible
- Graceful handling of client errors

#### 3. Language Server Process

The extension uses `python-lsp-server` in stdio mode:

```typescript
const serverOptions: Executable = {
    command: pythonPath,           // Python from venv
    args: ['-m', 'pylsp'],        // Start python-lsp-server
    options: { env: { ...process.env } }
};
```

**Why stdio instead of TCP:**
- Simpler process management
- Better isolation
- Standard LSP pattern
- Works with vscode-languageclient library

#### 4. Document Selector

The LSP client is configured to provide intelligence for Python cells in Deepnote notebooks:

```typescript
documentSelector: [
    {
        scheme: 'vscode-notebook-cell',  // Notebook cells
        language: 'python',
        pattern: '**/*.deepnote'
    },
    {
        scheme: 'file',
        language: 'python',
        pattern: '**/*.deepnote'
    }
]
```

This ensures code intelligence works in:
- Interactive notebook cells
- Cell outputs
- Notebook file contexts

### Features Provided

#### Real-Time Code Intelligence
- Autocomplete as you type in notebook cells
- Hover documentation for functions and variables
- Signature help for function parameters
- Error detection before execution

#### Context Awareness
- Understands imports and dependencies from the venv
- Knows about variables defined in earlier cells
- Provides relevant suggestions based on cell context

#### Integration with Kernel
- LSP runs alongside the Deepnote kernel
- Both share the same Python environment
- Consistent experience between static analysis and execution

### Implementation Details

#### Service Registration

The LSP client manager is registered as a singleton service:

```typescript
// In src/notebooks/serviceRegistry.node.ts
serviceManager.addSingleton<IDeepnoteLspClientManager>(
    IDeepnoteLspClientManager,
    DeepnoteLspClientManager
);
```

#### Kernel Lifecycle Integration

The manager integrates with kernel auto-selection:

```typescript
// In deepnoteKernelAutoSelector.node.ts
const lspInterpreter = /* get venv Python */;

await this.lspClientManager.startLspClients(
    serverInfo,
    notebook.uri,
    lspInterpreter
);
```

#### Error Handling

The implementation gracefully handles:
- Missing `python-lsp-server` installation
- LSP server crashes
- Connection failures
- Multiple start/stop requests

### User Experience

#### Transparent Operation
- No manual configuration required
- Automatically starts with notebooks
- Seamlessly integrates with VS Code features

#### Performance
- Lightweight per-notebook clients
- Fast response times for code intelligence
- Minimal impact on notebook execution

#### Reliability
- Robust error handling
- Automatic reconnection on failures
- Clean shutdown on notebook close

### Testing

The extension includes comprehensive integration tests:

```typescript
// Tests verify:
- LSP client manager instantiation
- Starting clients with various configurations
- Stopping clients gracefully
- Handling edge cases (non-existent notebooks, duplicates)
- Error scenarios (missing pylsp, connection failures)
```

Tests run in a real VS Code environment to ensure:
- `vscode-languageclient` works correctly
- LanguageClient lifecycle is properly managed
- Integration with VS Code APIs functions as expected

### Differences from Toolkit LSP

The extension's LSP integration differs from the toolkit's in key ways:

| Aspect | Toolkit (Server-Side) | VS Code Extension (Client-Side) |
|--------|----------------------|----------------------------------|
| **Scope** | Multiple editors/clients | Single VS Code instance |
| **Lifecycle** | Runs continuously with server | Per-notebook, on-demand |
| **Transport** | WebSocket/TCP (multi-client) | stdio (process-based) |
| **Management** | Toolkit manages all processes | Extension manages per-notebook |
| **Use Case** | JupyterLab, web interfaces | VS Code editor integration |

Both approaches are complementary—the toolkit provides server infrastructure while the extension provides client integration.

## Future Possibilities

The LSP integration opens up many possibilities:

- **Advanced Refactoring**: Safe rename across multiple notebooks
- **Code Navigation**: Jump between notebooks and library code
- **Team Features**: Shared language server configurations
- **Custom Servers**: Domain-specific intelligence for specialized workflows
- **Enhanced Debugging**: Inline variable inspection and breakpoints
- **SQL LSP Integration**: Extend support to SQL cells in notebooks (planned)
- **Multi-Language Support**: Add LSP clients for R, JavaScript, and other languages

## Resources

- [Official LSP Specification](https://microsoft.github.io/language-server-protocol/)
- [python-lsp-server GitHub](https://github.com/python-lsp/python-lsp-server)
- [Jupyter LSP Integration](https://github.com/jupyter-lsp/jupyterlab-lsp)
- [Deepnote Toolkit Repository](https://github.com/deepnote/deepnote-toolkit)

## Summary

The Language Server Protocol integration in Deepnote Toolkit brings IDE-quality code intelligence to Jupyter notebooks. By running LSP servers as separate processes alongside Jupyter, users get real-time error detection, autocomplete, and code navigation without sacrificing the interactive notebook experience. The system handles the complexities of notebook structure automatically, providing a seamless development experience across multiple languages and editors.
