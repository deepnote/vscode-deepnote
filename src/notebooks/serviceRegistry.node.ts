// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ITracebackFormatter } from '../kernels/types';
import { IJupyterVariables } from '../kernels/variables/types';
import { IExtensionSyncActivationService } from '../platform/activation/types';
import { Identifiers } from '../platform/common/constants';
import { IServiceManager } from '../platform/ioc/types';
import { InstallPythonControllerCommands } from './controllers/commands/installPythonControllerCommands';
import { LiveKernelSwitcher } from './controllers/liveKernelSwitcher';
import { NotebookIPyWidgetCoordinator } from './controllers/notebookIPyWidgetCoordinator';
import { RemoteKernelConnectionHandler } from './controllers/remoteKernelConnectionHandler';
import { RemoteKernelControllerWatcher } from './controllers/remoteKernelControllerWatcher';
import { registerTypes as registerControllerTypes } from './controllers/serviceRegistry.node';
import { CommandRegistry } from './debugger/commandRegistry';
import { DebuggerVariableRegistration } from './debugger/debuggerVariableRegistration.node';
import { DebuggerVariables } from './debugger/debuggerVariables';
import { DebuggingManager } from './debugger/debuggingManager';
import {
    IDebuggingManager,
    IDebugLocationTracker,
    IDebugLocationTrackerFactory,
    IJupyterDebugService,
    INotebookDebuggingManager
} from './debugger/debuggingTypes';
import { DebugLocationTrackerFactory } from './debugger/debugLocationTrackerFactory';
import { JupyterDebugService } from './debugger/jupyterDebugService.node';
import { MultiplexingDebugService } from './debugger/multiplexingDebugService';
import { ExportBase } from './export/exportBase.node';
import { ExportInterpreterFinder } from './export/exportInterpreterFinder.node';
import { ExportUtil } from './export/exportUtil.node';
import { FileConverter } from './export/fileConverter.node';
import { IExportBase, IExportUtil, IFileConverter } from './export/types';
import { NotebookCellLanguageService } from './languages/cellLanguageService';
import { EmptyNotebookCellLanguageService } from './languages/emptyNotebookCellLanguageService';
import { INotebookCommandHandler, NotebookCommandListener } from './notebookCommandListener';
import { NotebookEditorProvider } from './notebookEditorProvider';
import { NotebookPythonEnvironmentService } from './notebookEnvironmentService.node';
import { CellOutputMimeTypeTracker } from './outputs/cellOutputMimeTypeTracker';
import { NotebookTracebackFormatter } from './outputs/tracebackFormatter';
import { InterpreterPackageTracker } from './telemetry/interpreterPackageTracker.node';
import { INotebookEditorProvider, INotebookPythonEnvironmentService } from './types';
import { DeepnoteActivationService } from './deepnote/deepnoteActivationService';
import { DeepnoteNotebookManager } from './deepnote/deepnoteNotebookManager';
import { IDeepnoteNotebookManager } from './types';
import { IntegrationStorage } from '../platform/notebooks/deepnote/integrationStorage';
import { IntegrationDetector } from './deepnote/integrations/integrationDetector';
import { IntegrationManager } from './deepnote/integrations/integrationManager';
import { IntegrationWebviewProvider } from './deepnote/integrations/integrationWebview';
import {
    IIntegrationDetector,
    IIntegrationManager,
    IIntegrationStorage,
    IIntegrationWebviewProvider
} from './deepnote/integrations/types';
import { SqlCellStatusBarProvider } from './deepnote/sqlCellStatusBarProvider';
import {
    IDeepnoteToolkitInstaller,
    IDeepnoteServerStarter,
    IDeepnoteKernelAutoSelector,
    IDeepnoteServerProvider
} from '../kernels/deepnote/types';
import { DeepnoteToolkitInstaller } from '../kernels/deepnote/deepnoteToolkitInstaller.node';
import { DeepnoteServerStarter } from '../kernels/deepnote/deepnoteServerStarter.node';
import { DeepnoteKernelAutoSelector } from './deepnote/deepnoteKernelAutoSelector.node';
import { DeepnoteServerProvider } from '../kernels/deepnote/deepnoteServerProvider.node';
import { DeepnoteInitNotebookRunner, IDeepnoteInitNotebookRunner } from './deepnote/deepnoteInitNotebookRunner.node';
import { DeepnoteRequirementsHelper, IDeepnoteRequirementsHelper } from './deepnote/deepnoteRequirementsHelper.node';
import { SqlIntegrationStartupCodeProvider } from './deepnote/integrations/sqlIntegrationStartupCodeProvider';

export function registerTypes(serviceManager: IServiceManager, isDevMode: boolean) {
    registerControllerTypes(serviceManager, isDevMode);
    serviceManager.addSingleton<IExtensionSyncActivationService>(IExtensionSyncActivationService, LiveKernelSwitcher);
    serviceManager.addSingleton<INotebookCommandHandler>(INotebookCommandHandler, NotebookCommandListener);
    serviceManager.addBinding(INotebookCommandHandler, IExtensionSyncActivationService);
    serviceManager.addSingleton<INotebookEditorProvider>(INotebookEditorProvider, NotebookEditorProvider);
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        RemoteKernelControllerWatcher
    );
    serviceManager.addSingleton<ITracebackFormatter>(ITracebackFormatter, NotebookTracebackFormatter);
    serviceManager.addSingleton<IJupyterDebugService>(
        IJupyterDebugService,
        JupyterDebugService,
        Identifiers.RUN_BY_LINE_DEBUGSERVICE
    );
    serviceManager.addSingleton<NotebookIPyWidgetCoordinator>(
        NotebookIPyWidgetCoordinator,
        NotebookIPyWidgetCoordinator
    );
    serviceManager.addBinding(NotebookIPyWidgetCoordinator, IExtensionSyncActivationService);
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        RemoteKernelConnectionHandler
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        InterpreterPackageTracker
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        InstallPythonControllerCommands
    );

    serviceManager.addSingleton<NotebookCellLanguageService>(NotebookCellLanguageService, NotebookCellLanguageService);
    serviceManager.addBinding(NotebookCellLanguageService, IExtensionSyncActivationService);
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        EmptyNotebookCellLanguageService
    );

    // Debugging
    serviceManager.addSingleton<IDebuggingManager>(INotebookDebuggingManager, DebuggingManager, undefined, [
        IExtensionSyncActivationService
    ]);
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        DebuggerVariableRegistration
    );
    serviceManager.addSingleton<IJupyterVariables>(
        IJupyterVariables,
        DebuggerVariables,
        Identifiers.DEBUGGER_VARIABLES
    );
    serviceManager.addSingleton<IJupyterDebugService>(
        IJupyterDebugService,
        MultiplexingDebugService,
        Identifiers.MULTIPLEXING_DEBUGSERVICE
    );
    serviceManager.addSingleton<IDebugLocationTracker>(IDebugLocationTracker, DebugLocationTrackerFactory, undefined, [
        IDebugLocationTrackerFactory
    ]);
    serviceManager.addSingleton<IExtensionSyncActivationService>(IExtensionSyncActivationService, CommandRegistry);
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        CellOutputMimeTypeTracker
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        DeepnoteActivationService
    );
    serviceManager.addSingleton<IDeepnoteNotebookManager>(IDeepnoteNotebookManager, DeepnoteNotebookManager);
    serviceManager.addSingleton<IIntegrationStorage>(IIntegrationStorage, IntegrationStorage);
    serviceManager.addSingleton<IIntegrationDetector>(IIntegrationDetector, IntegrationDetector);
    serviceManager.addSingleton<IIntegrationWebviewProvider>(IIntegrationWebviewProvider, IntegrationWebviewProvider);
    serviceManager.addSingleton<IIntegrationManager>(IIntegrationManager, IntegrationManager);
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        SqlCellStatusBarProvider
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        SqlIntegrationStartupCodeProvider
    );

    // Deepnote kernel services
    serviceManager.addSingleton<IDeepnoteToolkitInstaller>(IDeepnoteToolkitInstaller, DeepnoteToolkitInstaller);
    serviceManager.addSingleton<IDeepnoteServerStarter>(IDeepnoteServerStarter, DeepnoteServerStarter);
    serviceManager.addBinding(IDeepnoteServerStarter, IExtensionSyncActivationService);
    serviceManager.addSingleton<IDeepnoteServerProvider>(IDeepnoteServerProvider, DeepnoteServerProvider);
    serviceManager.addBinding(IDeepnoteServerProvider, IExtensionSyncActivationService);
    serviceManager.addSingleton<IDeepnoteKernelAutoSelector>(IDeepnoteKernelAutoSelector, DeepnoteKernelAutoSelector);
    serviceManager.addBinding(IDeepnoteKernelAutoSelector, IExtensionSyncActivationService);
    serviceManager.addSingleton<IDeepnoteInitNotebookRunner>(IDeepnoteInitNotebookRunner, DeepnoteInitNotebookRunner);
    serviceManager.addSingleton<IDeepnoteRequirementsHelper>(IDeepnoteRequirementsHelper, DeepnoteRequirementsHelper);

    // File export/import
    serviceManager.addSingleton<IFileConverter>(IFileConverter, FileConverter);
    serviceManager.addSingleton<ExportInterpreterFinder>(ExportInterpreterFinder, ExportInterpreterFinder);

    serviceManager.addSingleton<IExportBase>(IExportBase, ExportBase);
    serviceManager.addSingleton<IExportUtil>(IExportUtil, ExportUtil);
    serviceManager.addSingleton<NotebookPythonEnvironmentService>(
        INotebookPythonEnvironmentService,
        NotebookPythonEnvironmentService
    );
}
