import { spawn } from 'child_process';
import * as fs from 'fs';
import { connect } from 'net';
import * as os from 'os';
import * as path from 'path';
import { setTimeout as delay } from 'timers/promises';

// Fetched by npx rather than installed: aimock declares `jest` and `vitest` as peers, and resolving
// those against this repo's tree forces overrides that would outlive the test. npx resolves in its
// own cache, so the dependency graph here is untouched.
//
// Pinned exactly — a range would let the mock the suite asserts against change underneath it.
const AIMOCK_VERSION = '1.37.4';
// `llmock` is the bin that takes `-f`/`-p`; the package's `aimock` bin takes `--config` instead.
const AIMOCK_BIN = 'llmock';

// Deliberately below `ip_local_port_range` (32768-60999 here and on GitHub runners): inside it an
// unrelated outbound connection can hold the number as its source port, which the pre-flight check
// below would not see (a client socket does not accept) and `listen` would then fail with EADDRINUSE.
const MOCK_OPENAI_PORT = 18_937;

/**
 * Points the extension host at the mock server instead of the real OpenAI API.
 *
 * MUST be called at a spec file's module scope, never from `before`. ExTester launches VS Code from a
 * root `beforeAll` (`vscode-extension-tester/out/suite/runner.js`) and the extension host inherits its
 * environment at spawn time, so a hook runs too late — while Mocha loads spec files before it runs any
 * hook, which is what makes module scope early enough.
 *
 * `rootHooks.ts` would be the tidier home, but ExTester builds Mocha through `new Mocha(config)`, and
 * the programmatic API ignores the `require` option that file is wired up with.
 */
export function pointExtensionHostAtMockServer(): void {
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${MOCK_OPENAI_PORT}/v1`;
}

// `npm run setup:e2e:mock` primes `~/.npm/_npx` with this exact spec, so a warm start resolves from
// cache without a registry round-trip. The ceiling still covers a cold fetch: the setup step is not
// enforced, and if the two specs ever drift the run silently falls back to downloading here.
const START_TIMEOUT = 90_000;
const POLL_INTERVAL = 200;

// How long to wait for the tree to go down after each of SIGTERM and SIGKILL. Short because the
// graceful signal is not what we rely on: `server.close()` releases the listening socket before the
// process is gone, so a freed port arrives long before the shutdown it appears to signal.
const STOP_TIMEOUT = 2_000;

export interface MockOpenAiServer {
    /** Stops the server and removes its fixtures. Idempotent; safe to call more than once. */
    stop: () => Promise<void>;
}

export interface MockToolCall {
    arguments: string;
    id: string;
    name: string;
}

/**
 * Which request a scripted leg answers. Both alternatives are predicates over the request's own
 * messages, with no server-side counter — unlike aimock's `sequenceIndex`, which would run past the
 * end of the script on a Mocha retry (`.mocharc.js` sets `retries: 1` and `before` does not re-run
 * between attempts) and fail the retry for a different reason than the original.
 *
 * `toolResultContains` additionally requires the last message to be a tool result, so it is what
 * proves a round-trip: the leg is only reachable if the extension really ran the previous tool and
 * fed its real output back.
 */
export type MockAgentMatch = { hasToolResult: false } | { toolResultContains: string };

/** What the agent gets back: another tool call, or the final text that ends the loop. */
export type MockAgentResponse = { content: string } | { toolCall: MockToolCall };

export interface MockAgentTurn {
    match: MockAgentMatch;
    response: MockAgentResponse;
}

function canConnect(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host: '127.0.0.1', port });
        const settle = (reachable: boolean) => {
            socket.destroy();
            resolve(reachable);
        };

        socket.once('connect', () => settle(true));
        socket.once('error', () => settle(false));
    });
}

/**
 * Fails the run when `OPENAI_BASE_URL` does not point at this server.
 *
 * Silence here is not a failed test: `executeAgentBlock` reads the variable at call time and falls
 * back to `openai(model)` against the real api.openai.com (@deepnote/runtime-core dist/index.js:102),
 * so an unset or drifted value sends the suite's prompts — and whatever key is in SecretStorage — to
 * the live API.
 */
function assertBaseUrlPointsAtMock(): void {
    if (!process.env.OPENAI_BASE_URL?.includes(`:${MOCK_OPENAI_PORT}`)) {
        throw new Error(
            `OPENAI_BASE_URL must point at 127.0.0.1:${MOCK_OPENAI_PORT}; run via "npm run test:e2e". ` +
                `Without it the agent would call the real OpenAI API. Current value: ` +
                `${JSON.stringify(process.env.OPENAI_BASE_URL)}`
        );
    }
}

/** Writes `turns` as an aimock fixtures file in a fresh temp directory, and returns that directory. */
function writeFixtures(turns: MockAgentTurn[]): string {
    const fixtures = turns.map(({ match, response }) => ({
        match,
        response: 'toolCall' in response ? { toolCalls: [response.toolCall] } : { content: response.content }
    }));

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-e2e-aimock-'));
    // The `fixtures` wrapper is required — aimock's loader rejects a bare array.
    fs.writeFileSync(path.join(directory, 'fixtures.json'), JSON.stringify({ fixtures }, undefined, 4));

    return directory;
}

/**
 * Starts aimock on the mock port, scripted with `turns` — each answering the request its `match`
 * describes. Resolves once the port accepts connections, which the CLI only reaches after loading and
 * validating the fixtures, so a served request can never race an unloaded fixture.
 *
 * Runs with `--strict`, so a request matching no leg is answered with an error rather than a default:
 * a broken round-trip fails loudly instead of quietly taking a different path through the script.
 */
export async function startMockOpenAiServer(turns: MockAgentTurn[]): Promise<MockOpenAiServer> {
    assertBaseUrlPointsAtMock();

    // Without this the readiness poll below cannot tell our server from someone else's: a leftover
    // from a crashed run would satisfy it instantly, and the suite would then be asserting against
    // that server's fixtures while ours had already died of EADDRINUSE.
    if (await canConnect(MOCK_OPENAI_PORT)) {
        throw new Error(
            `Port ${MOCK_OPENAI_PORT} is already in use — most likely a mock server left behind by an ` +
                `interrupted run. Kill it before running the suite.`
        );
    }

    const fixturesDirectory = writeFixtures(turns);

    const child = spawn(
        'npx',
        [
            // Use the cache `setup:e2e:mock` primed rather than re-checking the registry mid-run, but
            // still fall back to fetching so a skipped setup step degrades to slow instead of broken.
            '--prefer-offline',
            '-y',
            '-p',
            `@copilotkit/aimock@${AIMOCK_VERSION}`,
            AIMOCK_BIN,
            '-f',
            fixturesDirectory,
            '-p',
            String(MOCK_OPENAI_PORT),
            // Answers an unmatched request with an error instead of letting the agent keep asking
            // until runtime-core's 10-turn cap, which would bury the cause.
            '--strict',
            '--log-level',
            'warn'
        ],
        {
            // npx runs the server two levels down (`npm exec` -> `sh -c` -> node), and a signal sent
            // to npx alone leaves that grandchild holding the port. Its own process group makes the
            // whole tree signalable; see `signalTree`.
            detached: true,
            stdio: ['ignore', 'inherit', 'inherit']
        }
    );

    let exitReason: string | undefined;
    child.once('exit', (code, signal) => {
        exitReason = `code ${code}, signal ${signal}`;
    });
    // Node emits 'error' rather than 'exit' when the spawn itself fails (ENOENT for a missing npx,
    // EACCES, …). An unhandled 'error' on a ChildProcess throws out of the event loop and takes the
    // whole mocha process with it, losing every later suite and skipping ExTester's teardown; routing
    // it through exitReason turns that into the readiness loop's ordinary failure.
    child.once('error', (error) => {
        exitReason = `spawn failed: ${error.message}`;
    });

    const signalTree = (signal: NodeJS.Signals) => {
        try {
            if (child.pid === undefined) {
                return;
            }

            process.kill(-child.pid, signal);
        } catch {
            // Already gone — nothing left to signal.
        }
    };

    // A crashed runner would otherwise leave the port bound and fail every later run.
    const killChild = () => signalTree('SIGKILL');
    process.once('exit', killChild);

    const hasShutDown = async () =>
        (child.exitCode !== null || child.signalCode !== null) && !(await canConnect(MOCK_OPENAI_PORT));

    const waitForShutdown = async (): Promise<boolean> => {
        const deadline = Date.now() + STOP_TIMEOUT;

        while (Date.now() < deadline) {
            if (await hasShutDown()) {
                return true;
            }

            await delay(POLL_INTERVAL);
        }

        return false;
    };

    const stop = async () => {
        fs.rmSync(fixturesDirectory, { force: true, recursive: true });

        // Neither half of `hasShutDown` proves the node server is gone on its own: `server.close()`
        // frees the listening socket while still draining open connections, and npx exits ahead of
        // the server it spawned. So give SIGTERM a graceful window, then SIGKILL the group
        // unconditionally — on an already-dead group that is a swallowed ESRCH, and it is the only
        // step that guarantees nothing is left behind holding the port.
        signalTree('SIGTERM');
        await waitForShutdown();
        signalTree('SIGKILL');

        if (!(await waitForShutdown())) {
            throw new Error(
                `aimock did not shut down after SIGKILL: port ${MOCK_OPENAI_PORT} still accepts ` +
                    `connections, or the npx process has not exited.`
            );
        }

        // Only once the shutdown is confirmed — until here the exit-time kill is the last safety net.
        process.removeListener('exit', killChild);
    };

    const deadline = Date.now() + START_TIMEOUT;
    while (Date.now() < deadline) {
        if (exitReason) {
            await stop();

            throw new Error(`aimock exited before it started listening (${exitReason}); see its output above`);
        }

        if (await canConnect(MOCK_OPENAI_PORT)) {
            return { stop };
        }

        await delay(POLL_INTERVAL);
    }

    await stop();

    throw new Error(
        `aimock did not listen on port ${MOCK_OPENAI_PORT} within ${START_TIMEOUT}ms. A stale server from an ` +
            `earlier run may still hold the port.`
    );
}
