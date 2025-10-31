# Debugging Kernel Configuration Management

## Quick Start: See It In Action

### 1. Launch Extension in Debug Mode

1. Open this project in VS Code
2. Press **F5** (or Run > Start Debugging)
3. Select **"Extension"** configuration
4. A new **Extension Development Host** window opens

### 2. Find the Kernel Management UI

**In the Extension Development Host window:**

1. Look for the **Deepnote icon** in the Activity Bar (left sidebar)
2. Click it to open the Deepnote view
3. You should see two sections:
   - **DEEPNOTE EXPLORER** (existing notebook browser)
   - **DEEPNOTE KERNEL CONFIGURATIONS** ⬅️ **NEW!**

**Initial State:**
```
DEEPNOTE KERNEL CONFIGURATIONS
└─ [+] Create New Configuration
```

### 3. Create Your First Configuration

1. Click **"Create New Configuration"** button
2. Follow the wizard:
   - **Select Python interpreter** (choose any available)
   - **Enter name**: e.g., "My Test Config"
   - **Enter packages** (optional): e.g., "pandas, numpy"
3. Watch the progress notification
4. Configuration appears in the tree!

**After Creation:**
```
DEEPNOTE KERNEL CONFIGURATIONS
├─ ⚪ My Test Config [Stopped]
│  ├─ Python: /usr/bin/python3.11
│  ├─ Venv: .../deepnote-venvs/{uuid}
│  ├─ Packages: pandas, numpy
│  ├─ Created: 1/15/2025, 10:00:00 AM
│  └─ Last used: 1/15/2025, 10:00:00 AM
└─ [+] Create New Configuration
```

### 4. Start the Server

1. Right-click the configuration
2. Select **"Start Server"** (or click the play button ▶️)
3. Watch the output channel for logs
4. Icon changes to 🟢 **[Running]**
5. Port and URL appear in the tree

**Running State:**
```
DEEPNOTE KERNEL CONFIGURATIONS
├─ 🟢 My Test Config [Running]
│  ├─ Port: 8888
│  ├─ URL: http://localhost:8888
│  ├─ Python: /usr/bin/python3.11
│  ├─ Venv: .../deepnote-venvs/{uuid}
│  ├─ Packages: pandas, numpy
│  ├─ Created: 1/15/2025, 10:00:00 AM
│  └─ Last used: 1/15/2025, 10:05:23 AM
└─ [+] Create New Configuration
```

### 5. Use Configuration with a Notebook

1. Open (or create) a `.deepnote` file
2. A **picker dialog** appears automatically
3. Select your configuration from the list
4. Notebook connects to the running server
5. Execute cells - they run in your configured environment!

---

## Key Debugging Locations

### Files to Set Breakpoints In

#### **1. Activation & Initialization**
**File:** `src/kernels/deepnote/configurations/deepnoteConfigurationsActivationService.ts`

**Key Lines:**
- Line 27: `activate()` - Entry point
- Line 30: `configurationManager.initialize()` - Load configs from storage

```typescript
// Set breakpoint here to see extension activation
public activate(): void {
    logger.info('Activating Deepnote kernel configurations view');
    // ...
}
```

#### **2. Creating Configurations**
**File:** `src/kernels/deepnote/configurations/deepnoteConfigurationsView.ts`

**Key Lines:**
- Line 64: `createConfiguration()` command handler
- Line 238: `configurationManager.createConfiguration()` call

```typescript
// Set breakpoint here to see configuration creation
private async createConfiguration(): Promise<void> {
    try {
        // Step 1: Select Python interpreter
        const api = await this.pythonApiProvider.getNewApi();
        // ...
    }
}
```

#### **3. Configuration Manager (Business Logic)**
**File:** `src/kernels/deepnote/configurations/deepnoteConfigurationManager.ts`

**Key Lines:**
- Line 45: `initialize()` - Load from storage
- Line 63: `createConfiguration()` - Create new config
- Line 174: `startServer()` - Start Jupyter server
- Line 215: `stopServer()` - Stop server

```typescript
// Set breakpoint here to see config creation
public async createConfiguration(options: CreateKernelConfigurationOptions): Promise<DeepnoteKernelConfiguration> {
    const id = uuid();
    const venvPath = Uri.joinPath(this.context.globalStorageUri, 'deepnote-venvs', id);
    // ...
    this._onDidChangeConfigurations.fire(); // ← Watch this fire!
}
```

#### **4. TreeDataProvider (UI Updates)**
**File:** `src/kernels/deepnote/configurations/deepnoteConfigurationTreeDataProvider.ts`

**Key Lines:**
- Line 19-21: Event listener setup
- Line 25: `refresh()` - Triggers tree update
- Line 32: `getChildren()` - VS Code calls this to refresh

```typescript
// Set breakpoint here to see event propagation
constructor(private readonly configurationManager: IDeepnoteConfigurationManager) {
    // Listen to configuration changes and refresh the tree
    this.configurationManager.onDidChangeConfigurations(() => {
        this.refresh(); // ← Breakpoint here!
    });
}
```

#### **5. Server Lifecycle**
**File:** `src/kernels/deepnote/configurations/deepnoteConfigurationManager.ts`

**Key Lines:**
- Line 189: `ensureVenvAndToolkit()` - Create venv
- Line 192: `installAdditionalPackages()` - Install packages
- Line 197: `serverStarter.startServer()` - Launch Jupyter

```typescript
// Set breakpoint here to see server startup
public async startServer(id: string): Promise<void> {
    const config = this.configurations.get(id);
    if (!config) {
        throw new Error(`Configuration not found: ${id}`);
    }

    // First ensure venv is created and toolkit is installed
    await this.toolkitInstaller.ensureVenvAndToolkit(config.pythonInterpreter, config.venvPath);
    // ...
    // Start the Jupyter server
    const serverInfo = await this.serverStarter.startServer(config.pythonInterpreter, config.venvPath, id);
}
```

#### **6. Notebook Integration (Configuration Picker)**
**File:** `src/notebooks/deepnote/deepnoteKernelAutoSelector.node.ts`

**Key Lines:**
- Look for `ensureKernelSelected()` method
- Look for calls to `configurationPicker.pickConfiguration()`
- Look for calls to `mapper.getConfigurationForNotebook()`

---

## Visual Debugging Tips

### **1. Watch the Output Channel**

When the extension is running, look for:
- **Output Panel** (View > Output)
- Select **"Deepnote"** from the dropdown
- You'll see logs like:

```
[info] Activating Deepnote kernel configurations view
[info] Initialized configuration manager with 0 configurations
[info] Creating virtual environment at /path/to/venv
[info] Installing deepnote-toolkit and ipykernel in venv from https://...
[info] Created new kernel configuration: My Test Config (uuid-123)
[info] Starting server for configuration: My Test Config (uuid-123)
[info] Deepnote server started successfully at http://localhost:8888
```

### **2. Watch VS Code's Developer Tools**

Open Developer Tools:
- **Help > Toggle Developer Tools**
- **Console tab**: See any JavaScript errors
- **Network tab**: See server requests (when executing cells)

### **3. Watch Global State (Persistence)**

To see what's stored:

1. Set breakpoint in `deepnoteConfigurationStorage.ts`
2. At line 56: `await this.globalState.update(STORAGE_KEY, states)`
3. Inspect the `states` variable
4. You'll see the JSON being persisted

**Example stored data:**
```json
{
  "deepnote.kernelConfigurations": [
    {
      "id": "abc-123-def",
      "name": "My Test Config",
      "pythonInterpreterPath": "/usr/bin/python3.11",
      "venvPath": "/Users/.../deepnote-venvs/abc-123-def",
      "createdAt": "2025-01-15T10:00:00.000Z",
      "lastUsedAt": "2025-01-15T10:00:00.000Z",
      "packages": ["pandas", "numpy"]
    }
  ]
}
```

### **4. Watch Server Processes**

In your terminal:
```bash
# Find running deepnote-toolkit servers
ps aux | grep deepnote_toolkit

# Or on Windows
tasklist | findstr python
```

You should see processes like:
```
python -m deepnote_toolkit server --jupyter-port 8888
```

### **5. Check Venv Directories**

Navigate to:
```bash
# macOS/Linux
cd ~/.vscode/extensions/.../globalStorage/deepnote-venvs/

# Windows
cd %APPDATA%\Code\User\globalStorage\...\deepnote-venvs\
```

You'll see directories named with UUIDs, each containing a Python venv.

---

## Common Debugging Scenarios

### **Scenario 1: Configuration Not Appearing in Tree**

**Set breakpoints:**
1. `deepnoteConfigurationManager.ts:80` - Check if `_onDidChangeConfigurations.fire()` is called
2. `deepnoteConfigurationTreeDataProvider.ts:20` - Check if event listener is triggered
3. `deepnoteConfigurationTreeDataProvider.ts:25` - Check if `refresh()` is called
4. `deepnoteConfigurationTreeDataProvider.ts:46` - Check if `getRootItems()` returns the config

**Debug steps:**
- Verify `this.configurations` Map contains the config
- Verify event propagation chain
- Check if tree view is registered with VS Code

### **Scenario 2: Server Won't Start**

**Set breakpoints:**
1. `deepnoteConfigurationManager.ts:174` - `startServer()` entry
2. `deepnoteToolkitInstaller.node.ts:74` - `ensureVenvAndToolkit()` entry
3. `deepnoteServerStarter.node.ts:76` - `startServer()` entry

**Check:**
- Output channel for error messages
- Venv creation succeeded
- Python interpreter is valid
- Port is not already in use

### **Scenario 3: Notebook Picker Not Appearing**

**Set breakpoints:**
1. `deepnoteKernelAutoSelector.node.ts` - `ensureKernelSelected()` method
2. Check if `mapper.getConfigurationForNotebook()` returns undefined
3. Check if `picker.pickConfiguration()` is called

**Verify:**
- Picker service is registered in DI container
- Mapper service is registered in DI container
- Notebook URI is being normalized correctly

---

## EventEmitter Pattern Debugging

To trace the event flow (from my earlier explanation):

### **1. Set Breakpoints in Sequence:**

```typescript
// 1. Manager fires event
// deepnoteConfigurationManager.ts:80
this._onDidChangeConfigurations.fire();

// 2. TreeProvider receives event
// deepnoteConfigurationTreeDataProvider.ts:20
this.configurationManager.onDidChangeConfigurations(() => {
    this.refresh(); // ← Breakpoint

// 3. TreeProvider fires its event
// deepnoteConfigurationTreeDataProvider.ts:25
public refresh(): void {
    this._onDidChangeTreeData.fire(); // ← Breakpoint

// 4. VS Code calls getChildren
// deepnoteConfigurationTreeDataProvider.ts:32
public async getChildren(element?: DeepnoteConfigurationTreeItem): Promise<DeepnoteConfigurationTreeItem[]> {
    // ← Breakpoint
```

### **2. Watch Variables:**

- In Manager: `this.configurations` - See all configs
- In TreeProvider: `this._onDidChangeTreeData` - See EventEmitter
- In `getChildren`: `element` parameter - See what VS Code is requesting

---

## Testing the Complete Flow

### **End-to-End Test:**

1. **Create Configuration**
   - Set breakpoint: `deepnoteConfigurationsView.ts:238`
   - Click "Create New Configuration"
   - Step through: select interpreter → enter name → create venv

2. **Start Server**
   - Set breakpoint: `deepnoteConfigurationManager.ts:197`
   - Right-click config → "Start Server"
   - Step through: install toolkit → start server → update state

3. **Open Notebook**
   - Set breakpoint: `deepnoteKernelAutoSelector.node.ts` (ensureKernelSelected)
   - Open a `.deepnote` file
   - Step through: check mapper → show picker → save selection

4. **Execute Cell**
   - Open notebook with selected configuration
   - Execute a cell (e.g., `print("Hello")`)
   - Watch server logs in Output channel

---

## Quick Test Commands

```bash
# 1. Build the extension
npm run compile

# 2. Run unit tests
npm test

# Or run specific test file
npx mocha --config ./build/.mocha.unittests.js.json \
  ./out/src/kernels/deepnote/configurations/deepnoteConfigurationManager.unit.test.js

# 3. Check for TypeScript errors
npm run compile:check

# 4. Format code
npx prettier --write .
```

---

## Useful VS Code Commands (in Extension Development Host)

Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux):

- **Developer: Reload Window** - Reload extension after code changes
- **Developer: Open Webview Developer Tools** - Debug webviews
- **Developer: Show Running Extensions** - See if your extension loaded
- **Deepnote: Create Kernel Configuration** - Test command directly
- **Deepnote: Refresh** - Manually refresh tree view

---

## Summary: Where to Look

| What You Want to See | Where to Look | File/Line |
|---------------------|---------------|-----------|
| **UI Tree View** | Sidebar → Deepnote → Kernel Configurations | Activity Bar |
| **Create Configuration** | Click "+ Create New Configuration" | View controller |
| **Configuration State** | Expand config item in tree | Tree data provider |
| **Server Logs** | Output panel → "Deepnote" channel | Output channel |
| **Persisted Data** | Inspect `globalState` in debugger | Storage layer |
| **Running Processes** | Terminal: `ps aux \| grep deepnote` | System |
| **Event Flow** | Breakpoints in Manager → Provider → getChildren | Event chain |
| **Notebook Picker** | Opens when you open a `.deepnote` file | Auto-selector |

---

## Pro Tips

1. **Use Logpoints** instead of console.log:
   - Right-click in gutter → Add Logpoint
   - Logs appear in Debug Console without modifying code

2. **Watch Expressions:**
   - Add to Watch panel: `this.configurations.size`
   - See live count of configurations

3. **Conditional Breakpoints:**
   - Right-click breakpoint → Edit Breakpoint → Add condition
   - Example: `config.id === "specific-uuid"`

4. **Call Stack Navigation:**
   - When breakpoint hits, examine Call Stack panel
   - See the entire event propagation path

5. **Restart Extension Fast:**
   - In Debug toolbar, click restart button (circular arrow)
   - Or use `Cmd+Shift+F5` / `Ctrl+Shift+F5`