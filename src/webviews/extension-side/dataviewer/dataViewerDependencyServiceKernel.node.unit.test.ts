// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';
import { IKernel, IKernelController, IKernelSession } from '../../../kernels/types';
import { Common, DataScience } from '../../../platform/common/utils/localize';
import * as sinon from 'sinon';
import esmock from 'esmock';
import { kernelGetPandasVersion } from '../../../webviews/extension-side/dataviewer/kernelDataViewerDependencyImplementation';
import { IInstaller } from '../../../platform/interpreter/installer/types';
import { IInterpreterService } from '../../../platform/interpreter/contracts';
import { ProductInstaller } from '../../../platform/interpreter/installer/productInstaller.node';
import { pandasMinimumVersionSupportedByVariableViewer } from '../../../webviews/extension-side/dataviewer/constants';
import { PythonExecutionFactory } from '../../../platform/interpreter/pythonExecutionFactory.node';
import { IPythonExecutionFactory } from '../../../platform/interpreter/types.node';
import { Kernel } from '@jupyterlab/services';
import { mockedVSCode, mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';

suite('DataViewerDependencyService (IKernel, Node)', () => {
    let pythonExecFactory: IPythonExecutionFactory;
    let installer: IInstaller;
    let interpreterService: IInterpreterService;
    let kernel: IKernel;
    let session: IKernelSession;

    setup(async () => {
        resetVSCodeMocks();
        installer = mock(ProductInstaller);
        pythonExecFactory = mock(PythonExecutionFactory);
        interpreterService = mock<IInterpreterService>();
        kernel = mock<IKernel>();
        session = mock<IKernelSession>();
        when(session.kernel).thenReturn(instance(mock<Kernel.IKernelConnection>()));
        when(kernel.session).thenReturn(instance(session));
        when(kernel.controller).thenReturn(instance(mock<IKernelController>()));
    });

    teardown(() => {
        resetVSCodeMocks();
        sinon.restore();
    });

    test('What if there are no kernel sessions?', async () => {
        const { DataViewerDependencyService } = await esmock(
            '../../../webviews/extension-side/dataviewer/dataViewerDependencyService.node'
        );

        const dependencyService = new DataViewerDependencyService(
            instance(installer),
            instance(pythonExecFactory),
            instance(interpreterService)
        );

        when(kernel.session).thenReturn(undefined);

        const resultPromise = dependencyService.checkAndInstallMissingDependencies(instance(kernel));

        await assert.isRejected(
            resultPromise,
            'No no active kernel session.',
            'Failed to determine if there was an active kernel session'
        );
    });

    test('All ok, if pandas is installed and version is > 1.20', async () => {
        const version = '3.3.3';

        const mockExecuteSilently = sinon
            .stub()
            .returns(
                Promise.resolve([
                    { ename: 'stdout', output_type: 'stream', text: `${version}\n5dc3a68c-e34e-4080-9c3e-2a532b2ccb4d` }
                ])
            );

        const { KernelDataViewerDependencyImplementation } = await esmock(
            '../../../webviews/extension-side/dataviewer/kernelDataViewerDependencyImplementation',
            {
                '../../../kernels/helpers': {
                    executeSilently: mockExecuteSilently
                }
            }
        );

        const { DataViewerDependencyService } = await esmock(
            '../../../webviews/extension-side/dataviewer/dataViewerDependencyService.node',
            {
                '../../../webviews/extension-side/dataviewer/kernelDataViewerDependencyImplementation': {
                    KernelDataViewerDependencyImplementation
                }
            }
        );

        const dependencyService = new DataViewerDependencyService(
            instance(installer),
            instance(pythonExecFactory),
            instance(interpreterService)
        );

        const result = await dependencyService.checkAndInstallMissingDependencies(instance(kernel));
        assert.equal(result, undefined);
        assert.deepEqual(
            mockExecuteSilently.getCalls().map((call) => call.lastArg),
            [kernelGetPandasVersion]
        );
    });

    test('All ok, if pandas is installed and version is > 1.20, even if the command returns with a new line', async () => {
        const version = '1.4.2\n';

        const mockExecuteSilently = sinon
            .stub()
            .returns(
                Promise.resolve([
                    { ename: 'stdout', output_type: 'stream', text: `${version}\n5dc3a68c-e34e-4080-9c3e-2a532b2ccb4d` }
                ])
            );

        const { KernelDataViewerDependencyImplementation } = await esmock(
            '../../../webviews/extension-side/dataviewer/kernelDataViewerDependencyImplementation',
            {
                '../../../kernels/helpers': {
                    executeSilently: mockExecuteSilently
                }
            }
        );

        const { DataViewerDependencyService } = await esmock(
            '../../../webviews/extension-side/dataviewer/dataViewerDependencyService.node',
            {
                '../../../webviews/extension-side/dataviewer/kernelDataViewerDependencyImplementation': {
                    KernelDataViewerDependencyImplementation
                }
            }
        );

        const dependencyService = new DataViewerDependencyService(
            instance(installer),
            instance(pythonExecFactory),
            instance(interpreterService)
        );

        const result = await dependencyService.checkAndInstallMissingDependencies(instance(kernel));
        assert.equal(result, undefined);
        assert.deepEqual(
            mockExecuteSilently.getCalls().map((call) => call.lastArg),
            [kernelGetPandasVersion]
        );
    });

    test('Throw exception if pandas is installed and version is = 0.20', async () => {
        const version = '0.20.0';

        const mockExecuteSilently = sinon
            .stub()
            .returns(
                Promise.resolve([
                    { ename: 'stdout', output_type: 'stream', text: `${version}\n5dc3a68c-e34e-4080-9c3e-2a532b2ccb4d` }
                ])
            );

        const { KernelDataViewerDependencyImplementation } = await esmock(
            '../../../webviews/extension-side/dataviewer/kernelDataViewerDependencyImplementation',
            {
                '../../../kernels/helpers': {
                    executeSilently: mockExecuteSilently
                }
            }
        );

        const { DataViewerDependencyService } = await esmock(
            '../../../webviews/extension-side/dataviewer/dataViewerDependencyService.node',
            {
                '../../../webviews/extension-side/dataviewer/kernelDataViewerDependencyImplementation': {
                    KernelDataViewerDependencyImplementation
                }
            }
        );

        const dependencyService = new DataViewerDependencyService(
            instance(installer),
            instance(pythonExecFactory),
            instance(interpreterService)
        );

        const resultPromise = dependencyService.checkAndInstallMissingDependencies(instance(kernel));
        await assert.isRejected(
            resultPromise,
            DataScience.pandasTooOldForViewingFormat('0.20.', pandasMinimumVersionSupportedByVariableViewer),
            'Failed to identify too old pandas'
        );
        assert.deepEqual(
            mockExecuteSilently.getCalls().map((call) => call.lastArg),
            [kernelGetPandasVersion]
        );
    });

    test('Throw exception if pandas is installed and version is < 0.20', async () => {
        const version = '0.10.0';

        const mockExecuteSilently = sinon
            .stub()
            .returns(
                Promise.resolve([
                    { ename: 'stdout', output_type: 'stream', text: `${version}\n5dc3a68c-e34e-4080-9c3e-2a532b2ccb4d` }
                ])
            );

        const { KernelDataViewerDependencyImplementation } = await esmock(
            '../../../webviews/extension-side/dataviewer/kernelDataViewerDependencyImplementation',
            {
                '../../../kernels/helpers': {
                    executeSilently: mockExecuteSilently
                }
            }
        );

        const { DataViewerDependencyService } = await esmock(
            '../../../webviews/extension-side/dataviewer/dataViewerDependencyService.node',
            {
                '../../../webviews/extension-side/dataviewer/kernelDataViewerDependencyImplementation': {
                    KernelDataViewerDependencyImplementation
                }
            }
        );

        const dependencyService = new DataViewerDependencyService(
            instance(installer),
            instance(pythonExecFactory),
            instance(interpreterService)
        );

        const resultPromise = dependencyService.checkAndInstallMissingDependencies(instance(kernel));
        await assert.isRejected(
            resultPromise,
            DataScience.pandasTooOldForViewingFormat('0.10.', pandasMinimumVersionSupportedByVariableViewer),
            'Failed to identify too old pandas'
        );
        assert.deepEqual(
            mockExecuteSilently.getCalls().map((call) => call.lastArg),
            [kernelGetPandasVersion]
        );
    });

    // NOTE: This test is skipped because esmock and vscode mocking don't work well together.
    // esmock creates its own module loading context that doesn't integrate with mocha-esm-loader's
    // vscode mocking system. The test requires mocking both executeSilently (via esmock) and
    // window.showErrorMessage (via vscode mocking), which is not currently possible.
    // This test passed before ESM migration with Sinon's direct stubbing.
    test.skip('Prompt to install pandas, then install pandas', async () => {
        // Set up vscode mock BEFORE creating esmock modules
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        when(mockedVSCodeNamespaces.window.showErrorMessage(anything(), anything(), anything())).thenResolve(
            Common.install as any
        );

        const mockExecuteSilently = sinon.stub();
        mockExecuteSilently
            .onFirstCall()
            .returns(Promise.resolve([{ ename: 'stdout', output_type: 'stream', text: '' }]));
        mockExecuteSilently
            .onSecondCall()
            .returns(Promise.resolve([{ ename: 'stdout', output_type: 'stream', text: '1.0.0' }]));

        const { KernelDataViewerDependencyImplementation } = await esmock(
            '../../../webviews/extension-side/dataviewer/kernelDataViewerDependencyImplementation',
            {
                '../../../kernels/helpers': {
                    executeSilently: mockExecuteSilently
                }
            },
            {
                vscode: {
                    CancellationTokenSource: mockedVSCode.CancellationTokenSource,
                    window: mockedVSCode.window
                }
            }
        );

        const { DataViewerDependencyService } = await esmock(
            '../../../webviews/extension-side/dataviewer/dataViewerDependencyService.node',
            {
                '../../../webviews/extension-side/dataviewer/kernelDataViewerDependencyImplementation': {
                    KernelDataViewerDependencyImplementation
                }
            }
        );

        const dependencyService = new DataViewerDependencyService(
            instance(installer),
            instance(pythonExecFactory),
            instance(interpreterService)
        );

        const resultPromise = dependencyService.checkAndInstallMissingDependencies(instance(kernel));
        assert.equal(await resultPromise, undefined);
        assert.deepEqual(
            mockExecuteSilently.getCalls().map((call) => call.lastArg),
            [kernelGetPandasVersion, '%pip install pandas']
        );
    });

    // NOTE: Skipped for the same reason as "Prompt to install pandas, then install pandas" above.
    test.skip('Prompt to install pandas and throw error if user does not install pandas', async () => {
        const mockExecuteSilently = sinon
            .stub()
            .returns(Promise.resolve([{ ename: 'stdout', output_type: 'stream', text: '' }]));

        const { KernelDataViewerDependencyImplementation } = await esmock(
            '../../../webviews/extension-side/dataviewer/kernelDataViewerDependencyImplementation',
            {
                '../../../kernels/helpers': {
                    executeSilently: mockExecuteSilently
                }
            }
        );

        const { DataViewerDependencyService } = await esmock(
            '../../../webviews/extension-side/dataviewer/dataViewerDependencyService.node',
            {
                '../../../webviews/extension-side/dataviewer/kernelDataViewerDependencyImplementation': {
                    KernelDataViewerDependencyImplementation
                }
            }
        );

        const dependencyService = new DataViewerDependencyService(
            instance(installer),
            instance(pythonExecFactory),
            instance(interpreterService)
        );

        when(mockedVSCodeNamespaces.window.showErrorMessage(anything(), anything(), anything())).thenResolve();

        const resultPromise = dependencyService.checkAndInstallMissingDependencies(instance(kernel));
        await assert.isRejected(
            resultPromise,
            DataScience.pandasRequiredForViewing(pandasMinimumVersionSupportedByVariableViewer)
        );
        assert.deepEqual(
            mockExecuteSilently.getCalls().map((call) => call.lastArg),
            [kernelGetPandasVersion]
        );
    });
});
