import { Uri, workspace } from 'vscode';

/**
 * Reads the `deepnote.integrations.envFile.enabled` gate for a `.deepnote` file.
 *
 * Shared by `IntegrationsFileConfigProvider` and `IntegrationsEnvFileWatcher` so the key, the default and the
 * resource scoping cannot drift apart: a watcher that still fired for a disabled feature would trigger hidden
 * kernel executions the provider then refuses to back with any config.
 */
export function isIntegrationsEnvFileEnabled(deepnoteFileUri: Uri): boolean {
    return workspace.getConfiguration('deepnote', deepnoteFileUri).get<boolean>('integrations.envFile.enabled', true);
}
