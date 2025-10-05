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

-   `DeepnoteKernelConnectionMetadata`: Connection metadata for Deepnote kernels (similar to RemoteKernelSpecConnectionMetadata)
-   `IDeepnoteToolkitInstaller`: Interface for toolkit installation service
-   `IDeepnoteServerStarter`: Interface for server management
-   `IDeepnoteKernelAutoSelector`: Interface for automatic kernel selection
-   `DeepnoteServerInfo`: Server connection information (URL, port, token)
-   Constants for wheel URL, default port, and notebook type

#### 2. **Deepnote Toolkit Installer** (`src/kernels/deepnote/deepnoteToolkitInstaller.node.ts`)

-   Creates a dedicated virtual environment per `.deepnote` file
-   Checks if `deepnote-toolkit` is installed in the venv
-   Installs the toolkit and `ipykernel` from the hardcoded S3 wheel URL
-   **Registers a kernel spec** using `ipykernel install --user --name deepnote-venv-<hash>` that points to the venv's Python interpreter
-   This ensures packages installed via `pip` are available to the kernel
-   Outputs installation progress to the output channel
-   Verifies successful installation
-   Reuses existing venvs for the same `.deepnote` file

**Key Methods:**

-   `getVenvInterpreter(deepnoteFileUri)`: Gets the venv Python interpreter for a specific file
-   `ensureInstalled(interpreter, deepnoteFileUri)`: Creates venv, installs toolkit and ipykernel, and registers kernel spec
-   `getVenvHash(deepnoteFileUri)`: Creates a unique hash for both kernel naming and venv directory paths
-   `getDisplayName(deepnoteFileUri)`: Gets a friendly display name for the kernel

#### 3. **Deepnote Server Starter** (`src/kernels/deepnote/deepnoteServerStarter.node.ts`)

-   Manages the lifecycle of deepnote-toolkit Jupyter servers (one per `.deepnote` file)
-   Finds an available port (starting from 8888)
-   Starts the server with `python -m deepnote_toolkit server --jupyter-port <port>`
-   **Sets environment variables** so shell commands use the venv's Python:
    -   Prepends venv's bin directory to `PATH`
    -   Sets `VIRTUAL_ENV` to the venv path
    -   Removes `PYTHONHOME` to avoid conflicts
-   Monitors server output and logs it
-   Waits for server to be ready before returning connection info
-   Reuses existing server for the same `.deepnote` file if already running
-   Manages multiple servers for different `.deepnote` files simultaneously

**Key Methods:**

-   `getOrStartServer(interpreter, deepnoteFileUri)`: Returns server info for a file, starting if needed
-   `stopServer(deepnoteFileUri)`: Stops the running server for a specific file
-   `isServerRunning(serverInfo)`: Checks if server is responsive

#### 4. **Deepnote Server Provider** (`src/kernels/deepnote/deepnoteServerProvider.node.ts`)

-   Jupyter server provider that registers and resolves Deepnote toolkit servers
-   Implements `JupyterServerProvider` interface from VSCode Jupyter API
-   Maintains a map of server handles to server connection information
-   Allows the kernel infrastructure to resolve server connections

**Key Methods:**

-   `activate()`: Registers the server provider with the Jupyter server provider registry
-   `registerServer(handle, serverInfo)`: Registers a Deepnote server for a specific handle
-   `provideJupyterServers(token)`: Lists all registered Deepnote servers
-   `resolveJupyterServer(server, token)`: Resolves server connection info by handle

#### 5. **Deepnote Kernel Auto-Selector** (`src/notebooks/deepnote/deepnoteKernelAutoSelector.node.ts`)

-   Activation service that listens for notebook open events and controller selection changes
-   Automatically selects Deepnote kernel for `.deepnote` files
-   Queries the Deepnote server for available kernel specs
-   **Prefers the venv kernel spec** (`deepnote-venv-<hash>`) that was registered by the installer and uses the venv's Python interpreter
-   This ensures the kernel uses the same environment where packages are installed
-   Falls back to other Python kernel specs if venv kernel not found
-   Registers the server with the server provider
-   Creates kernel connection metadata
-   Registers the controller with VSCode
-   Auto-selects the kernel for the notebook
-   **Reuses existing controllers and servers** for persistent kernel sessions
-   **Automatically reselects kernel** if it becomes unselected after errors
-   Tracks controllers per notebook file for efficient reuse

**Key Methods:**

-   `activate()`: Registers event listeners for notebook open/close and controller selection changes
-   `ensureKernelSelected(notebook)`: Main logic for auto-selection, kernel spec selection, and kernel reuse
-   `onDidOpenNotebook(notebook)`: Event handler for notebook opens
-   `onControllerSelectionChanged(event)`: Event handler for controller selection changes (auto-reselects if needed)
-   `onDidCloseNotebook(notebook)`: Event handler for notebook closes (preserves controllers for reuse)

#### 6. **Service Registry Updates** (`src/notebooks/serviceRegistry.node.ts`)

-   Registers all new Deepnote kernel services
-   Binds `DeepnoteServerProvider` as an activation service
-   Binds `IDeepnoteKernelAutoSelector` as an activation service

#### 7. **Kernel Types Updates** (`src/kernels/types.ts`)

-   Adds `DeepnoteKernelConnectionMetadata` to `RemoteKernelConnectionMetadata` union type
-   Adds deserialization support for `'startUsingDeepnoteKernel'` kind

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
pip install deepnote-toolkit[server] and ipykernel in venv
    ↓
Register kernel spec pointing to venv's Python
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
Register server with DeepnoteServerProvider
    ↓
Query server for available kernel specs
    ↓
Select venv kernel spec (deepnote-venv-<hash>) or fall back to other Python kernel
    ↓
Create DeepnoteKernelConnectionMetadata with server kernel spec
    ↓
Register controller with IControllerRegistration
    ↓
Set controller affinity to Preferred (auto-selects kernel)
    ↓
User runs cell → Executes on Deepnote kernel
```

## Configuration

### Hardcoded Values (as requested)

-   **Wheel URL**: `https://deepnote-staging-runtime-artifactory.s3.amazonaws.com/deepnote-toolkit-packages/0.2.30.post20/deepnote_toolkit-0.2.30.post20-py3-none-any.whl`
-   **Default Port**: `8888` (will find next available if occupied)
-   **Notebook Type**: `deepnote`
-   **Venv Location**: `~/.vscode/extensions/storage/deepnote-venvs/<hashed-path>/` (e.g., `venv_a1b2c3d4`)
-   **Server Provider ID**: `deepnote-server`
-   **Kernel Spec Name**: `deepnote-venv-<file-path-hash>` (registered via ipykernel to point to venv Python)
-   **Kernel Display Name**: `Deepnote (<notebook-filename>)`

## Usage

1. **Open a .deepnote file** in VSCode

-   A temporary "Loading Deepnote Kernel..." controller is automatically selected
-   A progress notification appears in the bottom-right

2. **You can immediately click "Run All" or run individual cells**

-   Cells will wait for the kernel to be ready before executing
-   No kernel selection dialog will appear

3. **Once the progress notification shows "Kernel ready!"**:

-   The loading controller is automatically replaced with the real Deepnote kernel
-   Your cells start executing

4. The extension automatically:

-   Installs deepnote-toolkit in a dedicated virtual environment (first time only)
-   Starts a Deepnote server on an available port (if not already running)
-   Selects the appropriate Deepnote kernel
-   Executes your cells

**First-time setup** takes 15-30 seconds. **Subsequent opens** of the same file reuse the existing environment and server, taking less than 1 second.

## Benefits

-   **Zero configuration**: No manual kernel selection needed
-   **Automatic setup**: Toolkit installation and server startup handled automatically
-   **Isolated environments**: Each `.deepnote` file gets its own virtual environment
-   **Multi-file support**: Can run multiple `.deepnote` files with separate servers
-   **Resource efficiency**: Reuses venv and server for notebooks within the same `.deepnote` file
-   **Clean integration**: Uses existing VSCode notebook controller infrastructure
-   **Proper server resolution**: Implements Jupyter server provider for proper kernel connection handling
-   **Compatible kernel specs**: Uses kernel specs that exist on the Deepnote server
-   **Persistent kernel sessions**: Controllers and servers remain available even after errors
-   **Automatic recovery**: If kernel becomes unselected, it's automatically reselected
-   **Seamless reusability**: Run cells as many times as you want without manual kernel selection

## UI Customization

### Hidden UI Elements for Deepnote Notebooks

To provide a cleaner experience for Deepnote notebooks, the following UI elements are hidden when working with `.deepnote` files:

1. **Notebook Toolbar Buttons:**

-   Restart Kernel
-   Variable View
-   Outline View
-   Export
-   Codespace Integration

2. **Cell Title Menu Items:**

-   Run by Line
-   Run by Line Next/Stop
-   Select Precedent/Dependent Cells

3. **Cell Execute Menu Items:**

-   Run and Debug Cell
-   Run Precedent/Dependent Cells

These items are hidden by adding `notebookType != 'deepnote'` conditions to the `when` clauses in `package.json`. The standard cell run buttons (play icons) remain visible as they are the primary way to execute cells.

### Progress Indicators

The extension shows a visual progress notification while the Deepnote kernel is being set up:

-   **Location**: Notification area (bottom-right)
-   **Title**: "Loading Deepnote Kernel"
-   **Cancellable**: Yes
-   **Progress Steps**:
    1. "Setting up Deepnote kernel..."
    2. "Finding Python interpreter..."
    3. "Installing Deepnote toolkit..." (shown if installation is needed)
    4. "Starting Deepnote server..." (shown if server needs to be started)
    5. "Connecting to kernel..."
    6. "Finalizing kernel setup..."
    7. "Kernel ready!"

For notebooks that already have a running kernel, the notification shows "Reusing existing kernel..." and completes quickly.

**Important**: When you first open a `.deepnote` file, a temporary "Loading Deepnote Kernel..." controller is automatically selected. This prevents the kernel selection dialog from appearing. The kernel setup happens automatically in the background. During this loading period (typically 5-30 seconds for first-time setup, < 1 second for subsequent opens), if you try to run cells, they will wait until the real kernel is ready. Once ready, the loading controller is automatically replaced with the real Deepnote kernel and your cells will execute.

## Future Enhancements

1. **PyPI Package**: Replace S3 URL with PyPI package name once published
2. **Configuration**: Add settings for custom ports, wheel URLs, etc.
3. **Server Management UI**: Add commands to start/stop/restart servers for specific files
4. **Venv Cleanup**: Add command to clean up unused venvs
5. **Error Recovery**: Better handling of server crashes and auto-restart

## Testing

To test the implementation:

1. Create a `.deepnote` file
2. Add Python code cells
3. Run a cell
4. Verify:

-   Toolkit gets installed (check output channel)
-   Server starts (check output channel)
-   Kernel is auto-selected (check kernel picker)
-   Code executes successfully

## Files Modified/Created

### Created:

-   `src/kernels/deepnote/types.ts` - Type definitions and interfaces
-   `src/kernels/deepnote/deepnoteToolkitInstaller.node.ts` - Toolkit installation service
-   `src/kernels/deepnote/deepnoteServerStarter.node.ts` - Server lifecycle management
-   `src/kernels/deepnote/deepnoteServerProvider.node.ts` - Jupyter server provider implementation
-   `src/notebooks/deepnote/deepnoteKernelAutoSelector.node.ts` - Automatic kernel selection

### Modified:

-   `src/kernels/types.ts` - Added DeepnoteKernelConnectionMetadata to union types
-   `src/notebooks/serviceRegistry.node.ts` - Registered new services

## Dependencies

-   `get-port`: For finding available ports
-   Existing VSCode notebook infrastructure
-   Existing kernel controller system
-   Python interpreter service
-   Jupyter server provider registry
-   JupyterLab session management

## Technical Details

### Server Provider Architecture

The implementation uses VSCode's Jupyter server provider API to properly integrate Deepnote servers:

1. **DeepnoteServerProvider** implements the `JupyterServerProvider` interface
2. It registers with the `IJupyterServerProviderRegistry` during activation
3. When a Deepnote server is started, it's registered with the provider using a unique handle
4. The kernel infrastructure can then resolve the server connection through this provider
5. This allows the kernel session factory to properly connect to the Deepnote server

### Kernel Spec Resolution

The implementation uses a hybrid approach:

1. **Registers per-venv kernel specs**: The installer registers kernel specs using `ipykernel install --user --name deepnote-venv-<hash>` that point to each venv's Python interpreter
2. **Queries server for available specs**: Connects to the running Deepnote server using `JupyterLabHelper` and queries available kernel specs via `getKernelSpecs()`
3. **Prefers venv kernel specs**: Looks for the registered venv kernel spec (`deepnote-venv-<hash>`) first
4. **Falls back gracefully**: Falls back to other Python kernel specs (like `python3-venv`) if the venv kernel spec is not found
5. **Uses server-compatible specs**: This ensures compatibility with the Deepnote server's kernel configuration while maintaining venv isolation

### Virtual Environment Path Handling

The implementation uses a robust hashing approach for virtual environment directory names:

1. **Path Hashing**: Uses `getVenvHash()` to create short, unique identifiers from file paths
2. **Hash Algorithm**: Implements a djb2-style hash function for better distribution
3. **Format**: Generates identifiers like `venv_a1b2c3d4` (max 16 characters)
4. **Benefits**:

-   Avoids Windows MAX_PATH (260 character) limitations
-   Prevents directory structure leakage into extension storage
-   Provides consistent naming for both venv directories and kernel specs
-   Reduces collision risk with better hash distribution

## Troubleshooting & Key Fixes

### Issue 1: "Unable to get resolved server information"

**Problem**: The kernel infrastructure couldn't resolve the server connection because the `serverProviderHandle` pointed to a non-existent server provider.

**Solution**: Created `DeepnoteServerProvider` that implements the `JupyterServerProvider` interface and registered it with the `IJupyterServerProviderRegistry`. This allows the kernel session factory to properly resolve server connections.

### Issue 2: "No such kernel named python31211jvsc74a57bd0..."

**Problem**: The extension was creating a custom kernel spec name based on the interpreter hash, but this kernel spec didn't exist on the Deepnote server.

**Solution**: Instead of creating a custom kernel spec, the implementation now:

-   Queries the Deepnote server for available kernel specs
-   Selects an existing Python kernel (typically `python3-venv`)
-   Uses this server-native kernel spec for the connection

### Issue 3: "Kernel becomes unregistered after errors"

**Problem**: When a cell execution resulted in an error, the kernel controller would sometimes become unselected or disposed. Subsequent attempts to run cells would fail because no kernel was selected, requiring manual intervention.

**Solution**: Implemented persistent kernel tracking and automatic reselection:

-   Controllers and connection metadata are stored per notebook file and reused across sessions
-   Listens to `onControllerSelectionChanged` events to detect when a Deepnote kernel becomes unselected
-   Automatically reselects the same kernel controller when it becomes deselected
-   Reuses existing servers and controllers instead of creating new ones
-   Ensures the same kernel remains available for the entire session, even after errors

### Issue 4: "Controllers getting disposed causing repeated recreation"

**Problem**: Controllers were being automatically disposed by VSCode's `ControllerRegistration` system when:

1. The kernel finder refreshed its list of available kernels
2. The Deepnote kernel wasn't in that list (because it's created dynamically)
3. The `loadControllers()` method would dispose controllers that weren't in the kernel finder's list
4. This led to a cycle of recreation, disposal, and race conditions

**Root Cause**: The `ControllerRegistration.loadControllers()` method periodically checks if controllers are still valid by comparing them against the kernel finder's list. Controllers that aren't found and aren't "protected" get disposed. Deepnote controllers weren't protected, so they were being disposed and recreated repeatedly.

**Solution**: Mark Deepnote controllers as protected using `trackActiveInterpreterControllers()`:

-   Call `controllerRegistration.trackActiveInterpreterControllers(controllers)` when creating Deepnote controllers
-   This adds them to the `_activeInterpreterControllerIds` set, which prevents disposal in `canControllerBeDisposed()`
-   Controllers are now created **once** and persist for the entire session
-   **No more recreation, no more debouncing, no more race conditions**
-   The same controller instance handles all cell executions, even after errors

These changes ensure that Deepnote notebooks can execute cells reliably by:

1. Providing a valid server provider that can be resolved
2. Using kernel specs that actually exist on the Deepnote server
3. Maintaining persistent kernel sessions that survive errors and can be reused indefinitely
4. **Preventing controller disposal entirely** - controllers are created once and reused forever

### Issue 5: "Packages installed via pip not available in kernel"

**Problem**: When users ran `!pip install matplotlib`, the package was installed successfully, but when they tried to import it, they got `ModuleNotFoundError`. This happened because:

1. The Jupyter server was running in the venv
2. But the kernel was using a different Python interpreter (system Python or different environment)
3. So `pip install` went to one environment, but imports came from another

**Root Cause**: The kernel was using the venv's Python (correct), but shell commands (`!pip install`) were using the system Python or pyenv (wrong) because they inherit the shell's PATH environment variable.

**Solution**: Two-part fix:

1. **Kernel spec registration** (ensures kernel uses venv Python):

-   Install `ipykernel` in the venv along with deepnote-toolkit
-   Use `python -m ipykernel install --user --name deepnote-venv-<hash>` to register a kernel spec that points to the venv's Python interpreter
-   In the kernel selection logic, prefer the venv kernel spec (`deepnote-venv-<hash>`) when querying the server for available specs

2. **Environment variable configuration** (ensures shell commands use venv Python):

-   When starting the Jupyter server, set environment variables:
    -   Prepend venv's `bin/` directory to `PATH`
    -   Set `VIRTUAL_ENV` to point to the venv
    -   Remove `PYTHONHOME` (can interfere with venv)
-   This ensures `!pip install` and other shell commands use the venv's Python

**Result**: Both the kernel and shell commands now use the same Python environment (the venv), so packages installed via `!pip install` or `%pip install` are immediately available for import.
