# Deepnote Kernel Auto-Start Implementation

## Overview

This implementation adds automatic kernel selection and startup for `.deepnote` notebook files. When a user opens and runs cells in a `.deepnote` file, the extension will:

1. Automatically detect the file type
2. Install the `deepnote-toolkit` Python package (if not already installed)
3. Start a Jupyter server using `deepnote-toolkit`
4. Create and auto-select a Deepnote kernel controller
5. Execute cells on the Deepnote kernel

## Architecture

### Components Created

#### 1. **Deepnote Kernel Types** (`src/kernels/deepnote/types.ts`)
- `DeepnoteKernelConnectionMetadata`: Connection metadata for Deepnote kernels (similar to RemoteKernelSpecConnectionMetadata)
- `IDeepnoteToolkitInstaller`: Interface for toolkit installation service
- `IDeepnoteServerStarter`: Interface for server management
- `IDeepnoteKernelAutoSelector`: Interface for automatic kernel selection
- Constants for wheel URL, default port, and notebook type

#### 2. **Deepnote Toolkit Installer** (`src/kernels/deepnote/deepnoteToolkitInstaller.node.ts`)
- Creates a dedicated virtual environment per `.deepnote` file
- Checks if `deepnote-toolkit` is installed in the venv
- Installs the toolkit from the hardcoded S3 wheel URL
- Outputs installation progress to the output channel
- Verifies successful installation
- Reuses existing venvs for the same `.deepnote` file

**Key Methods:**
- `getVenvInterpreter(deepnoteFileUri)`: Gets the venv Python interpreter for a specific file
- `ensureInstalled(interpreter, deepnoteFileUri)`: Creates venv and installs toolkit if needed

#### 3. **Deepnote Server Starter** (`src/kernels/deepnote/deepnoteServerStarter.node.ts`)
- Manages the lifecycle of deepnote-toolkit Jupyter servers (one per `.deepnote` file)
- Finds an available port (starting from 8888)
- Starts the server with `python -m deepnote_toolkit server --jupyter-port <port>`
- Monitors server output and logs it
- Waits for server to be ready before returning connection info
- Reuses existing server for the same `.deepnote` file if already running
- Manages multiple servers for different `.deepnote` files simultaneously

**Key Methods:**
- `getOrStartServer(interpreter, deepnoteFileUri)`: Returns server info for a file, starting if needed
- `stopServer(deepnoteFileUri)`: Stops the running server for a specific file
- `isServerRunning(serverInfo)`: Checks if server is responsive

#### 4. **Deepnote Kernel Auto-Selector** (`src/notebooks/deepnote/deepnoteKernelAutoSelector.node.ts`)
- Activation service that listens for notebook open events
- Automatically selects Deepnote kernel for `.deepnote` files
- Creates kernel connection metadata
- Registers the controller with VSCode
- Auto-selects the kernel for the notebook

**Key Methods:**
- `activate()`: Registers event listeners
- `ensureKernelSelected(notebook)`: Main logic for auto-selection
- `onDidOpenNotebook(notebook)`: Event handler for notebook opens

#### 5. **Service Registry Updates** (`src/notebooks/serviceRegistry.node.ts`)
- Registers all new Deepnote kernel services
- Binds `IDeepnoteKernelAutoSelector` as an activation service

#### 6. **Kernel Types Updates** (`src/kernels/types.ts`)
- Adds `DeepnoteKernelConnectionMetadata` to `RemoteKernelConnectionMetadata` union type
- Adds deserialization support for `'startUsingDeepnoteKernel'` kind

## Flow Diagram

```
User opens .deepnote file
        ↓
DeepnoteKernelAutoSelector.onDidOpenNotebook()
        ↓
Check if kernel already selected → Yes → Exit
        ↓ No
Get active Python interpreter
        ↓
DeepnoteToolkitInstaller.ensureInstalled()
        ↓
Extract base file URI (remove query params)
        ↓
Check if venv exists for this file → Yes → Skip to server
        ↓ No
Create venv for this .deepnote file
        ↓
pip install <wheel-url> in venv
        ↓
Verify installation
        ↓
DeepnoteServerStarter.getOrStartServer(venv, fileUri)
        ↓
Check if server running for this file → Yes → Return info
        ↓ No
Find available port
        ↓
Start: python -m deepnote_toolkit server --jupyter-port <port>
        ↓
Wait for server to be ready (poll /api endpoint)
        ↓
Create DeepnoteKernelConnectionMetadata
        ↓
Register controller with IControllerRegistration
        ↓
Set controller affinity to Preferred (auto-selects kernel)
        ↓
User runs cell → Executes on Deepnote kernel
```

## Configuration

### Hardcoded Values (as requested)
- **Wheel URL**: `https://deepnote-staging-runtime-artifactory.s3.amazonaws.com/deepnote-toolkit-packages/0.2.30.post19/deepnote_toolkit-0.2.30.post19-py3-none-any.whl`
- **Default Port**: `8888` (will find next available if occupied)
- **Notebook Type**: `deepnote`
- **Venv Location**: `~/.vscode/extensions/storage/deepnote-venvs/<file-path-hash>/`

## Usage

1. **Open a .deepnote file** in VSCode
2. **Click "Run All"** or run any cell
3. The extension will:
   - Show "Installing deepnote-toolkit..." in output (if needed)
   - Show "Starting Deepnote server on port..." in output
   - Automatically select the Deepnote kernel
   - Execute the cell

## Benefits

- **Zero configuration**: No manual kernel selection needed
- **Automatic setup**: Toolkit installation and server startup handled automatically
- **Isolated environments**: Each `.deepnote` file gets its own virtual environment
- **Multi-file support**: Can run multiple `.deepnote` files with separate servers
- **Resource efficiency**: Reuses venv and server for notebooks within the same `.deepnote` file
- **Clean integration**: Uses existing VSCode notebook controller infrastructure

## Future Enhancements

1. **PyPI Package**: Replace S3 URL with PyPI package name once published
2. **Configuration**: Add settings for custom ports, wheel URLs, etc.
3. **Server Management UI**: Add commands to start/stop/restart servers for specific files
4. **Venv Cleanup**: Add command to clean up unused venvs
5. **Error Recovery**: Better handling of server crashes and auto-restart
6. **Progress Indicators**: Visual feedback during installation and startup

## Testing

To test the implementation:

1. Create a `.deepnote` file
2. Add Python code cells
3. Run a cell
4. Verify:
   - Toolkit gets installed (check output channel)
   - Server starts (check output channel)
   - Kernel is auto-selected (check kernel picker)
   - Code executes successfully

## Files Modified/Created

### Created:
- `src/kernels/deepnote/types.ts`
- `src/kernels/deepnote/deepnoteToolkitInstaller.node.ts`
- `src/kernels/deepnote/deepnoteServerStarter.node.ts`
- `src/notebooks/deepnote/deepnoteKernelAutoSelector.node.ts`

### Modified:
- `src/kernels/types.ts`
- `src/notebooks/serviceRegistry.node.ts`

## Dependencies

- `get-port`: For finding available ports
- Existing VSCode notebook infrastructure
- Existing kernel controller system
- Python interpreter service

