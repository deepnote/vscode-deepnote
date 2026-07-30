# Live Integration Environment Refresh

## Overview

When integration credentials change — either in the extension's SecretStorage or in a `.deepnote.env.yaml` /
`.env` file — running Jupyter kernels pick up the new values **without a restart**. The kernel is asked to
re-fetch its integration environment in place, so variables, imports and loaded data survive the change.

This replaces the earlier design, which restarted every kernel that used SQL integrations and re-injected
credentials through startup code.

## Why no restart

Credentials are no longer baked into the kernel at startup. Instead the extension runs a small loopback HTTP
server (`UserpodApiEndpoints`) and `deepnote-toolkit` fetches integration env vars from it on demand. Because
the source of truth lives on the extension side, refreshing is just a matter of telling the toolkit to fetch
again — restarting the kernel would throw away user state for no benefit.

## Components

### 1. `IntegrationEnvRefreshHandler` (`integrationEnvRefreshHandler.ts`)

Reacts to **SecretStorage** changes.

- Subscribes to `IIntegrationStorage.onDidChangeIntegrations` (fired by `IntegrationStorage.save()` / `delete()`)
- Collects every open notebook of type `deepnote`
- Hands them to `IIntegrationEnvLiveRefresher`

### 2. `IntegrationsEnvFileWatcher` (`integrationsEnvFileWatcher.node.ts`)

Reacts to **file** changes.

- Watches `.deepnote.env.yaml` and `.env` in each workspace folder and in every open notebook's directory
- Debounces bursts (500 ms trailing edge) so saving both files is handled once
- For each open Deepnote notebook, keeps it only when all of the following hold:
    1. `deepnote.integrations.envFile.enabled` is on for that file — the same gate the config provider uses, via
       the shared `isIntegrationsEnvFileEnabled()` helper
    2. the changed directory is the notebook's own directory or its workspace root
    3. a `.deepnote.env.yaml` actually exists for it — otherwise an unrelated `.env` (a very common
       non-Deepnote file) would trigger hidden kernel executions and a misleading status message
- Hands the survivors to `IIntegrationEnvLiveRefresher`

### 3. `IntegrationEnvLiveRefresher` (`integrationEnvLiveRefresher.node.ts`)

Performs the refresh, for both triggers.

- Skips notebooks with no kernel, or whose kernel has never started
- Runs a hidden execution in each remaining kernel:

    ```python
    import deepnote_toolkit
    deepnote_toolkit.set_integration_env()
    ```

- Treats `error` outputs as a failed refresh and logs them
- On at least one success, shows a transient status-bar message ("Deepnote integration environment updated.")
  for 5 seconds rather than a toast, so frequent env-file edits don't spam notifications

### 4. `UserpodApiEndpoints` (`userpodApiEndpoints.node.ts`)

Serves the credentials the toolkit fetches.

- Binds an ephemeral port on `127.0.0.1`
- `GET /userpod-api/:projectId/integrations/environment-variables` returns `[{ name, value }]`
- Requires a per-project bearer token, compared in constant time
- Resolves values through `ISqlIntegrationEnvVarsProvider.getEnvironmentVariables()`, which merges SecretStorage
  with `.deepnote.env.yaml` (the file wins)

The endpoint URL and token reach the kernel via `applyIntegrationEndpointEnv()`
(`src/kernels/deepnote/deepnoteIntegrationEndpointEnv.ts`), which sets `DEEPNOTE_RUNTIME__WEBAPP_URL`,
`DEEPNOTE_RUNTIME__PROJECT_SECRET`, `DEEPNOTE_RUNTIME__ENV_INTEGRATION_ENABLED`,
`DEEPNOTE_RUNTIME__RUNNING_IN_DETACHED_MODE` and `DEEPNOTE_PROJECT_ID` at spawn time.

## Flow

```
┌──────────────────────────────────┐   ┌──────────────────────────────────┐
│ User saves config in the panel   │   │ `.deepnote.env.yaml` / `.env`    │
│                                  │   │ created, changed or deleted      │
└────────────────┬─────────────────┘   └────────────────┬─────────────────┘
                 │                                      │
                 ▼                                      ▼
┌──────────────────────────────────┐   ┌──────────────────────────────────┐
│ IntegrationStorage               │   │ IntegrationsEnvFileWatcher       │
│ - Writes to SecretStorage        │   │ - Debounces 500 ms               │
│ - Fires onDidChangeIntegrations  │   │ - Filters to affected notebooks  │
└────────────────┬─────────────────┘   └────────────────┬─────────────────┘
                 │                                      │
                 ▼                                      │
┌──────────────────────────────────┐                    │
│ IntegrationEnvRefreshHandler     │                    │
│ - Collects open .deepnote docs   │                    │
└────────────────┬─────────────────┘                    │
                 │                                      │
                 └──────────────┬───────────────────────┘
                                ▼
                 ┌──────────────────────────────────┐
                 │ IntegrationEnvLiveRefresher      │
                 │ - Hidden exec per live kernel:   │
                 │   set_integration_env()          │
                 └────────────────┬─────────────────┘
                                  │  HTTP (loopback, bearer token)
                                  ▼
                 ┌──────────────────────────────────┐
                 │ UserpodApiEndpoints              │
                 │ - Merges SecretStorage + file    │
                 │ - Returns [{name, value}]        │
                 └────────────────┬─────────────────┘
                                  ▼
                 ┌──────────────────────────────────┐
                 │ Kernel env updated in place      │
                 │ - SQL cells use new credentials  │
                 │ - No restart, no state lost      │
                 └──────────────────────────────────┘
```

## Service Registration

All four services are **node-only** — they are registered in `src/notebooks/serviceRegistry.node.ts` and have no
web counterpart, since the loopback server and the file reads both require Node APIs. The web registry
(`serviceRegistry.web.ts`) registers only the storage, detector, webview and manager.

`IntegrationEnvRefreshHandler`, `IntegrationsEnvFileWatcher` and `UserpodApiEndpoints` are registered as
`IExtensionSyncActivationService`, so they activate with the extension.

## Error Handling

- `IntegrationEnvLiveRefresher.refreshNotebook()` never throws; a per-notebook failure is logged and the other
  notebooks still refresh
- Both triggers wrap their async entry point and log rather than surfacing an unhandled rejection
- A refresh that produces `error` outputs is counted as failed, so the success message only appears when at
  least one kernel actually applied the new environment
- `UserpodApiEndpoints` keeps a persistent `error` listener (an `error` with no listener would crash the
  extension host) and, once it has been listening, offers a window reload if the server dies — restarting in
  place would bind a new port that already-running kernels don't know about

## Testing

- `integrationEnvLiveRefresher.node.unit.test.ts` — kernel selection, hidden execution, error outputs
- `integrationEnvRefreshHandler.unit.test.ts` — SecretStorage event → refresh
- `integrationsEnvFileWatcher.node.unit.test.ts` — debounce, scoping, the `enabled` gate and the
  "no `.deepnote.env.yaml`, no refresh" rule
- `userpodApiEndpoints.node.unit.test.ts` — auth, project scoping, payload shape

## Related Files

- `src/notebooks/deepnote/integrations/integrationEnvRefreshHandler.ts` — SecretStorage trigger
- `src/notebooks/deepnote/integrations/integrationsEnvFileWatcher.node.ts` — file trigger
- `src/notebooks/deepnote/integrations/integrationEnvLiveRefresher.node.ts` — performs the refresh
- `src/notebooks/deepnote/integrations/userpodApiEndpoints.node.ts` — serves credentials over loopback
- `src/kernels/deepnote/deepnoteIntegrationEndpointEnv.ts` — injects the endpoint URL and token into kernel env
- `src/platform/notebooks/deepnote/integrationStorage.ts` — storage layer that fires the change event
- `src/platform/notebooks/deepnote/sqlIntegrationEnvironmentVariablesProvider.ts` — merges SecretStorage and file
- `src/platform/notebooks/deepnote/integrationsEnvFileSettings.ts` — the shared `envFile.enabled` gate
