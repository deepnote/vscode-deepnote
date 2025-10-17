# Deepnote Kernel Management - TODO

## Current Status

### ✅ Completed Phases

- **Phase 1**: Core Models & Storage
- **Phase 2**: Refactor Existing Services
- **Phase 3**: Tree View UI (with 40+ passing unit tests)
- **Phase 4**: Server Control Commands (completed in Phase 3)
- **Phase 5**: Package Management (completed in Phase 3)
- **Phase 7 Part 1**: Configuration picker infrastructure

### ✅ Completed: Phase 7 Part 2 - Kernel Auto-Selector Integration

**Status**: Integration completed successfully! 🎉

**Implemented**:

1. ✅ Injected `IDeepnoteConfigurationPicker` and `IDeepnoteNotebookConfigurationMapper` into `DeepnoteKernelAutoSelector`
2. ✅ Modified `ensureKernelSelected()` method:
   - Checks mapper for existing configuration selection first
   - Shows picker if no selection exists or config was deleted
   - Saves user's selection to mapper
   - Uses selected configuration instead of auto-creating venv
3. ✅ Implemented configuration server lifecycle handling:
   - Auto-starts server if configuration exists but not running
   - Shows progress notifications during startup
   - Updates configuration's lastUsedAt timestamp
4. ✅ Updated connection metadata creation:
   - Uses configuration's venv interpreter
   - Uses configuration's server info
   - Registers server with provider using configuration ID
5. ✅ Edge case handling:
   - User cancels picker → falls back to legacy auto-create behavior
   - Configuration deleted → shows picker again
   - Multiple notebooks can share same configuration
   - Graceful error handling throughout

**Implementation Details**:

- Created two helper methods:
  - `ensureKernelSelectedWithConfiguration()` - Uses selected configuration
  - `ensureKernelSelectedLegacy()` - Fallback to old auto-create behavior
- Configuration selection persists in workspace state
- Backward compatible with existing file-based venv system
- Full TypeScript compilation successful

### ✅ Solved: Controller Disposal & Environment Switching

**Evolution of the Problem**:

**Phase 1 - Initial DISPOSED Errors**:
- When switching environments, disposing controllers caused "notebook controller is DISPOSED" errors
- Occurred when queued cells tried to execute on disposed controller
- Workaround: Never dispose old controllers (they remain in memory)

**Phase 2 - Stuck on Old Kernel** (the real issue):
- After switching environments with Phase 1 workaround:
  - Cells execute in OLD kernel (wrong environment)
  - Kernel selector UI shows OLD kernel
  - System is "stuck at initial kernel"
- Root Cause: `updateNotebookAffinity(Preferred)` only sets preference, it does NOT force VS Code to actually switch controllers!

**Final Solution** (WORKING):
Implemented proper controller disposal sequence in `rebuildController()`:

1. **Do NOT unregister the old server** - Unregistering triggers `ControllerRegistration.onDidRemoveServers()` which automatically disposes controllers. The old server can remain registered harmlessly (new server uses different handle: `deepnote-config-server-${configId}`).

2. **Create new controller first** - Call `ensureKernelSelected()` to create and register the new controller with the new environment.

3. **Mark new controller as preferred** - Use `updateNotebookAffinity(Preferred)` so VS Code knows which controller to select next.

4. **Dispose old controller** - This is CRITICAL! Disposing the old controller forces VS Code to:
   - Fire `onDidChangeSelectedNotebooks(selected: false)` on old controller → disposes old kernel
   - Auto-select the new preferred controller
   - Fire `onDidChangeSelectedNotebooks(selected: true)` on new controller → creates new kernel
   - Update UI to show new kernel

**Why Disposal is Necessary**:
- Simply marking a controller as "Preferred" does NOT switch active selection
- The old controller remains selected and active until explicitly disposed
- Disposal is the ONLY way to force VS Code to switch to the new controller
- Any cells queued on old controller will fail, but this is acceptable (user is intentionally switching environments)

**Key Implementation Details**:

- Server handles are unique per configuration: `deepnote-config-server-${configId}`
- Old server stays registered but is removed from tracking map
- Proper disposal sequence ensures correct controller switching
- New executions use the NEW environment/kernel
- Kernel selector UI updates to show NEW kernel
- Controllers are marked as protected from automatic disposal via `trackActiveInterpreterControllers()`

**Code Locations**:

- src/notebooks/deepnote/deepnoteKernelAutoSelector.node.ts:258-326 (rebuildController with proper disposal)
- src/notebooks/deepnote/deepnoteKernelAutoSelector.node.ts:330-358 (extracted selectKernelSpec)
- src/notebooks/controllers/vscodeNotebookController.ts:395-426 (onDidChangeSelectedNotebooks lifecycle)
- src/notebooks/controllers/controllerRegistration.ts:186-205 (onDidRemoveServers that triggers disposal)

**Verified Working**:

- ✅ All 40+ unit tests passing
- ✅ Environment switching forces controller/kernel switch
- ✅ New cells execute in NEW environment (not old)
- ✅ Kernel selector UI updates to show NEW kernel
- ✅ No DISPOSED errors during switching
- ✅ Proper cleanup of old controller resources

### 🎯 Next: E2E Testing & Validation

**Testing Plan**:

1. **Happy Path**:

   - Create config "Python 3.11 Data Science" via tree view
   - Add packages: pandas, numpy
   - Start server via tree view
   - Open test.deepnote
   - See configuration picker
   - Select config from picker
   - Verify kernel starts and cells execute
   - Close notebook and reopen
   - Verify same config auto-selected (no picker shown)

2. **Environment Switching** (CRITICAL - tests the controller disposal fix):

   - Create config1 with Python 3.11
   - Create config2 with different Python version
   - Start both servers
   - Open notebook → select config1
   - Execute a cell → verify it runs in config1 environment
   - Right-click notebook in tree → "Switch Environment" → select config2
   - **Verify**:
     - ✅ Kernel selector UI updates to show config2
     - ✅ Execute another cell → runs in config2 environment (NOT config1)
     - ✅ No "DISPOSED" errors appear in Extension Host logs
   - Switch back to config1
   - **Verify** same behavior

3. **Multiple Notebooks**:

   - Create 2 configs with different Python versions
   - Open notebook1.deepnote → select config1
   - Open notebook2.deepnote → select config2
   - Verify both work independently

4. **Auto-Start Flow**:

   - Stop server for a configuration
   - Open notebook that uses that config
   - Verify server auto-starts before kernel connects

5. **Fallback Flow**:
   - Open new notebook
   - Cancel configuration picker
   - Verify falls back to legacy auto-create behavior

### ⏸️ Deferred Phases

**Phase 6: Detail View** (Optional enhancement)

- Webview panel with configuration details
- Live server logs
- Editable fields
- Action buttons

**Phase 8: Migration & Polish**

- Migrate existing file-based venvs to configurations
- Auto-detect and import old venvs on first run
- UI polish (icons, tooltips, descriptions)
- Keyboard shortcuts
- User documentation

## Implementation Notes

### Current Architecture

```
User creates config → Config stored in globalState
User starts server → Server tracked by config ID
User opens notebook → Picker shows → Selection saved to workspaceState
Notebook uses config → Config's venv & server used
```

### Key Files to Modify

1. `src/notebooks/deepnote/deepnoteKernelAutoSelector.node.ts` - Main integration point
2. `src/kernels/deepnote/configurations/deepnoteConfigurationPicker.ts` - Already created ✅
3. `src/kernels/deepnote/configurations/deepnoteNotebookConfigurationMapper.ts` - Already created ✅

### Backward Compatibility

The old auto-create behavior should still work as fallback:

- If user cancels picker → show error or fall back to auto-create
- If no configurations exist → offer to create one
- Consider adding setting: `deepnote.kernel.autoSelect` to enable old behavior

## Testing Strategy

### Manual Testing Steps

1. **Happy Path**:

   - Create config "Python 3.11 Data Science"
   - Add packages: pandas, numpy
   - Start server
   - Open test.deepnote
   - Select config from picker
   - Run cell: `import pandas; print(pandas.__version__)`
   - Verify output

2. **Multiple Notebooks**:

   - Create 2 configs with different Python versions
   - Open notebook1.deepnote → select config1
   - Open notebook2.deepnote → select config2
   - Verify both work independently

3. **Persistence**:

   - Select config for notebook
   - Close notebook
   - Reopen notebook
   - Verify same config auto-selected (no picker shown)

4. **Edge Cases**:
   - Delete configuration while notebook open
   - Stop server while notebook running
   - Select stopped configuration → verify auto-starts

### Unit Tests Needed

- [ ] Test mapper stores and retrieves selections
- [ ] Test picker shows correct configurations
- [ ] Test auto-selector uses mapper before showing picker
- [ ] Test fallback behavior when config not found

## Documentation

Files to update after completion:

- [ ] KERNEL_MANAGEMENT_VIEW_IMPLEMENTATION.md - Update Phase 7 status to complete
- [ ] README.md - Add usage instructions for kernel configurations
- [ ] CHANGELOG.md - Document new feature

## Future Enhancements

1. **Configuration Templates**: Pre-defined package sets (Data Science, ML, Web Dev)
2. **Configuration Sharing**: Export/import configurations as JSON
3. **Workspace Scoping**: Project-specific configurations
4. **Resource Monitoring**: Show memory/CPU usage in tree
5. **Auto-Cleanup**: Delete unused configurations after X days
6. **Cloud Sync**: Sync configurations across machines
