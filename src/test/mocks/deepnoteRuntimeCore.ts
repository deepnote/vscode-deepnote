import type { AgentBlockContext, ServerInfo, ServerOptions } from '@deepnote/runtime-core';
import type { AgentBlock } from '@deepnote/blocks';
import type { ChildProcess } from 'child_process';

/**
 * Mock of @deepnote/runtime-core for unit tests: the real startServer/stopServer spawn and
 * kill Python processes, and the real executeAgentBlock calls the OpenAI API, so this records
 * calls and returns fake results instead.
 *
 * build/mocha-esm-loader.js resolves the '@deepnote/runtime-core' specifier to this module,
 * so code under test and tests importing the __ helpers below share one module instance.
 * The exports are typed against the real package so the mock cannot drift from its API.
 */

type RuntimeCore = typeof import('@deepnote/runtime-core');

const executeAgentBlockCalls: { block: AgentBlock; context: AgentBlockContext }[] = [];
const serializeNotebookContextFromBlocksCalls: { blockCount: number; notebookName: string }[] = [];
const startServerCalls: ServerOptions[] = [];
const stopServerCalls: ServerInfo[] = [];
let nextServerId = 0;
let startServerImpl: RuntimeCore['startServer'] | null = null;

function makeFakeProcess(id: number): ChildProcess {
    // Partial stand-in: only the members DeepnoteServerStarter touches.
    return {
        pid: 40000 + id,
        stdout: { on() {}, off() {} },
        stderr: { on() {}, off() {} },
        kill() {}
    } as unknown as ChildProcess;
}

export const executeAgentBlock: RuntimeCore['executeAgentBlock'] = async (block, context) => {
    executeAgentBlockCalls.push({ block, context });

    return { finalOutput: '' };
};

export const serializeNotebookContextFromBlocks: RuntimeCore['serializeNotebookContextFromBlocks'] = ({
    blocks,
    notebookName
}) => {
    serializeNotebookContextFromBlocksCalls.push({ blockCount: blocks.length, notebookName });

    return `notebook:${notebookName} blocks:${blocks.length}`;
};

export const startServer: RuntimeCore['startServer'] = async (options) => {
    startServerCalls.push(options);

    if (startServerImpl) {
        return startServerImpl(options);
    }

    const id = nextServerId++;

    return {
        url: `http://127.0.0.1:${50000 + id}`,
        jupyterPort: 50000 + id,
        lspPort: 51000 + id,
        process: makeFakeProcess(id)
    };
};

export const stopServer: RuntimeCore['stopServer'] = async (info) => {
    stopServerCalls.push(info);
};

// Test-only helpers (prefixed with __ to signal they are not part of the real API).
export function __getExecuteAgentBlockCalls(): { block: AgentBlock; context: AgentBlockContext }[] {
    return executeAgentBlockCalls;
}

export function __getSerializeNotebookContextFromBlocksCalls(): { blockCount: number; notebookName: string }[] {
    return serializeNotebookContextFromBlocksCalls;
}

export function __getStartServerCalls(): ServerOptions[] {
    return startServerCalls;
}

export function __getStopServerCalls(): ServerInfo[] {
    return stopServerCalls;
}

export function __setStartServerImpl(impl: RuntimeCore['startServer'] | null): void {
    startServerImpl = impl;
}

export function __resetRuntimeCoreMock(): void {
    executeAgentBlockCalls.length = 0;
    serializeNotebookContextFromBlocksCalls.length = 0;
    startServerCalls.length = 0;
    stopServerCalls.length = 0;
    nextServerId = 0;
    startServerImpl = null;
}
