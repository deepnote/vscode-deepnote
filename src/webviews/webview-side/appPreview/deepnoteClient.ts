// The `window.Deepnote` client of the local app preview. It follows the contract of Deepnote's hosted client
// (`/static/app-client/v1.js`), except that the preview server hands it the token, so there is no token handshake.
// Its messages reach the app's own code, so they stay English like the hosted client's.

export type RunPhase = 'executing' | 'storing-result';

export interface DeepnoteRunOutput {
    data?: Record<string, unknown>;
}

export interface DeepnoteRun {
    runId: string;
    status: string;
    snapshotStatus?: string;
    snapshotBlocks?: { outputs?: DeepnoteRunOutput[] }[] | null;
}

export interface RunOptions {
    onProgress?: (run: DeepnoteRun, phase: RunPhase) => void;
    timeoutMs?: number;
}

export interface RunResult {
    run: DeepnoteRun;
    result(schema?: string): unknown;
}

export interface DeepnoteNotebookClient {
    appData(): Promise<unknown>;
    inputs(): Promise<unknown[]>;
    run(inputs?: Record<string, unknown>, options?: RunOptions): Promise<RunResult>;
}

export interface DeepnoteConnection {
    dataframe(name: string, options?: { pageIndex?: number; pageSize?: number }): Promise<unknown>;
    notebook(notebookId: string): DeepnoteNotebookClient;
}

export interface DeepnoteAppClient {
    connect(options?: { onAuthExpired?: () => void }): DeepnoteConnection;
}

export interface DeepnoteClientConfig {
    token: string | undefined;
    projectId: string | undefined;
    /** The API root that `/notebooks/...`, `/runs` and `/projects/...` are appended to. */
    apiBaseUrl: string;
}

export interface DeepnoteClientHost {
    fetch: typeof fetch;
    now(): number;
    sleep(ms: number): Promise<void>;
}

const NO_TOKEN_MESSAGE = 'Could not reach the app preview. Open the app with the Deepnote: Preview App command.';
const NO_PROJECT_MESSAGE =
    "This app folder is not next to or inside the folder of a Deepnote project's .deepnote files, so it has no stored dataframes. After adding one, run Deepnote: Preview App again.";

const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;
const DEFAULT_RUN_TIMEOUT_MS = 20 * 60_000;
const MAX_STORING_RESULT_POLLS = 15;
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RATE_LIMIT_WAIT_MS = 5_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const TERMINAL_STATUSES = new Set(['success', 'error', 'internal_error', 'stopped']);

function retryAfterMs(header: string | null): number {
    const value = header?.trim();

    return value && /^\d+$/.test(value) ? Number(value) * 1_000 : DEFAULT_RETRY_AFTER_MS;
}

function firstJsonPayload(run: DeepnoteRun, schema: string | undefined): unknown {
    for (const block of run.snapshotBlocks ?? []) {
        for (const output of block.outputs ?? []) {
            const payload = output.data?.['application/json'] as { schema?: unknown } | undefined;
            if (payload && (!schema || payload.schema === schema)) {
                return payload;
            }
        }
    }

    return null;
}

export function createDeepnoteClient(config: DeepnoteClientConfig, host: DeepnoteClientHost): DeepnoteAppClient {
    async function request<T>(path: string, init: RequestInit = {}, retryRateLimit = false): Promise<T> {
        if (!config.token) {
            throw new Error(NO_TOKEN_MESSAGE);
        }

        for (let retries = 0; ; retries++) {
            const response = await host.fetch(`${config.apiBaseUrl}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
            if (response.ok) {
                return (await response.json()) as T;
            }

            if (retryRateLimit && response.status === 429 && retries < MAX_RATE_LIMIT_RETRIES) {
                const waitMs = retryAfterMs(response.headers.get('retry-after'));
                if (waitMs <= MAX_RATE_LIMIT_WAIT_MS) {
                    await host.sleep(waitMs);
                    continue;
                }
            }

            const body = (await response.json().catch(() => null)) as { message?: string } | null;
            throw new Error(body?.message || `Request failed with status ${response.status}`);
        }
    }

    async function run(notebookId: string, inputs: Record<string, unknown> | undefined, options: RunOptions = {}) {
        const created = await request<{ runId: string }>('/runs', {
            method: 'POST',
            body: JSON.stringify({ notebookId, inputs, detachedRunStorageMode: 'readonly' })
        });
        const deadline = host.now() + (options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
        let storingResultPolls = 0;

        for (;;) {
            const { run: polled } = await request<{ run: DeepnoteRun }>(`/runs/${created.runId}`);
            if (polled.status === 'success' && polled.snapshotStatus === 'unavailable') {
                throw new Error(
                    'The notebook finished, but Deepnote could not save its results. Check run history and try again.'
                );
            }

            const isStoringResult =
                polled.status === 'success' &&
                polled.snapshotBlocks == null &&
                storingResultPolls < MAX_STORING_RESULT_POLLS &&
                host.now() < deadline;
            if (TERMINAL_STATUSES.has(polled.status) && !isStoringResult) {
                return { run: polled, result: (schema?: string) => firstJsonPayload(polled, schema) };
            }
            if (host.now() >= deadline) {
                throw new Error(`Run ${created.runId} did not finish in time.`);
            }

            if (isStoringResult) {
                storingResultPolls += 1;
            }
            options.onProgress?.(polled, isStoringResult ? 'storing-result' : 'executing');
            await host.sleep(POLL_INTERVAL_MS);
        }
    }

    async function dataframe(name: string, options: { pageIndex?: number; pageSize?: number } = {}) {
        if (!config.token) {
            throw new Error(NO_TOKEN_MESSAGE);
        }
        if (!config.projectId) {
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

        return request(
            `/projects/${config.projectId}/dataframes/${encodeURIComponent(name)}${search ? `?${search}` : ''}`,
            {},
            true
        );
    }

    return {
        // The token comes with the page, so it never expires and `onAuthExpired` is never called.
        connect: () => ({
            dataframe,
            notebook: (notebookId: string) => ({
                appData: () => request(`/notebooks/${notebookId}/app-data`),
                inputs: async () =>
                    (await request<{ notebook: { inputs?: unknown[] } }>(`/notebooks/${notebookId}`)).notebook.inputs ??
                    [],
                run: (inputs?: Record<string, unknown>, options?: RunOptions) => run(notebookId, inputs, options)
            })
        })
    };
}
