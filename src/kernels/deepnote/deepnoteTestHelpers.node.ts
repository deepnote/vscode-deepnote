import type { ChildProcess } from 'node:child_process';

/**
 * Creates a mock ChildProcess for use in Deepnote server info tests.
 * Satisfies the ChildProcess interface with minimal stub values.
 */
export function createMockChildProcess(overrides?: Partial<ChildProcess>): ChildProcess {
    return {
        pid: undefined,
        stdout: null,
        stderr: null,
        exitCode: null,
        ...overrides
    } as ChildProcess;
}
