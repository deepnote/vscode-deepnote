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

### ⚠️ Current Challenge: Controller Disposal & Environment Switching

**Issue**: When switching environments, we encountered a "notebook controller is DISPOSED" error that occurs when:
1. User queues cell execution (VS Code stores reference to current controller)
2. User switches environments via tree view
3. New controller is created and set as preferred
4. Old controller is disposed
5. Queued execution tries to run 5+ seconds later → DISPOSED error

**Current Workaround** (implemented but not ideal):
- We do **NOT** dispose old controllers at all
- Old controllers are left alive to handle any queued executions
- New controller is marked as "Preferred" so new executions use it
- Garbage collection cleans up old controllers eventually

**Why This Is Not Ideal**:
- Memory leak potential if many environment switches occur
- No guarantee that new executions will use the new controller
- VS Code's controller selection logic is not fully deterministic
- Users might still execute on old environment after switch

**What We've Tried**:
1. ❌ Adding delay before disposal → Still failed (timing unpredictable)
2. ❌ Disposing after marking new controller as preferred → Still failed
3. ✅ Never disposing old controllers → Prevents error but suboptimal

**Proper Solution Needed**:
- Need a way to force VS Code to use the new controller immediately
- Or need to cancel/migrate queued executions to new controller
- Or need VS Code API to query if controller has pending executions
- May require upstream VS Code API changes

**Related Code**:
- src/notebooks/deepnote/deepnoteKernelAutoSelector.node.ts:306-315 (non-disposal logic)
- src/notebooks/deepnote/deepnoteKernelAutoSelector.node.ts:599-635 (extracted selectKernelSpec)
- src/kernels/deepnote/environments/deepnoteEnvironmentsView.ts:542-561 (warning dialog)

**Testing Done**:
- ✅ All 40+ unit tests passing
- ✅ Kernel selection logic extracted and tested
- ✅ Port allocation refactored (both jupyterPort and lspPort)
- ⚠️ Environment switching works but with above limitations

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

2. **Multiple Notebooks**:
   - Create 2 configs with different Python versions
   - Open notebook1.deepnote → select config1
   - Open notebook2.deepnote → select config2
   - Verify both work independently

3. **Auto-Start Flow**:
   - Stop server for a configuration
   - Open notebook that uses that config
   - Verify server auto-starts before kernel connects

4. **Fallback Flow**:
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
