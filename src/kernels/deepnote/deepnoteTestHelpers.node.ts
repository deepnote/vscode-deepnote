import type { ChildProcess } from 'node:child_process';

/**
 * Creates a mock ChildProcess for use in Deepnote server info tests.
 * Satisfies the ChildProcess interface with minimal stub values.
 */
export function createMockChildProcess(overrides?: Partial<ChildProcess>): ChildProcess {
    const mockProcess: ChildProcess = {
        pid: undefined,
        stdio: [null, null, null, null, null],
        stdin: null,
        stdout: null,
        stderr: null,
        exitCode: null,
        killed: false,
        connected: false,
        signalCode: null,
        spawnargs: [],
        spawnfile: '',
        kill: () => true,
        send: () => true,
        disconnect: () => true,
        unref: () => true,
        ref: () => true,
        addListener: function () {
            return this;
        },
        emit: () => true,
        on: function () {
            return this;
        },
        once: function () {
            return this;
        },
        removeListener: function () {
            return this;
        },
        removeAllListeners: function () {
            return this;
        },
        prependListener: function () {
            return this;
        },
        prependOnceListener: function () {
            return this;
        },
        [Symbol.dispose]: () => {
            return undefined;
        },
        off: function () {
            return this;
        },
        setMaxListeners: function () {
            return this;
        },
        getMaxListeners: () => 10,
        listeners: function () {
            return [];
        },
        rawListeners: function () {
            return [];
        },
        eventNames: function () {
            return [];
        },
        listenerCount: () => 0,
        ...overrides
    };
    return mockProcess;
}
