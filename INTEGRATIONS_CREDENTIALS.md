# Deepnote Integrations & Credentials System

## Overview

The integrations system enables Deepnote notebooks to connect to external data sources (PostgreSQL, BigQuery, etc.) by securely managing credentials and exposing them to SQL blocks. The system handles:

1. **Credential Storage**: Secure storage using VSCode's SecretStorage API
2. **Integration Detection**: Automatic discovery of integrations used in notebooks
3. **UI Management**: Webview-based configuration interface
4. **Kernel Integration**: Injection of credentials into Jupyter kernel environment
5. **Toolkit Exposure**: Making credentials available to `deepnote-toolkit` for SQL execution

## Architecture

### Core Components

#### 1. **Integration Storage** (`integrationStorage.ts`)

Manages persistent storage of integration configurations using VSCode's encrypted SecretStorage API.

**Key Features:**

- Uses VSCode's `SecretStorage` API for secure credential storage
- Storage is scoped to the user's machine (shared across all Deepnote projects)
- In-memory caching for performance
- Event-driven updates via `onDidChangeIntegrations` event
- Index-based storage for efficient retrieval

**Storage Format:**

- Each integration config is stored as JSON under key: `deepnote-integrations.{integrationId}`
- An index is maintained at key: `deepnote-integrations.index` containing all integration IDs

**Key Methods:**

- `getAll()`: Retrieve all stored integration configurations
- `getIntegrationConfig(integrationId)`: Get a specific integration by ID
- `getProjectIntegrationConfig(projectId, integrationId)`: Get the effective project-scoped config
- `save(config)`: Save or update an integration configuration
- `delete(integrationId)`: Remove an integration configuration
- `exists(integrationId)`: Check if an integration is configured

**Integration Config Types:**

```typescript
// PostgreSQL
{
  id: string;
  name: string;
  type: 'postgres';
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl?: boolean;
}

// BigQuery
{
  id: string;
  name: string;
  type: 'bigquery';
  projectId: string;
  credentials: string; // JSON string of service account credentials
}
```

#### 2. **Integration Detector** (`integrationDetector.ts`)

Scans Deepnote projects to discover which integrations are used in SQL blocks.

**Detection Process:**

1. Retrieves the Deepnote project from `IDeepnoteNotebookManager`
2. Scans all notebooks in the project
3. Examines each code block for `metadata.sql_integration_id`
4. Checks if each integration is configured (has credentials)
5. Returns a map of integration IDs to their status

**Integration Status:**

- `Connected`: Integration has valid credentials stored
- `Disconnected`: Integration is used but not configured
- `Error`: Integration configuration is invalid

**Special Cases:**

- Excludes `deepnote-dataframe-sql` (internal DuckDB integration)
- Only processes code blocks with SQL integration metadata

#### 3. **Integration Manager** (`integrationManager.ts`)

Orchestrates the integration management UI and commands.

**Responsibilities:**

- Registers the `deepnote.manageIntegrations` command
- Updates VSCode context keys for UI visibility:
  - `deepnote.hasIntegrations`: True if any integrations are detected
  - `deepnote.hasUnconfiguredIntegrations`: True if any integrations lack credentials
- Handles notebook selection changes
- Opens the integration webview with detected integrations

**Command Flow:**

1. User triggers command (from command palette or SQL cell status bar)
2. Manager detects integrations in the active notebook
3. Manager opens webview with integration list
4. Optionally pre-selects a specific integration for configuration

#### 4. **Integration Webview** (`integrationWebview.ts`)

Provides the webview-based UI for managing integration credentials.

**Features:**

- Persistent webview panel (survives defocus)
- Real-time integration status updates
- Configuration forms for each integration type
- Delete/reset functionality

**Message Protocol:**

Extension → Webview:

```typescript
// Update integration list
{ type: 'update', integrations: IntegrationWithStatus[] }

// Show configuration form
{ type: 'showForm', integrationId: string, config: IntegrationConfig | null }

// Status messages
{ type: 'success' | 'error', message: string }
```

Webview → Extension:

```typescript
// Save configuration
{ type: 'save', integrationId: string, config: IntegrationConfig }

// Delete configuration
{ type: 'delete', integrationId: string }

// Request configuration form
{ type: 'configure', integrationId: string }
```

### UI Components (React)

#### 5. **Integration Panel** (`IntegrationPanel.tsx`)

Main React component that manages the webview UI state.

**State Management:**

- `integrations`: List of detected integrations with status
- `selectedIntegrationId`: Currently selected integration for configuration
- `selectedConfig`: Existing configuration being edited
- `message`: Success/error messages
- `confirmDelete`: Confirmation state for deletion

**User Flows:**

**Configure Integration:**

1. User clicks "Configure" button
2. Panel shows configuration form overlay
3. User enters credentials
4. Panel sends save message to extension
5. Extension stores credentials and updates status
6. Panel shows success message and refreshes list

**Delete Integration:**

1. User clicks "Reset" button
2. Panel shows confirmation prompt (5 seconds)
3. User clicks again to confirm
4. Panel sends delete message to extension
5. Extension removes credentials
6. Panel updates status to "Disconnected"

#### 6. **Configuration Forms** (`PostgresForm.tsx`, `BigQueryForm.tsx`)

Type-specific forms for entering integration credentials.

**PostgreSQL Form Fields:**

- Name (display name)
- Host
- Port (default: 5432)
- Database
- Username
- Password
- SSL (checkbox)

**BigQuery Form Fields:**

- Name (display name)
- Project ID
- Service Account Credentials (JSON textarea)

**Validation:**

- All fields are required
- BigQuery credentials must be valid JSON
- Port must be a valid number

### Kernel Integration

#### 7. **SQL Integration Environment Variables Provider** (`sqlIntegrationEnvironmentVariablesProvider.ts`)

Provides environment variables containing integration credentials for the Jupyter kernel.

**Process:**

1. Scans the notebook for SQL cells with `sql_integration_id` metadata
2. Retrieves credentials for each detected integration
3. Converts credentials to the format expected by `deepnote-toolkit`
4. Returns environment variables to be injected into the kernel process

**Environment Variable Format:**

Variable name: `SQL_{INTEGRATION_ID}` (uppercased, special chars replaced with `_`)

Example: Integration ID `my-postgres-db` → Environment variable `SQL_MY_POSTGRES_DB`

**Credential JSON Format:**

PostgreSQL:

```json
{
  "url": "postgresql://username:password@host:port/database",
  "params": { "sslmode": "require" },
  "param_style": "format"
}
```

BigQuery:

```json
{
  "url": "bigquery://?user_supplied_client=true",
  "params": {
    "project_id": "my-project",
    "credentials": {
      /* service account JSON */
    }
  },
  "param_style": "format"
}
```

**Integration Points:**

- Registered as an environment variable provider in the kernel environment service
- Called when starting a Jupyter kernel for a Deepnote notebook
- Environment variables are passed to the kernel process at startup

#### 8. **SQL Integration Startup Code Provider** (`sqlIntegrationStartupCodeProvider.ts`)

Injects Python code into the kernel at startup to set environment variables.

**Why This Is Needed:**
Jupyter doesn't automatically pass all environment variables from the server process to the kernel process. This provider ensures credentials are available in the kernel's `os.environ`.

**Generated Code:**

```python
try:
    import os
    # [SQL Integration] Setting N SQL integration env vars...
    os.environ['SQL_MY_POSTGRES_DB'] = '{"url":"postgresql://...","params":{},"param_style":"format"}'
    os.environ['SQL_MY_BIGQUERY'] = '{"url":"bigquery://...","params":{...},"param_style":"format"}'
    # [SQL Integration] Successfully set N SQL integration env vars
except Exception as e:
    import traceback
    print(f"[SQL Integration] ERROR: Failed to set SQL integration env vars: {e}")
    traceback.print_exc()
```

**Execution:**

- Registered with `IStartupCodeProviders` for `JupyterNotebookView`
- Runs automatically when a Python kernel starts for a Deepnote notebook
- Priority: `StartupCodePriority.Base` (runs early)
- Only runs for Python kernels on Deepnote notebooks

### Toolkit Integration

#### 9. **How Credentials Are Exposed to deepnote-toolkit**

The `deepnote-toolkit` Python package reads credentials from environment variables to execute SQL blocks.

**Flow:**

1. Extension detects SQL blocks in notebook
2. Extension retrieves credentials from secure storage
3. Extension converts credentials to JSON format
4. Extension injects credentials as environment variables (two methods):
   - **Server Process**: Via `SqlIntegrationEnvironmentVariablesProvider` when starting Jupyter server
   - **Kernel Process**: Via `SqlIntegrationStartupCodeProvider` when starting Python kernel
5. `deepnote-toolkit` reads environment variables when executing SQL blocks
6. Toolkit creates database connections using the credentials
7. Toolkit executes SQL queries and returns results

**Environment Variable Lookup:**
When a SQL block with `sql_integration_id: "my-postgres-db"` is executed:

1. Toolkit looks for environment variable `SQL_MY_POSTGRES_DB`
2. Toolkit parses the JSON value
3. Toolkit creates a SQLAlchemy connection using the `url` and `params`
4. Toolkit executes the SQL query
5. Toolkit returns results as a pandas DataFrame

## Data Flow

### Configuration Flow

```text
User → IntegrationPanel (UI)
  → vscodeApi.postMessage({ type: 'save', config })
  → IntegrationWebviewProvider.onMessage()
  → IntegrationStorage.save(config)
  → EncryptedStorage.store() [VSCode SecretStorage API]
  → IntegrationStorage fires onDidChangeIntegrations event
  → SqlIntegrationEnvironmentVariablesProvider fires onDidChangeEnvironmentVariables event
```

### Execution Flow

```text
User executes SQL cell
  → Kernel startup triggered
  → SqlIntegrationEnvironmentVariablesProvider.getEnvironmentVariables()
    → Scans notebook for SQL cells
    → Retrieves credentials from IntegrationStorage
    → Converts to JSON format
    → Returns environment variables
  → Environment variables passed to Jupyter server process
  → SqlIntegrationStartupCodeProvider.getCode()
    → Generates Python code to set os.environ
  → Startup code executed in kernel
  → deepnote-toolkit reads os.environ['SQL_*']
  → Toolkit executes SQL query
  → Results returned to notebook
```

## Security Considerations

1. **Encrypted Storage**: All credentials are stored using VSCode's SecretStorage API, which uses the OS keychain
2. **No Plaintext**: Credentials are never written to disk in plaintext
3. **Scoped Access**: Storage is scoped to the VSCode extension
4. **Environment Isolation**: Each notebook gets only the credentials it needs
5. **No Logging**: Credential values are never logged; only non-sensitive metadata (key names, counts) is logged

## Adding New Integration Types

To add a new integration type (e.g., MySQL, Snowflake):

1. **Add type to `integrationTypes.ts`**:

   ```typescript
   export enum IntegrationType {
     Postgres = 'postgres',
     BigQuery = 'bigquery',
     MySQL = 'mysql' // New type
   }

   export interface MySQLIntegrationConfig extends BaseIntegrationConfig {
     type: IntegrationType.MySQL;
     host: string;
     port: number;
     database: string;
     username: string;
     password: string;
   }

   export type IntegrationConfig = PostgresIntegrationConfig | BigQueryIntegrationConfig | MySQLIntegrationConfig;
   ```

2. **Add conversion logic in `sqlIntegrationEnvironmentVariablesProvider.ts`**:

   ```typescript
   case IntegrationType.MySQL: {
     const url = `mysql://${config.username}:${config.password}@${config.host}:${config.port}/${config.database}`;
     return JSON.stringify({ url, params: {}, param_style: 'format' });
   }
   ```

3. **Create UI form component** (`MySQLForm.tsx`)

4. **Update `ConfigurationForm.tsx`** to render the new form

5. **Update webview types** (`src/webviews/webview-side/integrations/types.ts`)

6. **Add localization strings** for the new integration type

## Testing

Unit tests are located in:

- `sqlIntegrationEnvironmentVariablesProvider.unit.test.ts`

Tests cover:

- Environment variable generation for each integration type
- Multiple integrations in a single notebook
- Missing credentials handling
- Integration ID to environment variable name conversion
- JSON format validation
