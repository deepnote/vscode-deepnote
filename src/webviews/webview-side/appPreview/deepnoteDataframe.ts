const TOKEN_PATH = '/__deepnote/api-token';
const REQUEST_TIMEOUT_MS = 30_000;
const NO_PROJECT_MESSAGE =
    "This app folder is not next to or inside the folder of a Deepnote project's .deepnote files, so it has no stored dataframes. After adding one, run Deepnote: Preview App again.";

export interface DataframePageOptions {
    pageIndex?: number;
    pageSize?: number;
}

export interface DeepnoteConnection {
    dataframe?(name: string, options?: DataframePageOptions): Promise<unknown>;
}

export interface DeepnoteGlobal {
    connect(...args: unknown[]): DeepnoteConnection;
}

interface TokenReply {
    token: string;
    apiOrigin: string;
    projectId?: string;
}

async function readJson<T>(response: Response): Promise<T> {
    if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message || `Request failed with status ${response.status}`);
    }

    return (await response.json()) as T;
}

/**
 * Gives the connections of Deepnote's client a `dataframe(name, { pageIndex, pageSize })` when they have none. It asks
 * the preview's token endpoint for the token, the API origin and the project, as the version of the client that adds
 * `dataframe()` does. It rejects with a failed request's message, or its status when the answer has none, and rejects
 * without asking the API when the preview has no project.
 */
export function addDataframe(deepnote: DeepnoteGlobal, fetchFn: typeof fetch): void {
    async function dataframe(name: string, options: DataframePageOptions = {}): Promise<unknown> {
        const { token, apiOrigin, projectId } = await readJson<TokenReply>(
            await fetchFn(TOKEN_PATH, { method: 'POST' })
        );
        if (!projectId) {
            throw new Error(NO_PROJECT_MESSAGE);
        }

        const query = new URLSearchParams();
        if (options.pageIndex !== undefined) {
            query.set('pageIndex', String(options.pageIndex));
        }
        if (options.pageSize !== undefined) {
            query.set('pageSize', String(options.pageSize));
        }
        const search = query.toString();
        const path = `/v2/projects/${encodeURIComponent(projectId)}/dataframes/${encodeURIComponent(name)}`;

        return readJson(
            await fetchFn(`${apiOrigin}${path}${search ? `?${search}` : ''}`, {
                headers: { authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            })
        );
    }

    const connect = deepnote.connect.bind(deepnote);
    deepnote.connect = (...args) => {
        const connection = connect(...args);
        connection.dataframe ??= dataframe;

        return connection;
    };
}
