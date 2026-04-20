export function createDeepnoteServerConfigHandle(environmentId: string, projectId: string): string {
    return `deepnote-config-server-${environmentId}-${projectId}`;
}
