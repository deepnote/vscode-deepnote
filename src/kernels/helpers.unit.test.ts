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
        interface MockKernelOptions {
            status: 'ok' | 'error';
            messages?: Array<{
                msg_type: 'stream' | 'error' | 'display_data';
                content: any;
            }>;
            errorContent?: {
                ename: string;
                evalue: string;
                traceback: string[];
            };
        }

        function createMockKernel(options: MockKernelOptions) {
            return {
                requestExecute: () => {
                    let resolvePromise: (value: any) => void;

                    // Create a promise that will be resolved after IOPub messages are dispatched
                    const donePromise = new Promise<any>((resolve) => {
                        resolvePromise = resolve;
                    });

                    return {
                        done: donePromise,
                        set onIOPub(cb: (msg: any) => void) {
                            // Invoke IOPub callback synchronously with all messages
                            if (options.messages && options.messages.length > 0) {
                                options.messages.forEach((msg) => {
                                    cb({
                                        header: { msg_type: msg.msg_type },
                                        content: msg.content
                                    });
                                });
                            }
                            // Resolve the done promise after messages are dispatched
                            resolvePromise({
                                content:
                                    options.status === 'ok'
                                        ? { status: 'ok' as const }
                                        : {
                                              status: 'error' as const,
                                              ...options.errorContent
                                          }
                            });
                        }
                    };
                }
            };
        }

        test('Returns outputs from kernel execution', async () => {
            const mockKernel = createMockKernel({
                status: 'ok',
                messages: [
                    {
                        msg_type: 'stream',
                        content: {
                            name: 'stdout',
                            text: 'hello\n'
                        }
                    }
                ]
            });

            const code = 'print("hello")';
            const { executeSilently } = await import('./helpers');
            const result = await executeSilently(mockKernel as any, code);

            // executeSilently should return outputs array with collected stream output
            assert.isArray(result);
            assert.equal(result.length, 1);
            assert.equal(result[0].output_type, 'stream');
            assert.equal((result[0] as any).name, 'stdout');
            assert.equal((result[0] as any).text, 'hello\n');
        });

        test('Collects error outputs', async () => {
            const mockKernel = createMockKernel({
                status: 'error',
                errorContent: {
                    ename: 'NameError',
                    evalue: 'name not defined',
                    traceback: ['Traceback...']
                },
                messages: [
                    {
                        msg_type: 'error',
                        content: {
                            ename: 'NameError',
                            evalue: 'name not defined',
                            traceback: ['Traceback...']
                        }
                    }
                ]
            });

            const code = 'undefined_variable';
            const { executeSilently } = await import('./helpers');
            const result = await executeSilently(mockKernel as any, code);

            assert.isArray(result);
            assert.equal(result.length, 1);
            assert.equal(result[0].output_type, 'error');
            assert.equal((result[0] as any).ename, 'NameError');
            assert.equal((result[0] as any).evalue, 'name not defined');
            assert.deepStrictEqual((result[0] as any).traceback, ['Traceback...']);
        });

        test('Collects display_data outputs', async () => {
            const mockKernel = createMockKernel({
                status: 'ok',
                messages: [
                    {
                        msg_type: 'display_data',
                        content: {
                            data: {
                                'text/plain': 'some data'
                            },
                            metadata: {}
                        }
                    }
                ]
            });

            const code = 'display("data")';
            const { executeSilently } = await import('./helpers');
            const result = await executeSilently(mockKernel as any, code);

            assert.isArray(result);
            assert.equal(result.length, 1);
            assert.equal(result[0].output_type, 'display_data');
            assert.deepStrictEqual((result[0] as any).data, { 'text/plain': 'some data' });
            assert.deepStrictEqual((result[0] as any).metadata, {});
        });

        test('Handles multiple outputs', async () => {
            const mockKernel = createMockKernel({
                status: 'ok',
                messages: [
                    {
                        msg_type: 'stream',
                        content: {
                            name: 'stdout',
                            text: 'output 1'
                        }
                    },
                    {
                        msg_type: 'stream',
                        content: {
                            name: 'stdout',
                            text: 'output 2'
                        }
                    }
                ]
            });

            const code = 'print("1"); print("2")';
            const { executeSilently } = await import('./helpers');
            const result = await executeSilently(mockKernel as any, code);

            assert.isArray(result);
            // Consecutive stream messages with the same name are concatenated
            assert.equal(result.length, 1);
            assert.equal(result[0].output_type, 'stream');
            assert.equal((result[0] as any).name, 'stdout');
            assert.equal((result[0] as any).text, 'output 1output 2');
        });
    });
});
