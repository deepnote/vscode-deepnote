# Orphan Process Cleanup Implementation

## Overview

This document describes the implementation of a sophisticated orphan process cleanup mechanism for the Deepnote server starter that prevents terminating active servers from other VS Code windows.

## Problem Statement

Previously, the cleanup logic in `cleanupOrphanedProcesses()` would force-kill **every** process matching "deepnote_toolkit server", which could terminate active servers from other VS Code windows, causing disruption to users working in multiple windows.

## Solution

The new implementation uses a lock file system combined with parent process verification to only kill genuine orphan processes.

## Key Components

### 1. Session Management

- **Session ID**: Each VS Code window instance generates a unique session ID using `generateUuid()`
- **Lock File Directory**: Lock files are stored in `${os.tmpdir()}/vscode-deepnote-locks/`
- **Lock File Format**: JSON files named `server-{pid}.json` containing:
  ```typescript
  interface ServerLockFile {
    sessionId: string; // Unique ID for the VS Code window
    pid: number; // Process ID of the server
    timestamp: number; // When the server was started
  }
  ```

### 2. Lock File Lifecycle

#### Creation

- When a server starts successfully, a lock file is written with the server's PID and current session ID
- Location: `writeLockFile()` called in `startServerImpl()` after the server process is spawned

#### Deletion

- Lock files are deleted when:
  1. The server is explicitly stopped via `stopServerImpl()`
  2. The extension is disposed and all servers are shut down
  3. An orphaned process is successfully killed during cleanup

### 3. Orphan Detection Logic

The `isProcessOrphaned()` method checks if a process is truly orphaned by verifying its parent process:

#### Unix/Linux/macOS

```bash
# Get parent process ID
ps -o ppid= -p <pid>

# Check if parent exists (using -o pid= to get only PID with no header)
ps -p <ppid> -o pid=
```

- If PPID is 1 (init/systemd), the process is orphaned
- If parent process doesn't exist (empty stdout from `ps -o pid=`), the process is orphaned
- The `-o pid=` flag ensures no header is printed, so empty output reliably indicates a missing process

#### Windows

```cmd
# Get parent process ID
wmic process where ProcessId=<pid> get ParentProcessId

# Check if parent exists
tasklist /FI "PID eq <ppid>" /FO CSV /NH
```

- If parent process doesn't exist or PPID is 0, the process is orphaned

### 4. Cleanup Decision Flow

When `cleanupOrphanedProcesses()` runs (at extension startup):

1. **Find all deepnote_toolkit server processes**

   - Use `ps aux` (Unix) or `tasklist` (Windows)
   - Extract PIDs of matching processes

2. **For each candidate PID:**

   a. **Check for lock file**

   - If lock file exists:

     - If session ID matches current session → **SKIP** (shouldn't happen at startup)
     - If session ID differs:
       - Check if process is orphaned
       - If orphaned → **KILL**
       - If not orphaned → **SKIP** (active in another window)

   - If no lock file exists:
     - Check if process is orphaned
     - If orphaned → **KILL**
     - If not orphaned → **SKIP** (might be from older version without lock files)

3. **Kill orphaned processes**

   - Use `kill -9` (Unix) or `taskkill /F /T` (Windows)
   - Delete lock file after successful kill

4. **Log all decisions**
   - Processes to kill: logged with reason
   - Processes to skip: logged with reason
   - Provides full audit trail for debugging

## Code Changes

### Modified Files

- `src/kernels/deepnote/deepnoteServerStarter.node.ts`

### New Imports

```typescript
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from '../../platform/vscode-path/path';
import { generateUuid } from '../../platform/common/uuid';
```

### New Class Members

```typescript
private readonly sessionId: string = generateUuid();
private readonly lockFileDir: string = path.join(os.tmpdir(), 'vscode-deepnote-locks');
```

### New Methods

1. `initializeLockFileDirectory()` - Creates lock file directory
2. `getLockFilePath(pid)` - Returns path to lock file for a PID
3. `writeLockFile(pid)` - Creates lock file for a server process
4. `readLockFile(pid)` - Reads lock file data
5. `deleteLockFile(pid)` - Removes lock file
6. `isProcessOrphaned(pid)` - Checks if process is orphaned by verifying parent

### Modified Methods

1. `constructor()` - Minimal initialization (dependency injection only)
2. `activate()` - Initializes lock file directory and triggers cleanup (implements IExtensionSyncActivationService)
3. `startServerImpl()` - Writes lock file after server starts
4. `stopServerImpl()` - Deletes lock file when server stops
5. `dispose()` - Deletes lock files for all stopped servers
6. `cleanupOrphanedProcesses()` - Implements sophisticated orphan detection

## Benefits

1. **Multi-Window Safety**: Active servers in other VS Code windows are never killed
2. **Backward Compatible**: Handles processes from older versions without lock files
3. **Robust Orphan Detection**: Uses OS-level parent process verification
4. **Full Audit Trail**: Comprehensive logging of all cleanup decisions
5. **Automatic Cleanup**: Stale lock files are removed when processes are killed
6. **Session Isolation**: Each VS Code window operates independently

## Testing Recommendations

1. **Single Window**: Verify servers start and stop correctly
2. **Multiple Windows**: Open multiple VS Code windows with Deepnote files, verify servers in other windows aren't killed
3. **Orphan Cleanup**: Kill VS Code process forcefully, restart, verify orphaned servers are cleaned up
4. **Lock File Cleanup**: Verify lock files are created and deleted appropriately
5. **Cross-Platform**: Test on Windows, macOS, and Linux

## Edge Cases Handled

1. **No lock file + active parent**: Process is skipped (might be from older version)
2. **Lock file + different session + active parent**: Process is skipped (active in another window)
3. **Lock file + same session**: Process is skipped (shouldn't happen at startup)
4. **No lock file + orphaned**: Process is killed (genuine orphan)
5. **Lock file + different session + orphaned**: Process is killed (orphaned from crashed window)
6. **Failed parent check**: Process is assumed not orphaned (safer default)

## Future Enhancements

1. **Stale Lock File Cleanup**: Periodically clean up lock files for non-existent processes
2. **Lock File Expiry**: Add TTL to lock files to handle edge cases
3. **Health Monitoring**: Periodic checks to ensure servers are still responsive
4. **Graceful Shutdown**: Try SIGTERM before SIGKILL for orphaned processes
