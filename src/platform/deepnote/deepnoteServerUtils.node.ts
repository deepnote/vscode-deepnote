import { createHash } from 'crypto';

export function createDeepnoteServerConfigHandle(environmentId: string, projectKey: string): string {
    const projectHash = createHash('sha256').update(projectKey).digest('hex').slice(0, 24);
    return `deepnote-config-server-${environmentId}-${projectHash}`;
}
