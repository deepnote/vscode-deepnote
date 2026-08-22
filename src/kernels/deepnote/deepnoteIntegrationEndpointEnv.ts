import { Uri } from 'vscode';

import { resolveProjectIdForFile } from '../../platform/deepnote/deepnoteProjectIdResolver';
import { logger } from '../../platform/logging';
import { IUserpodApiEndpoints } from '../../platform/notebooks/deepnote/types';

/**
 * Injects live-integration env vars into `extraEnv` when the loopback endpoint is listening and
 * `deepnoteFileUri` resolves to a project id. Skipped otherwise — the toolkit raises on an unreachable URL.
 *
 * Mutates `extraEnv` in place.
 */
export async function applyIntegrationEndpointEnv({
    deepnoteFileUri,
    endpoint,
    extraEnv
}: {
    deepnoteFileUri: Uri;
    endpoint: IUserpodApiEndpoints;
    extraEnv: Record<string, string>;
}): Promise<void> {
    // Wait for the initial bind so a kernel starting before the loopback endpoint is listening still gets the env.
    await endpoint.ready;

    const baseUrl = endpoint.baseUrl;
    if (!baseUrl) {
        logger.warn(
            'applyIntegrationEndpointEnv: integration endpoint is not listening; skipping live integration env injection.'
        );

        return;
    }

    const projectId = await resolveProjectIdForFile(deepnoteFileUri);

    if (!projectId) {
        return;
    }

    extraEnv['DEEPNOTE_RUNTIME__ENV_INTEGRATION_ENABLED'] = 'true';
    extraEnv['DEEPNOTE_RUNTIME__RUNNING_IN_DETACHED_MODE'] = 'true';
    extraEnv['DEEPNOTE_RUNTIME__WEBAPP_URL'] = baseUrl;
    // 2.1.1 dereferences project_secret without a null-check in detached mode; also the endpoint's per-project bearer token.
    extraEnv['DEEPNOTE_RUNTIME__PROJECT_SECRET'] = endpoint.getAuthToken(projectId);
    // Legacy key (not __PROJECT_ID): also satisfies set_notebook_path's has_env check, avoiding a session-name parse.
    extraEnv['DEEPNOTE_PROJECT_ID'] = projectId;
}
