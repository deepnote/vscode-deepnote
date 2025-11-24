// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// reflect-metadata is needed by inversify, this must come before any inversify references
import '../platform/ioc/reflectMetadata';

// Set up CommonJS require hooks for mocking vscode in CJS modules
import { createRequire } from 'module';
const Module = createRequire(import.meta.url)('module');
const originalLoad = Module._load;
// We'll set up the hook after importing vscode-mock

// Not sure why but on windows, if you execute a process from the System32 directory, it will just crash Node.
// Not throw an exception, just make node exit.
// However if a system32 process is run first, everything works.
import * as child_process from 'child_process';
import * as os from 'os';
import { setTestExecution, setUnitTestExecution } from '../platform/common/constants';
import { setupCoverage } from './coverage.node';
if (os.platform() === 'win32') {
    const proc = child_process.spawn('C:\\Windows\\System32\\Reg.exe', ['/?']);
    proc.on('error', () => {
        // eslint-disable-next-line no-console
        console.error('error during reg.exe');
    });
}

setTestExecution(true);
setUnitTestExecution(true);

import { initialize, mockedVSCode } from './vscode-mock';
import { vscMockTelemetryReporter } from './mocks/vsc/telemetryReporter';

// Set up CommonJS require hook for vscode module
// This handles CommonJS modules in node_modules that use require('vscode')
Module._load = function (request: string, _parent: NodeModule) {
    if (request === 'vscode') {
        return mockedVSCode;
    }
    if (request === '@vscode/extension-telemetry') {
        return { default: vscMockTelemetryReporter };
    }
    if (request === '@deepnote/convert') {
        return {
            convertIpynbFilesToDeepnoteFile: async () => {
                // Mock implementation - does nothing in tests
            }
        };
    }
    // less files need to be in import statements to be converted to css
    // But we don't want to try to load them in the mock vscode
    if (/\.less$/.test(request)) {
        return;
    }
    return originalLoad.apply(this, arguments as any);
};

// Rebuild with nyc
const nycPromise = setupCoverage();

export const mochaHooks = {
    async afterAll(this: Mocha.Context) {
        this.timeout(30000);
        // Also output the nyc coverage if we have any
        const nyc = await nycPromise;
        if (nyc) {
            nyc.writeCoverageFile();
            return nyc.report();
        }
    }
};

initialize();
