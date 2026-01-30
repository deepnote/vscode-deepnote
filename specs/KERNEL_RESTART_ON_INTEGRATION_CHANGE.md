# Automatic Kernel Restart on Integration Configuration Changes

## Overview

This feature automatically restarts Jupyter kernels when integration configurations (e.g., PostgreSQL, BigQuery, Snowflake credentials) are changed. This ensures that running kernels immediately pick up new credentials without requiring manual intervention.

## Implementation

### New Service: `IntegrationKernelRestartHandler`

**Location**: `src/notebooks/deepnote/integrations/integrationKernelRestartHandler.ts`

**Purpose**: Listens for integration configuration changes and automatically restarts affected kernels.

**Key Features**:
- Listens to `onDidChangeIntegrations` event from `IntegrationStorage`
- Scans all open Deepnote notebooks for SQL cells that use integrations
- Identifies running kernels that need to be restarted
- Restarts affected kernels in parallel
- Shows user-friendly notifications about the restart

### How It Works

1. **Configuration Change Detection**
   - When a user saves or deletes an integration configuration in the webview
   - `IntegrationStorage.save()` or `IntegrationStorage.delete()` is called
   - This fires the `onDidChangeIntegrations` event

2. **Event Handling**
   - `IntegrationKernelRestartHandler` receives the event
   - It scans all open notebook documents with type `'deepnote'`
   - For each notebook, it checks if there's a running kernel
   - It examines cells for `sql_integration_id` metadata to determine if the notebook uses SQL integrations

3. **Kernel Restart**
   - Kernels for notebooks that use SQL integrations are restarted using `kernel.restart()`
   - Restarts happen in parallel for better performance
   - User receives a notification: "Integration configuration updated. N kernel(s) restarted to apply changes."

4. **Credential Injection**
   - When the kernel restarts, `SqlIntegrationStartupCodeProvider` automatically injects the new credentials
   - Environment variables are updated with the new integration configurations
   - SQL cells can immediately use the updated credentials

### Architecture Changes

```
┌─────────────────────────────────────────────────────────────────┐
│ User saves integration config in webview                         │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ IntegrationStorage.save(config)                                  │
│ - Stores to encrypted storage (VSCode SecretStorage API)         │
│ - Updates in-memory cache                                        │
│ - Fires onDidChangeIntegrations event ────────────────────┐     │
└──────────────────────────────────────────────────────────┼─────┘
                                                             │
            ┌────────────────────────────────────────────────┤
            │                                                │
            ▼                                                ▼
┌──────────────────────────────────┐    ┌──────────────────────────────────┐
│ SqlIntegrationEnvironmentVars    │    │ IntegrationKernelRestartHandler  │
│ VariablesProvider                │    │ (NEW)                            │
│ - Fires onDidChangeEnvVars       │    │ - Scans open notebooks           │
│                                  │    │ - Finds kernels using SQL        │
│                                  │    │ - Restarts affected kernels      │
└──────────────────────────────────┘    └─────────────┬────────────────────┘
                                                       │
                                                       ▼
                                        ┌──────────────────────────────┐
                                        │ Kernel restarts              │
                                        │ - SqlIntegrationStartup      │
                                        │   CodeProvider injects       │
                                        │   new credentials            │
                                        │ - SQL cells work with new    │
                                        │   credentials                │
                                        └──────────────────────────────┘
```

### Service Registration

The service is registered in both node and web environments:
- `src/notebooks/serviceRegistry.node.ts`
- `src/notebooks/serviceRegistry.web.ts`

Registered as an `IExtensionSyncActivationService`, which means it's automatically activated when the extension loads.

## Benefits

1. **Seamless Experience**: Users don't need to manually restart kernels after changing credentials
2. **Immediate Effect**: New credentials are available immediately after configuration
3. **Smart Detection**: Only restarts kernels that actually use SQL integrations
4. **User Feedback**: Clear notifications inform users about the restart
5. **Error Resilient**: If one kernel fails to restart, others continue

## Technical Details

### Dependencies
- `IIntegrationStorage`: To listen for configuration changes
- `IKernelProvider`: To access and restart kernels
- `IDisposableRegistry`: To manage event subscriptions

### Key Methods

**`onIntegrationConfigurationChanged()`**
- Main handler for integration changes
- Prevents concurrent restart attempts using `isRestarting` flag
- Scans workspace notebooks for Deepnote notebooks with running kernels
- Filters to only notebooks that use SQL integrations

**`notebookUsesSqlIntegrations(notebook)`**
- Scans notebook cells for SQL language
- Checks cell metadata for `sql_integration_id`
- Excludes internal DuckDB integration (`deepnote-dataframe-sql`)
- Returns true if notebook uses external SQL integrations

### Error Handling
- Individual kernel restart failures don't stop other restarts
- Errors are logged but don't throw exceptions
- User is still notified of successful restarts

## Testing

The service can be tested similar to `SqlCellStatusBarProvider`:
1. Mock `IIntegrationStorage` with an `EventEmitter` for `onDidChangeIntegrations`
2. Mock `IKernelProvider` to return test kernels
3. Fire the event and verify `kernel.restart()` is called for appropriate notebooks

Example test structure:
```typescript
test('restarts kernels when integration changes', async () => {
    const onDidChangeIntegrations = new EventEmitter<void>();
    when(integrationStorage.onDidChangeIntegrations).thenReturn(onDidChangeIntegrations.event);
    
    handler.activate();
    
    // Fire integration change event
    onDidChangeIntegrations.fire();
    
    // Verify kernel.restart() was called
    verify(mockKernel.restart()).once();
});
```

## Future Enhancements

Potential improvements:
1. **Selective Restart**: Only restart kernels that use the specific integration that changed
2. **Confirmation Dialog**: Ask user before restarting (optional setting)
3. **Restart Queue**: Batch multiple integration changes to avoid multiple restarts
4. **Active Execution Check**: Warn if cells are currently executing
5. **Kernel State Preservation**: Try to preserve kernel variables across restart (advanced)

## Related Files

- `src/notebooks/deepnote/integrations/integrationWebview.ts` - Webview that triggers config saves
- `src/platform/notebooks/deepnote/integrationStorage.ts` - Storage layer that fires events
- `src/platform/notebooks/deepnote/sqlIntegrationEnvironmentVariablesProvider.ts` - Environment variable provider
- `src/notebooks/deepnote/integrations/sqlIntegrationStartupCodeProvider.ts` - Injects credentials on kernel start
- `src/kernels/kernel.ts` - Kernel restart implementation

