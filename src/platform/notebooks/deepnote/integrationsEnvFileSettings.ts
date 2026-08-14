import { Uri, workspace } from 'vscode';

/** Fully qualified key, for `affectsConfiguration` callers that cannot use the section-relative form below. */
export const INTEGRATIONS_ENV_FILE_SETTING = 'deepnote.integrations.envFile.enabled';

/** Shared gate for `deepnote.integrations.envFile.enabled` so provider and watcher stay in sync. */
export function isIntegrationsEnvFileEnabled(deepnoteFileUri: Uri): boolean {
    return workspace.getConfiguration('deepnote', deepnoteFileUri).get<boolean>('integrations.envFile.enabled', true);
}
