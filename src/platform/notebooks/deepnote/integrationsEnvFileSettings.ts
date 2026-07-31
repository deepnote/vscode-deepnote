import { Uri, workspace } from 'vscode';

/** Shared gate for `deepnote.integrations.envFile.enabled` so provider and watcher stay in sync. */
export function isIntegrationsEnvFileEnabled(deepnoteFileUri: Uri): boolean {
    return workspace.getConfiguration('deepnote', deepnoteFileUri).get<boolean>('integrations.envFile.enabled', true);
}
