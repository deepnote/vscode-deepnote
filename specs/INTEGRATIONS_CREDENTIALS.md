# Deepnote Integrations & Credentials System

## Overview

The integrations system enables Deepnote notebooks to connect to external data sources (PostgreSQL, BigQuery, Snowflake, etc.) by securely managing credentials and exposing them to SQL blocks. The system handles:

1. **Credential Storage**: Secure storage using VSCode's SecretStorage API
2. **Integration Detection**: Automatic discovery of integrations used in notebooks
3. **UI Management**: Webview-based configuration interface
4. **Kernel Integration**: Injection of credentials into Jupyter kernel environment
5. **Toolkit Exposure**: Making credentials available to `deepnote-toolkit` for SQL execution
6. **Format Conversion**: Uses `@deepnote/database-integrations` package for standardized credential formatting

## Architecture

### External Dependencies

#### **@deepnote/database-integrations Package** (v1.1.0)

The system uses the `@deepnote/database-integrations` package as the source of truth for:

- **Type Definitions**: `DatabaseIntegrationConfig`, `DatabaseIntegrationType`
- **Metadata Schemas**: Validation schemas for each integration type (`databaseMetadataSchemasByType`)
- **Environment Variable Generation**: `getEnvironmentVariablesForIntegrations()` function
- **Auth Method Constants**: `BigQueryAuthMethods`, `SnowflakeAuthMethods`

This ensures consistency between the VSCode extension and Deepnote's cloud platform.

**Key Functions:**

- `getEnvironmentVariablesForIntegrations(configs)`: Converts integration configs to environment variables
- `databaseMetadataSchemasByType[type].safeParse(metadata)`: Validates integration metadata

**Supported Integration Types:**

The extension supports all 19 database integration types from the `@deepnote/database-integrations` package:

**SQL Databases (standard authentication):**

- `'pgsql'` - PostgreSQL
- `'mysql'` - MySQL
- `'mariadb'` - MariaDB
- `'alloydb'` - Google AlloyDB
- `'clickhouse'` - ClickHouse
- `'materialize'` - Materialize
- `'mindsdb'` - MindsDB
- `'sql-server'` - Microsoft SQL Server
- `'trino'` - Trino

**Cloud Databases (service account/key-based auth):**

- `'big-query'` - Google BigQuery (service account JSON)
- `'snowflake'` - Snowflake (password or key-pair auth)
- `'spanner'` - Google Spanner (service account JSON)
- `'cloud-sql'` - Google Cloud SQL (service account JSON)

**Cloud Databases (AWS credentials):**

- `'athena'` - Amazon Athena (access key and secret)
- `'redshift'` - Amazon Redshift (username/password or IAM)

**Cloud Databases (token-based auth):**

- `'databricks'` - Databricks (personal access token)
- `'dremio'` - Dremio (personal access token)

**NoSQL:**

- `'mongodb'` - MongoDB (connection string)

**Internal:**

- `'pandas-dataframe'` - DuckDB (automatically configured, not user-editable)

### Core Components

#### 1. **Integration Storage** (`integrationStorage.ts`)

Manages persistent storage of integration configurations using VSCode's encrypted SecretStorage API.

**Key Features:**

- Uses VSCode's `SecretStorage` API for secure credential storage
- Storage is scoped to the user's machine (shared across all Deepnote projects)
- In-memory caching for performance
- Event-driven updates via `onDidChangeIntegrations` event
- Index-based storage for efficient retrieval
- Automatic upgrade of legacy configurations to new format
- Uses `@deepnote/database-integrations` package for type definitions and validation

**Storage Format:**

- Each integration config is stored as JSON under key: `deepnote-integrations.{integrationId}`
- An index is maintained at key: `deepnote-integrations.index` containing all integration IDs
- Configs are versioned (currently version 1) to support future migrations
- Internal DuckDB integration (`deepnote-dataframe-sql`) is filtered out and not stored

**Key Methods:**

- `getAll()`: Retrieve all stored integration configurations
- `getIntegrationConfig(integrationId)`: Get a specific integration by ID
- `getProjectIntegrationConfig(projectId, integrationId)`: Get the effective project-scoped config
- `save(config)`: Save or update an integration configuration
- `delete(integrationId)`: Remove an integration configuration
- `exists(integrationId)`: Check if an integration is configured
- `clear()`: Remove all stored integrations

**Integration Config Types:**

The system uses `DatabaseIntegrationConfig` from `@deepnote/database-integrations` package:

```typescript
// PostgreSQL (type: 'pgsql')
{
  id: string;
  name: string;
  type: 'pgsql';
  metadata: {
    host: string;
    port: string;
    database: string;
    user: string;
    password: string;
    sslEnabled: boolean;
  }
}

// MySQL (type: 'mysql')
{
  id: string;
  name: string;
  type: 'mysql';
  metadata: {
    host: string;
    port: string;
    database: string;
    user: string;
    password: string;
  }
}

// MariaDB (type: 'mariadb')
{
  id: string;
  name: string;
  type: 'mariadb';
  metadata: {
    host: string;
    port: string;
    database: string;
    user: string;
    password: string;
  }
}

// AlloyDB (type: 'alloydb')
{
  id: string;
  name: string;
  type: 'alloydb';
  metadata: {
    host: string;
    port: string;
    database: string;
    user: string;
    password: string;
  }
}

// ClickHouse (type: 'clickhouse')
{
  id: string;
  name: string;
  type: 'clickhouse';
  metadata: {
    host: string;
    port: string;
    database: string;
    user: string;
    password: string;
  }
}

// Materialize (type: 'materialize')
{
  id: string;
  name: string;
  type: 'materialize';
  metadata: {
    host: string;
    port: string;
    database: string;
    user: string;
    password: string;
  }
}

// MindsDB (type: 'mindsdb')
{
  id: string;
  name: string;
  type: 'mindsdb';
  metadata: {
    host: string;
    port: string;
    database: string;
    user: string;
    password: string;
  }
}

// SQL Server (type: 'sql-server')
{
  id: string;
  name: string;
  type: 'sql-server';
  metadata: {
    host: string;
    port: string;
    database: string;
    user: string;
    password: string;
  }
}

// Trino (type: 'trino')
{
  id: string;
  name: string;
  type: 'trino';
  metadata: {
    host: string;
    port: string;
    database: string;
    user: string;
    password: string;
  }
}

// BigQuery (type: 'big-query')
{
  id: string;
  name: string;
  type: 'big-query';
  metadata: {
    authMethod: 'service-account';
    projectId: string;
    credentials: object; // Service account JSON
  }
}

// Snowflake (type: 'snowflake')
{
  id: string;
  name: string;
  type: 'snowflake';
  metadata: {
    authMethod: 'password' | 'service-account-key-pair';
    accountName: string;
    warehouse?: string;
    database?: string;
    role?: string;
    username: string;
    // For password auth:
    password: string;
    // For key-pair auth:
    privateKey: string;
    privateKeyPassphrase?: string;
  }
}

// Athena (type: 'athena')
{
  id: string;
  name: string;
  type: 'athena';
  metadata: {
    access_key_id: string;
    secret_access_key: string;
    region: string;
    s3_output_path: string;
    workgroup?: string;
  }
}

// Databricks (type: 'databricks')
{
  id: string;
  name: string;
  type: 'databricks';
  metadata: {
    host: string;
    port: string;
    httpPath: string;
    token: string;
    schema?: string;
    catalog?: string;
  }
}

// Dremio (type: 'dremio')
{
  id: string;
  name: string;
  type: 'dremio';
  metadata: {
    host: string;
    port: string;
    schema: string;
    token: string;
  }
}

// MongoDB (type: 'mongodb')
{
  id: string;
  name: string;
  type: 'mongodb';
  metadata: {
    connection_string: string;
  }
}

// Redshift (type: 'redshift')
{
  id: string;
  name: string;
  type: 'redshift';
  metadata: {
    authMethod: 'username-and-password' | 'individual-credentials';
    host: string;
    port?: string;
    database: string;
    // For username-and-password auth:
    user: string;
    password: string;
    // For individual-credentials auth (uses AWS credentials from environment)
  }
}

// Spanner (type: 'spanner')
{
  id: string;
  name: string;
  type: 'spanner';
  metadata: {
    instance: string;
    database: string;
    service_account: string; // JSON string
    dataBoostEnabled: boolean;
  }
}

// Cloud SQL (type: 'cloud-sql')
{
  id: string;
  name: string;
  type: 'cloud-sql';
  metadata: {
    service_account: string; // JSON string
  }
}
```

**Note:** The `pandas-dataframe` type is an internal integration that is automatically configured and cannot be modified by users.

**Legacy Config Upgrade:**

When loading configurations from storage, the system automatically detects and upgrades legacy configs (pre-`@deepnote/database-integrations`) using `upgradeLegacyIntegrationConfig()`. Invalid or unsupported configs are filtered out during loading.

#### 1a. **Legacy Integration Config Utils** (`legacyIntegrationConfigUtils.ts`)

Handles migration of legacy integration configurations to the new `@deepnote/database-integrations` format.

**Key Function:**

- `upgradeLegacyIntegrationConfig(legacyConfig)`: Converts legacy config to new format

**Upgrade Process:**

1. Detects legacy config format (missing `version` field)
2. Maps legacy type names to new type names:
   - `'postgres'` → `'pgsql'`
   - `'bigquery'` → `'big-query'`
   - `'snowflake'` → `'snowflake'`
3. Restructures config to use `metadata` field
4. Converts Snowflake auth methods to new constants
5. Validates using `databaseMetadataSchemasByType`
6. Returns `null` for invalid or unsupported configs

**Unsupported Snowflake Auth Methods:**

- `'OKTA'` - User-specific, not supported in VSCode
- `'NATIVE_SNOWFLAKE'` - User-specific, not supported in VSCode
- `'AZURE_AD'` - User-specific, not supported in VSCode
- `'KEY_PAIR'` - Legacy, replaced by `'SERVICE_ACCOUNT_KEY_PAIR'`

#### 2. **Integration Detector** (`integrationDetector.ts`)

Lists the integrations a Deepnote project declares, paired with the credentials stored for each.

**Detection Process:**

1. Retrieves the Deepnote project from `IDeepnoteNotebookManager`
2. Iterates the project's `integrations` roster (ids, names and types only — never credentials)
3. Skips entries whose type is not a configurable `DatabaseIntegrationType`
4. Reads each integration's config from `SecretStorage`, or `null` when nothing is stored
5. Appends `.deepnote.env.yaml` integrations the roster omits, so the panel lists what actually applies at
   execution time; a failed lookup leaves the roster-only result rather than blocking the panel
6. Returns a map of integration IDs to their config and declared name/type

**Special Cases:**

- Excludes `deepnote-dataframe-sql` (internal DuckDB integration)
- Integrations configured in `.deepnote.env.yaml` have a `null` config here, since those configs are never
  written through `SecretStorage`. They still resolve normally for kernel execution and SQL autocomplete, which
  read the merged configs directly, and the panel marks them read-only rather than unconfigured (see below):
  `IntegrationWebviewProvider` pairs the detection result with the file-configured ids.

#### 3. **Integration Manager** (`integrationManager.ts`)

Orchestrates the integration management UI and commands.

**Responsibilities:**

- Registers the `deepnote.manageIntegrations` command
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
- Real-time updates as credentials are saved or cleared
- Configuration forms for each integration type
- Delete/reset functionality

**Connection Status:**

`IntegrationItem.tsx` derives the status pill from two inputs: `config` (the SecretStorage credentials the panel
can edit) and `isFileConfigured`, which `IntegrationWebviewProvider` computes from
`ISqlIntegrationEnvVarsProvider.getFileConfiguredIntegrationIds()`. That call returns ids only, so neither the
file's config nor its credentials ever reach the webview.

- **"Configured in file"** — `.deepnote.env.yaml` configures this id. Rendered with the connected styling, and
  the Configure/Reset/Delete actions are hidden: the panel writes `SecretStorage` only and the file wins the
  merge, so those edits would be silent no-ops at runtime. This holds even when SecretStorage also happens to
  hold a config for the same id.
- **"Connected"** — SecretStorage holds credentials and no file config overrides them.
- **"Not Configured"** — neither layer configures the integration.

The separate federated-auth pill (BigQuery + `google-oauth`) is independent and tracks whether a refresh token
is stored. It is driven by `tokenStatus` alone, which the extension derives from its own candidate set, so the
Authenticate action stays available for file-configured integrations — exactly the rows that carry no `config`.

**Message Protocol:**

Extension → Webview:

```typescript
// Update integration list
{ type: 'update', integrations: DetectedIntegration[] }

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

- `integrations`: List of detected integrations with their stored configs
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
5. Extension stores credentials
6. Panel shows success message and refreshes list

**Delete Integration:**

1. User clicks "Reset" button
2. Panel shows confirmation prompt (5 seconds)
3. User clicks again to confirm
4. Panel sends delete message to extension
5. Extension removes credentials
6. Panel clears the stored config, so the item offers "Configure" again

#### 6. **Configuration Forms**

Type-specific forms for entering integration credentials.

**Standard Database Forms** (`PostgresForm.tsx`, `MySQLForm.tsx`, `MariaDBForm.tsx`, `GenericDatabaseForm.tsx`):

Most SQL databases use a standard form with these fields:

- Name (display name)
- Host
- Port (with database-specific defaults)
- Database
- Username
- Password
- SSL (PostgreSQL only)

Supported databases with standard forms:

- PostgreSQL (port 5432, with SSL option)
- MySQL (port 3306)
- MariaDB (port 3306)
- AlloyDB (port 5432)
- ClickHouse (port 8123)
- Materialize (port 6875)
- MindsDB (port 47334)
- SQL Server (port 1433)
- Trino (port 8080)

**BigQuery Form** (`BigQueryForm.tsx`):

- Name (display name)
- Project ID
- Service Account Credentials (JSON textarea)

**Snowflake Form** (`SnowflakeForm.tsx`):

- Name (display name)
- Account Name
- Warehouse (optional)
- Database (optional)
- Role (optional)
- Username
- Authentication Method (dropdown):
  - Password
  - Service Account Key Pair
- For Password auth:
  - Password
- For Key Pair auth:
  - Private Key (textarea)
  - Private Key Passphrase (optional)

**AWS Integration Forms** (`AthenaForm.tsx`, `RedshiftForm.tsx`):

- **Athena**: AWS Access Key ID, Secret Access Key, Region, S3 Output Path, Workgroup (optional)
- **Redshift**: Authentication Method (username/password or IAM), Cluster Endpoint, Port, Database, Username/Password (for username/password auth)

**Token-Based Forms** (`DatabricksForm.tsx`, `DremioForm.tsx`):

- **Databricks**: Server Hostname, HTTP Path, Access Token, Port, Catalog (optional), Schema (optional)
- **Dremio**: Host, Port, Schema, Personal Access Token

**NoSQL Forms** (`MongoDBForm.tsx`):

- **MongoDB**: Connection String (supports mongodb:// and mongodb+srv:// formats)

**Google Cloud Forms** (`SpannerForm.tsx`, `CloudSqlForm.tsx`):

- **Spanner**: Instance ID, Database, Service Account JSON, Data Boost Enabled (checkbox)
- **Cloud SQL**: Service Account JSON

**Validation:**

- All required fields must be filled
- BigQuery credentials must be valid JSON
- Port must be a valid number
- Snowflake private key must be in PEM format
- Forms use the metadata structure from `@deepnote/database-integrations`

### Kernel Integration

#### 7. **SQL Integration Environment Variables Provider** (`sqlIntegrationEnvironmentVariablesProvider.ts`)

Provides environment variables containing integration credentials for the Jupyter kernel.

**Process:**

1. Identifies the Deepnote project from the notebook resource
2. Retrieves project integrations from the notebook manager
3. Fetches configured credentials from `IIntegrationStorage` for each integration
4. Always includes the internal DuckDB integration (`deepnote-dataframe-sql`)
5. Uses `getEnvironmentVariablesForIntegrations()` from `@deepnote/database-integrations` to convert credentials
6. Returns environment variables to be injected into the kernel process

**Note:** This provider makes credentials for ALL integrations in the Deepnote project available as environment variables. This ensures that integrations are available project-wide, matching Deepnote's behavior where integrations are project-scoped.

**Environment Variable Format:**

Variable name: `SQL_{INTEGRATION_ID}` (uppercased, special chars replaced with `_`)

Example: Integration ID `my-postgres-db` → Environment variable `SQL_MY_POSTGRES_DB`

**Credential JSON Format:**

The `@deepnote/database-integrations` package generates the credential JSON in the format expected by `deepnote-toolkit`:

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

Snowflake (password auth):

```json
{
  "url": "snowflake://username:password@account/database?warehouse=wh&role=role&application=Deepnote",
  "params": {},
  "param_style": "pyformat"
}
```

Snowflake (key-pair auth):

```json
{
  "url": "snowflake://username@account/database?warehouse=wh&role=role&authenticator=snowflake_jwt&application=Deepnote",
  "params": {
    "snowflake_private_key": "base64_encoded_key",
    "snowflake_private_key_passphrase": "passphrase"
  },
  "param_style": "pyformat"
}
```

DuckDB (internal):

```json
{
  "url": "duckdb:///:memory:",
  "params": {},
  "param_style": "qmark"
}
```

**Integration Points:**

- Backs the loopback `userpod-api` endpoint (`userpodApiEndpoints.node.ts`), which serves the resolved credentials to `deepnote-toolkit` as `[{name, value}]`
- Queried per request rather than at kernel start, so a kernel always reads the credentials that are current at the moment it asks
- Fires `onDidChangeEnvironmentVariables` event when integration storage changes

### Toolkit Integration

#### 8. **How Credentials Are Exposed to deepnote-toolkit**

The `deepnote-toolkit` Python package reads credentials from environment variables to execute SQL blocks.

**Flow:**

1. Extension starts the Jupyter server with the integration endpoint env vars applied by `applyIntegrationEndpointEnv` (`DEEPNOTE_RUNTIME__ENV_INTEGRATION_ENABLED`, `DEEPNOTE_RUNTIME__RUNNING_IN_DETACHED_MODE`, `DEEPNOTE_RUNTIME__WEBAPP_URL`, `DEEPNOTE_RUNTIME__PROJECT_SECRET`, `DEEPNOTE_PROJECT_ID`) — no credentials are injected by the extension
2. At kernel init, `deepnote-toolkit`'s `set_integration_env()` calls the extension's loopback `userpod-api` endpoint at `DEEPNOTE_RUNTIME__WEBAPP_URL`, authenticating with the per-project bearer token in `DEEPNOTE_RUNTIME__PROJECT_SECRET`
3. The endpoint resolves the project's integrations via `SqlIntegrationEnvironmentVariablesProvider` — reading secure storage and converting the configs to `SQL_*` JSON values — and returns them as `[{name, value}]`
4. Toolkit sets the returned variables into the kernel's `os.environ`
5. `deepnote-toolkit` reads those environment variables when executing SQL blocks
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
    → Validates config using @deepnote/database-integrations schemas
    → Adds version field (version: 1)
    → EncryptedStorage.store() [VSCode SecretStorage API]
    → Updates in-memory cache
    → Updates index
  → IntegrationStorage fires onDidChangeIntegrations event
  → SqlIntegrationEnvironmentVariablesProvider fires onDidChangeEnvironmentVariables event
```

### Execution Flow

```text
Deepnote server starts
  → applyIntegrationEndpointEnv()
    → Awaits UserpodApiEndpoints readiness, reads its loopback baseUrl
    → Resolves the project id from the .deepnote file
    → Sets DEEPNOTE_RUNTIME__* + DEEPNOTE_PROJECT_ID on the server process
  → Jupyter server process starts with those env vars (no credentials)

User executes SQL cell
  → Kernel startup triggered
  → deepnote-toolkit set_integration_env()
    → GET {DEEPNOTE_RUNTIME__WEBAPP_URL}/userpod-api/{projectId}/integrations/environment-variables
      Authorization: Bearer {DEEPNOTE_RUNTIME__PROJECT_SECRET}
  → UserpodApiEndpoints handles the request
    → Verifies the per-project bearer token
    → Finds the open deepnote notebook(s) for that project id
    → SqlIntegrationEnvironmentVariablesProvider.getEnvironmentVariables()
      → Retrieves project integrations from notebook manager
      → Fetches configured credentials from IntegrationStorage
      → Adds internal DuckDB integration
      → Calls getEnvironmentVariablesForIntegrations() from @deepnote/database-integrations
        → Converts configs to environment variable format
        → Generates SQL_* environment variables
      → Returns environment variables
    → Responds with [{name, value}]
  → Toolkit sets them into the kernel's os.environ
  → deepnote-toolkit reads os.environ['SQL_*']
  → Toolkit executes SQL query
  → Results returned to notebook
```

## Key Architectural Changes

### Migration to @deepnote/database-integrations

The system was refactored to use the `@deepnote/database-integrations` package as the source of truth for integration types and credential formatting. This provides:

**Benefits:**

1. **Consistency**: Same type definitions and validation as Deepnote's cloud platform
2. **Maintainability**: Credential formatting logic is centralized in one package
3. **Type Safety**: Strong TypeScript types from the package
4. **Extensibility**: New integration types can be added by updating the package

**Key Changes:**

1. **Type Definitions**:

   - Old: `IntegrationType` enum with `'postgres'`, `'bigquery'`, `'snowflake'`
   - New: `DatabaseIntegrationType` from package with `'pgsql'`, `'big-query'`, `'snowflake'`, `'pandas-dataframe'`

2. **Config Structure**:

   - Old: Flat structure with credentials at top level
   - New: Nested structure with `metadata` field containing credentials

3. **Environment Variable Generation**:

   - Old: Manual conversion logic in `sqlIntegrationEnvironmentVariablesProvider.ts`
   - New: Delegated to `getEnvironmentVariablesForIntegrations()` from package

4. **Validation**:

   - Old: Manual validation in forms
   - New: Schema-based validation using `databaseMetadataSchemasByType`

5. **Legacy Support**:
   - Automatic upgrade of old configs via `upgradeLegacyIntegrationConfig()`
   - Versioned storage format for future migrations

## Security Considerations

1. **Encrypted Storage**: All credentials are stored using VSCode's SecretStorage API, which uses the OS keychain
2. **No Plaintext**: Credentials are never written to disk in plaintext
3. **Scoped Access**: Storage is scoped to the VSCode extension
4. **Environment Isolation**: Each project gets credentials for all configured integrations
5. **No Logging**: Credential values are never logged; only non-sensitive metadata (key names, counts) is logged

## Adding New Integration Types

The extension now supports all 19 integration types from the `@deepnote/database-integrations` package. To add support for a new integration type in the future:

1. **Add support to `@deepnote/database-integrations` package** (if not already supported):

   - Add type definition and metadata schema
   - Add conversion logic for environment variables
   - This is the source of truth for integration types

2. **Determine the form type needed**:

   - **Standard database** (host, port, database, user, password): Use `GenericDatabaseForm`
   - **Complex authentication**: Create a custom form component or use `UnsupportedIntegrationForm`

3. **For standard databases using `GenericDatabaseForm`**:

   Update `ConfigurationForm.tsx` to add a case:

   ```typescript
   case 'new-database':
     return (
       <GenericDatabaseForm
         integrationId={integrationId}
         existingConfig={existingConfig?.type === 'new-database' ? existingConfig : null}
         defaultName={defaultName}
         formConfig={{
           type: 'new-database',
           displayName: 'New Database',
           defaultPort: '5432',
           localizationPrefix: 'integrationsNewDatabase'
         }}
         onSave={onSave}
         onCancel={onCancel}
       />
     );
   ```

4. **For complex authentication**:

   Create a custom form component following the pattern of `BigQueryForm.tsx` or `SnowflakeForm.tsx`:

   - Use the metadata structure from `@deepnote/database-integrations`
   - Validate inputs according to the package's schema
   - Add the form to `ConfigurationForm.tsx`

5. **Update type labels**:

   - Add case to `getIntegrationTypeLabel()` in `sqlCellStatusBarProvider.ts`
   - Add case to `getIntegrationTypeLabel()` in `IntegrationItem.tsx`

6. **Add localization strings** for the new integration type:

   - Integration name
   - Form field labels
   - Error messages

7. **Update documentation** (`integrations_credentials.md`):

   - Add to supported integration types list
   - Add metadata schema example
   - Update configuration forms section

8. **Add tests**:
   - Unit tests for the form component (if custom)
   - Integration tests for storage and environment variable generation

**Note:** The credential-to-environment-variable conversion is handled automatically by `@deepnote/database-integrations`, so no manual conversion logic is needed in the VSCode extension.

## Testing

Unit tests are located in:

- `sqlIntegrationEnvironmentVariablesProvider.unit.test.ts` - Environment variable provider tests
- `integrationStorage.unit.test.ts` - Storage and persistence tests
- `legacyIntegrationConfigUtils.unit.test.ts` - Legacy config upgrade tests

**Environment Variables Provider Tests** cover:

- Environment variable generation for each integration type (PostgreSQL, BigQuery, Snowflake)
- Project integration retrieval and filtering
- DuckDB integration inclusion
- Integration config retrieval from storage
- Event emission when integrations change
- Real environment variable format validation

**Integration Storage Tests** cover:

- CRUD operations (create, read, update, delete)
- Loading from encrypted storage
- Filtering out invalid configs
- Filtering out pandas-dataframe type
- Event emission on changes
- Cache management
- Index handling (empty, missing, corrupted)

**Legacy Config Upgrade Tests** cover:

- PostgreSQL config upgrade
- BigQuery config upgrade
- Snowflake config upgrade (all auth methods)
- Unsupported auth method handling
- Invalid metadata handling
- Unknown integration type handling
