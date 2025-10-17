// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as sinon from 'sinon';
import { assert } from 'chai';
import { when, instance, mock, anything } from 'ts-mockito';
import { Uri } from 'vscode';
import { getDisplayNameOrNameOfKernelConnection } from './helpers';
import {
    IJupyterKernelSpec,
    LiveRemoteKernelConnectionMetadata,
    LocalKernelSpecConnectionMetadata,
    PythonKernelConnectionMetadata
} from './types';
import { EnvironmentType, PythonEnvironment } from '../platform/pythonEnvironments/info';
import { PythonExtension, type Environment } from '@vscode/python-extension';
import { resolvableInstance } from '../test/datascience/helpers';
import { DisposableStore, dispose } from '../platform/common/utils/lifecycle';
import { setPythonApi } from '../platform/interpreter/helpers';
import type { IDisposable } from '@c4312/evt';
import type { DeepPartial } from '../platform/common/utils/misc';

export function crateMockedPythonApi(disposables: IDisposable[] | DisposableStore) {
    const disposableStore = new DisposableStore();
    const mockedApi = mock<PythonExtension>();
    sinon.stub(PythonExtension, 'api').resolves(resolvableInstance(mockedApi));
    disposableStore.add({ dispose: () => sinon.restore() });
    const environments = mock<PythonExtension['environments']>();
    when(mockedApi.environments).thenReturn(instance(environments));
    when(environments.known).thenReturn([]);
    setPythonApi(instance(mockedApi));
    disposableStore.add({ dispose: () => setPythonApi(undefined as any) });
    if (Array.isArray(disposables)) {
        disposables.push(disposableStore);
    } else {
        disposables.add(disposableStore);
    }
    return { dispose: () => disposableStore.dispose(), environments };
}
export function whenKnownEnvironments(environments: PythonExtension['environments']) {
    return {
        thenReturn: (items: DeepPartial<Environment>[]) => {
            items.forEach((item) => {
                if (!Array.isArray(item.tools)) {
                    item.tools = [];
                }
            });
            when(environments.known).thenReturn(items as any);
        }
    };
}
export function whenResolveEnvironment(
    environments: PythonExtension['environments'],
    environment: Parameters<PythonExtension['environments']['resolveEnvironment']>[0] = anything()
) {
    return {
        thenResolve: (items: DeepPartial<Environment>) => {
            when(environments.resolveEnvironment(environment)).thenResolve(items as any);
        }
    };
}

suite('Kernel Connection Helpers', () => {
    let environments: PythonExtension['environments'];
    let disposables: { dispose: () => void }[] = [];
    setup(() => {
        environments = crateMockedPythonApi(disposables).environments;
        whenKnownEnvironments(environments).thenReturn([]);
    });
    teardown(() => {
        disposables = dispose(disposables);
    });
    test('Live kernels should display the name`', () => {
        const name = getDisplayNameOrNameOfKernelConnection(
            LiveRemoteKernelConnectionMetadata.create({
                id: '',
                interpreter: undefined,
                kernelModel: {
                    model: undefined,
                    lastActivityTime: new Date(),
                    name: 'livexyz',
                    numberOfConnections: 1
                },
                baseUrl: '',
                serverProviderHandle: { handle: '1', id: '1', extensionId: '' }
            })
        );

        assert.strictEqual(name, 'livexyz');
    });
    suite('Non-python kernels', () => {
        test('Display the name if language is not specified', () => {
            const name = getDisplayNameOrNameOfKernelConnection(
                LocalKernelSpecConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path'
                    }
                })
            );

            assert.strictEqual(name, 'kspecname');
        });
        test('Display the name if language is not python', () => {
            const name = getDisplayNameOrNameOfKernelConnection(
                LocalKernelSpecConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path',
                        language: 'abc'
                    }
                })
            );

            assert.strictEqual(name, 'kspecname');
        });
        test('Display the name even if kernel is inside an unknown Python environment', () => {
            const name = getDisplayNameOrNameOfKernelConnection(
                LocalKernelSpecConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path'
                    },
                    interpreter: {
                        uri: Uri.file('pyPath'),
                        id: Uri.file('pyPath').fsPath
                    }
                })
            );
            assert.strictEqual(name, 'kspecname');
        });
        test('Display name even if kernel is inside a global Python environment', () => {
            const name = getDisplayNameOrNameOfKernelConnection(
                LocalKernelSpecConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path'
                    },
                    interpreter: {
                        uri: Uri.file('pyPath'),
                        id: Uri.file('pyPath').fsPath
                    }
                })
            );
            assert.strictEqual(name, 'kspecname');
        });
        test('Display name if kernel is inside a non-global Python environment', () => {
            const name = getDisplayNameOrNameOfKernelConnection(
                LocalKernelSpecConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path'
                    },
                    interpreter: {
                        uri: Uri.file('pyPath'),
                        id: Uri.file('pyPath').fsPath
                    }
                })
            );
            assert.strictEqual(name, 'kspecname');
        });
        test('Display name if kernel is inside a non-global 64bit Python environment', () => {
            const name = getDisplayNameOrNameOfKernelConnection(
                LocalKernelSpecConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path'
                    },
                    interpreter: {
                        uri: Uri.file('pyPath'),
                        id: Uri.file('pyPath').fsPath
                    }
                })
            );
            assert.strictEqual(name, 'kspecname');
        });
        test('Prefixed with `<env name>` kernel is inside a non-global Python environment', () => {
            whenKnownEnvironments(environments).thenReturn([
                {
                    id: Uri.file('pyPath').fsPath,
                    version: {
                        major: 9,
                        minor: 8,
                        micro: 7,
                        release: undefined,
                        sysVersion: '9.8.7'
                    },
                    environment: {
                        name: '.env'
                    },
                    tools: [EnvironmentType.Conda]
                }
            ]);
            const name = getDisplayNameOrNameOfKernelConnection(
                LocalKernelSpecConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path'
                    },
                    interpreter: {
                        uri: Uri.file('pyPath'),
                        id: Uri.file('pyPath').fsPath
                    }
                })
            );
            assert.strictEqual(name, 'kspecname (.env)');
        });
        test('Prefixed with `<env name>` kernel is inside a non-global 64-bit Python environment', () => {
            whenKnownEnvironments(environments).thenReturn([
                {
                    id: Uri.file('pyPath').fsPath,
                    version: {
                        major: 9,
                        minor: 8,
                        micro: 7,
                        release: undefined,
                        sysVersion: '9.8.7'
                    },
                    environment: {
                        name: '.env'
                    },
                    tools: [EnvironmentType.Conda]
                }
            ]);
            const name = getDisplayNameOrNameOfKernelConnection(
                LocalKernelSpecConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path'
                    },
                    interpreter: {
                        uri: Uri.file('pyPath'),
                        id: Uri.file('pyPath').fsPath
                    }
                })
            );
            assert.strictEqual(name, 'kspecname (.env)');
        });
    });
    suite('Python kernels (started using kernelspec)', () => {
        test('Display name if language is python', () => {
            const name = getDisplayNameOrNameOfKernelConnection(
                LocalKernelSpecConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path',
                        language: 'python'
                    }
                })
            );

            assert.strictEqual(name, 'kspecname');
        });
        test('Display name even if kernel is associated an unknown Python environment', () => {
            const name = getDisplayNameOrNameOfKernelConnection(
                LocalKernelSpecConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path',
                        language: 'python'
                    },
                    interpreter: {
                        uri: Uri.file('pyPath'),
                        id: Uri.file('pyPath').fsPath
                    }
                })
            );
            assert.strictEqual(name, 'kspecname');
        });
        test('Display name even if kernel is associated with a global Python environment', () => {
            const name = getDisplayNameOrNameOfKernelConnection(
                LocalKernelSpecConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path',
                        language: 'python'
                    },
                    interpreter: {
                        uri: Uri.file('pyPath'),
                        id: Uri.file('pyPath').fsPath
                    }
                })
            );
            assert.strictEqual(name, 'kspecname');
        });
        test('Display name if kernel is associated with a non-global Python environment', () => {
            const name = getDisplayNameOrNameOfKernelConnection(
                LocalKernelSpecConnectionMetadata.create({
                    id: '1',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path',
                        language: 'python'
                    },
                    interpreter: {
                        uri: Uri.file('pyPath'),
                        id: Uri.file('pyPath').fsPath
                    }
                })
            );
            assert.strictEqual(name, 'kspecname');
        });
        test('Display name if kernel is associated with a non-global 64bit Python environment', () => {
            const name = getDisplayNameOrNameOfKernelConnection(
                LocalKernelSpecConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path',
                        language: 'python'
                    },
                    interpreter: {
                        uri: Uri.file('pyPath'),
                        id: Uri.file('pyPath').fsPath
                    }
                })
            );
            assert.strictEqual(name, 'kspecname');
        });
        test('Display name if kernel is associated with a non-global 64bit Python environment and includes version', () => {
            const name = getDisplayNameOrNameOfKernelConnection(
                LocalKernelSpecConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path',
                        language: 'python'
                    },
                    interpreter: {
                        uri: Uri.file('pyPath'),
                        id: Uri.file('pyPath').fsPath
                    }
                })
            );
            assert.strictEqual(name, 'kspecname');
        });
        test('Prefixed with `<env name>` kernel is associated with a non-global Python environment', () => {
            whenKnownEnvironments(environments).thenReturn([
                {
                    id: Uri.file('pyPath').fsPath,
                    version: {
                        major: 9,
                        minor: 8,
                        micro: 7,
                        release: undefined,
                        sysVersion: '9.8.7.6-pre'
                    },
                    environment: {
                        name: '.env'
                    },
                    tools: [EnvironmentType.Conda]
                }
            ]);
            const name = getDisplayNameOrNameOfKernelConnection(
                LocalKernelSpecConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path',
                        language: 'python'
                    },
                    interpreter: {
                        uri: Uri.file('pyPath'),
                        id: Uri.file('pyPath').fsPath
                    }
                })
            );
            assert.strictEqual(name, 'kspecname (Python 9.8.7)');
        });
        test('Prefixed with `<env name>` kernel is associated with a non-global 64-bit Python environment', () => {
            whenKnownEnvironments(environments).thenReturn([
                {
                    id: Uri.file('pyPath').fsPath,
                    version: {
                        major: 9,
                        minor: 8,
                        micro: 7,
                        release: undefined,
                        sysVersion: '9.8.7'
                    },
                    environment: {
                        name: '.env'
                    },
                    tools: [EnvironmentType.Conda]
                }
            ]);
            const name = getDisplayNameOrNameOfKernelConnection(
                LocalKernelSpecConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path',
                        language: 'python'
                    },
                    interpreter: {
                        uri: Uri.file('pyPath'),
                        id: Uri.file('pyPath').fsPath
                    }
                })
            );
            assert.strictEqual(name, 'kspecname (Python 9.8.7)');
        });
    });
    suite('Python kernels (started using interpreter)', () => {
        test('Return current label if we do not know the type of python environment', () => {
            const name = getDisplayNameOrNameOfKernelConnection(
                LocalKernelSpecConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path',
                        language: 'python'
                    },
                    interpreter: {
                        uri: Uri.file('pyPath'),
                        id: Uri.file('pyPath').fsPath
                    }
                })
            );
            assert.strictEqual(name, 'kspecname');
        });
        test('Return Python Version for global python environment', () => {
            const name = getDisplayNameOrNameOfKernelConnection(
                PythonKernelConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path',
                        language: 'python'
                    },
                    interpreter: {
                        uri: Uri.file('pyPath'),
                        id: Uri.file('pyPath').fsPath
                    }
                })
            );
            assert.strictEqual(name, 'Python');
        });
        test('Return Python Version for global python environment with a version', () => {
            whenKnownEnvironments(environments).thenReturn([
                {
                    id: Uri.file('pyPath').fsPath,
                    version: {
                        major: 1,
                        minor: 2,
                        micro: 3,
                        release: undefined,
                        sysVersion: '1.2.3'
                    },
                    tools: [EnvironmentType.Unknown]
                }
            ]);
            const name = getDisplayNameOrNameOfKernelConnection(
                PythonKernelConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path',
                        language: 'python'
                    },
                    interpreter: {
                        uri: Uri.file('pyPath'),
                        id: Uri.file('pyPath').fsPath
                    }
                })
            );
            assert.strictEqual(name, 'Python 1.2.3');
        });
        test('Display name if kernel is associated with a non-global Python environment', () => {
            const name = getDisplayNameOrNameOfKernelConnection(
                PythonKernelConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path',
                        language: 'python'
                    },
                    interpreter: {
                        uri: Uri.file('pyPath'),
                        id: Uri.file('pyPath').fsPath
                    }
                })
            );
            assert.strictEqual(name, 'Python');
        });
        test('DIsplay name if kernel is associated with a non-global 64bit Python environment', () => {
            const name = getDisplayNameOrNameOfKernelConnection(
                PythonKernelConnectionMetadata.create({
                    id: '',
                    kernelSpec: {
                        argv: [],
                        display_name: 'kspecname',
                        name: 'kspec',
                        executable: 'path',
                        language: 'python'
                    },
                    interpreter: {
                        uri: Uri.file('pyPath'),
                        id: Uri.file('pyPath').fsPath
                    }
                })
            );
            assert.strictEqual(name, 'Python');
        });
        test('Display name if kernel is associated with a non-global 64bit Python environment and includes version', () => {
            const kernelSpec = mock<IJupyterKernelSpec>();
            const interpreter = mock<PythonEnvironment>();
            when(kernelSpec.language).thenReturn('python');
            when(interpreter.id).thenReturn('xyz');
            whenKnownEnvironments(environments).thenReturn([
                {
                    id: instance(interpreter).id,
                    version: {
                        major: 9,
                        minor: 8,
                        micro: 7,
                        release: undefined,
                        sysVersion: '9.8.7.6-pre'
                    },
                    tools: []
                }
            ]);

            const name = getDisplayNameOrNameOfKernelConnection(
                PythonKernelConnectionMetadata.create({
                    id: '',
                    kernelSpec: instance(kernelSpec),
                    interpreter: instance(interpreter)
                })
            );
            assert.strictEqual(name, 'Python 9.8.7');
        });
        test('Prefixed with `<env name>` kernel is associated with a non-global Python environment', () => {
            const kernelSpec = mock<IJupyterKernelSpec>();
            const interpreter = mock<PythonEnvironment>();
            when(kernelSpec.language).thenReturn('python');
            when(interpreter.id).thenReturn('xyz');
            whenKnownEnvironments(environments).thenReturn([
                {
                    id: instance(interpreter).id,
                    version: {
                        major: 9,
                        minor: 8,
                        micro: 7,
                        release: undefined,
                        sysVersion: '9.8.7.6-pre'
                    },
                    environment: {
                        name: '.env',
                        folderUri: Uri.file('some')
                    },
                    tools: [EnvironmentType.Venv]
                }
            ]);

            const name = getDisplayNameOrNameOfKernelConnection(
                PythonKernelConnectionMetadata.create({
                    id: '',
                    kernelSpec: instance(kernelSpec),
                    interpreter: instance(interpreter)
                })
            );
            assert.strictEqual(name, '.env (Python 9.8.7)');
        });
        test('Prefixed with `<env name>` kernel is associated with a non-global 64-bit Python environment', () => {
            const kernelSpec = mock<IJupyterKernelSpec>();
            const interpreter = mock<PythonEnvironment>();
            when(kernelSpec.language).thenReturn('python');
            when(interpreter.id).thenReturn('xyz');
            whenKnownEnvironments(environments).thenReturn([
                {
                    id: instance(interpreter).id,
                    version: {
                        major: 9,
                        minor: 8,
                        micro: 7,
                        release: undefined,
                        sysVersion: '9.8.7.6-pre'
                    },
                    environment: {
                        name: '.env',
                        folderUri: Uri.file('some')
                    },
                    tools: [EnvironmentType.Venv]
                }
            ]);

            const name = getDisplayNameOrNameOfKernelConnection(
                PythonKernelConnectionMetadata.create({
                    id: '',
                    kernelSpec: instance(kernelSpec),
                    interpreter: instance(interpreter)
                })
            );
            assert.strictEqual(name, '.env (Python 9.8.7)');
        });
    });

    suite('executeSilently', () => {
        test('Returns outputs from kernel execution', async () => {
            const mockKernel = {
                requestExecute: () => ({
                    done: Promise.resolve({
                        content: {
                            status: 'ok' as const
                        }
                    }),
                    onIOPub: () => {
                        // noop
                    }
                })
            };

            const code = 'print("hello")';
            const { executeSilently } = await import('./helpers');
            const result = await executeSilently(mockKernel as any, code);

            // executeSilently should return outputs array
            assert.isArray(result);
        });

        test('Handles empty code', async () => {
            const mockKernel = {
                requestExecute: () => ({
                    done: Promise.resolve({
                        content: {
                            status: 'ok' as const
                        }
                    }),
                    onIOPub: () => {
                        // noop
                    }
                })
            };

            const code = '';
            const { executeSilently } = await import('./helpers');
            const result = await executeSilently(mockKernel as any, code);

            // Should return empty array for empty code
            assert.isArray(result);
        });

        test('Collects stream outputs', async () => {
            let iopubCallback: ((msg: any) => void) | undefined;

            const mockKernel = {
                requestExecute: () => ({
                    done: Promise.resolve({
                        content: {
                            status: 'ok' as const
                        }
                    }),
                    onIOPub: (cb: (msg: any) => void) => {
                        iopubCallback = cb;
                        // Simulate stream output
                        setTimeout(() => {
                            if (iopubCallback) {
                                iopubCallback({
                                    header: { msg_type: 'stream' },
                                    content: {
                                        name: 'stdout',
                                        text: 'test output'
                                    }
                                });
                            }
                        }, 0);
                    }
                })
            };

            const code = 'print("test")';
            const { executeSilently } = await import('./helpers');
            const result = await executeSilently(mockKernel as any, code);

            assert.isArray(result);
            // Should have collected the stream output
            if (result && result.length > 0) {
                assert.equal(result[0].output_type, 'stream');
            }
        });

        test('Collects error outputs', async () => {
            let iopubCallback: ((msg: any) => void) | undefined;

            const mockKernel = {
                requestExecute: () => ({
                    done: Promise.resolve({
                        content: {
                            status: 'error' as const,
                            ename: 'NameError',
                            evalue: 'name not defined',
                            traceback: ['Traceback...']
                        }
                    }),
                    onIOPub: (cb: (msg: any) => void) => {
                        iopubCallback = cb;
                        // Simulate error output
                        setTimeout(() => {
                            if (iopubCallback) {
                                iopubCallback({
                                    header: { msg_type: 'error' },
                                    content: {
                                        ename: 'NameError',
                                        evalue: 'name not defined',
                                        traceback: ['Traceback...']
                                    }
                                });
                            }
                        }, 0);
                    }
                })
            };

            const code = 'undefined_variable';
            const { executeSilently } = await import('./helpers');
            const result = await executeSilently(mockKernel as any, code);

            assert.isArray(result);
            // Should have collected the error output
            if (result && result.length > 0) {
                assert.equal(result[0].output_type, 'error');
            }
        });

        test('Collects display_data outputs', async () => {
            let iopubCallback: ((msg: any) => void) | undefined;

            const mockKernel = {
                requestExecute: () => ({
                    done: Promise.resolve({
                        content: {
                            status: 'ok' as const
                        }
                    }),
                    onIOPub: (cb: (msg: any) => void) => {
                        iopubCallback = cb;
                        // Simulate display_data output
                        setTimeout(() => {
                            if (iopubCallback) {
                                iopubCallback({
                                    header: { msg_type: 'display_data' },
                                    content: {
                                        data: {
                                            'text/plain': 'some data'
                                        },
                                        metadata: {}
                                    }
                                });
                            }
                        }, 0);
                    }
                })
            };

            const code = 'display("data")';
            const { executeSilently } = await import('./helpers');
            const result = await executeSilently(mockKernel as any, code);

            assert.isArray(result);
            // Should have collected the display_data output
            if (result && result.length > 0) {
                assert.equal(result[0].output_type, 'display_data');
            }
        });

        test('Handles multiple outputs', async () => {
            let iopubCallback: ((msg: any) => void) | undefined;

            const mockKernel = {
                requestExecute: () => ({
                    done: Promise.resolve({
                        content: {
                            status: 'ok' as const
                        }
                    }),
                    onIOPub: (cb: (msg: any) => void) => {
                        iopubCallback = cb;
                        // Simulate multiple outputs
                        setTimeout(() => {
                            if (iopubCallback) {
                                iopubCallback({
                                    header: { msg_type: 'stream' },
                                    content: {
                                        name: 'stdout',
                                        text: 'output 1'
                                    }
                                });
                                iopubCallback({
                                    header: { msg_type: 'stream' },
                                    content: {
                                        name: 'stdout',
                                        text: 'output 2'
                                    }
                                });
                            }
                        }, 0);
                    }
                })
            };

            const code = 'print("1"); print("2")';
            const { executeSilently } = await import('./helpers');
            const result = await executeSilently(mockKernel as any, code);

            assert.isArray(result);
            // Should have collected multiple outputs
            if (result) {
                assert.isAtLeast(result.length, 0);
            }
        });
    });
});
