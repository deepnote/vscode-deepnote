import { spawn } from 'child_process';
import * as fs from 'fs';
import { connect } from 'net';
import * as os from 'os';
import * as path from 'path';
import { setTimeout as delay } from 'timers/promises';

// npx aimock — keep jest/vitest peers out of the lockfile.
const AIMOCK_VERSION = '1.37.4';
const AIMOCK_BIN = 'llmock';

// Fixed port below ephemeral range (connect pre-flight).
const MOCK_OPENAI_PORT = 18_937;

/** Set OPENAI_BASE_URL at module scope — ExTester spawns the host before `before` hooks. */
export function pointExtensionHostAtMockServer(): void {
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${MOCK_OPENAI_PORT}/v1`;
}

const START_TIMEOUT = 90_000;
const POLL_INTERVAL = 200;
const STOP_TIMEOUT = 2_000;

export interface MockOpenAiServer {
    stop: () => Promise<void>;
}

export interface MockToolCall {
    arguments: string;
    id: string;
    name: string;
}

/** Per-leg match predicate (not call order); Mocha-retry-safe. */
export type MockAgentMatch = { hasToolResult: false } | { toolResultContains: string };

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

function assertBaseUrlPointsAtMock(): void {
    if (!process.env.OPENAI_BASE_URL?.includes(`:${MOCK_OPENAI_PORT}`)) {
        throw new Error(
            `OPENAI_BASE_URL must point at 127.0.0.1:${MOCK_OPENAI_PORT}; run via "npm run test:e2e". ` +
                `Without it the agent would call the real OpenAI API. Current value: ` +
                `${JSON.stringify(process.env.OPENAI_BASE_URL)}`
        );
    }
}

function writeFixtures(turns: MockAgentTurn[]): string {
    const fixtures = turns.map(({ match, response }) => ({
        match,
        response: 'toolCall' in response ? { toolCalls: [response.toolCall] } : { content: response.content }
    }));

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-e2e-aimock-'));
    fs.writeFileSync(path.join(directory, 'fixtures.json'), JSON.stringify({ fixtures }, undefined, 4));

    return directory;
}

export async function startMockOpenAiServer(turns: MockAgentTurn[]): Promise<MockOpenAiServer> {
    assertBaseUrlPointsAtMock();

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
            '--prefer-offline',
            '-y',
            '-p',
            `@copilotkit/aimock@${AIMOCK_VERSION}`,
            AIMOCK_BIN,
            '-f',
            fixturesDirectory,
            '-p',
            String(MOCK_OPENAI_PORT),
            '--strict',
            '--log-level',
            'warn'
        ],
        {
            detached: true,
            stdio: ['ignore', 'inherit', 'inherit']
        }
    );

    let exitReason: string | undefined;
    child.once('exit', (code, signal) => {
        exitReason = `code ${code}, signal ${signal}`;
    });
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
            // process already exited
        }
    };

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

        signalTree('SIGTERM');
        await waitForShutdown();
        signalTree('SIGKILL');

        if (!(await waitForShutdown())) {
            throw new Error(
                `aimock did not shut down after SIGKILL: port ${MOCK_OPENAI_PORT} still accepts ` +
                    `connections, or the npx process has not exited.`
            );
        }

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
