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
    IFederatedAuthSqlBlockCodeGenerator,
    IFederatedAuthTokenStorage,
    IIntegrationDetector,
    IIntegrationManager,
    IIntegrationStorage,
    IIntegrationWebviewProvider
} from './deepnote/integrations/types';
import { FederatedAuthCommandHandlerNode } from './deepnote/integrations/federatedAuth/federatedAuthCommandHandler.node';
import { FederatedAuthKernelRestartBridge } from './deepnote/integrations/federatedAuth/federatedAuthKernelRestartBridge.node';
import { FederatedAuthOrphanedTokenCleaner } from './deepnote/integrations/federatedAuth/federatedAuthOrphanedTokenCleaner.node';
import { FederatedAuthSqlBlockCodeGenerator } from './deepnote/integrations/federatedAuth/federatedAuthSqlBlockCodeGenerator.node';
import { FederatedAuthTokenStorage } from './deepnote/integrations/federatedAuth/federatedAuthTokenStorage.node';
import {
    IPlatformNotebookEditorProvider,
    IPlatformDeepnoteNotebookManager
} from '../platform/notebooks/deepnote/types';
import { SqlCellStatusBarProvider } from './deepnote/sqlCellStatusBarProvider';
import { DirtyInputBlockStatusBarProvider } from './deepnote/dirtyInputBlockStatusBarProvider';
import { StaleOutputStatusBarProvider } from './deepnote/staleOutputStatusBarProvider';
import {
    IDeepnoteToolkitInstaller,
    IDeepnoteServerStarter,
    IDeepnoteKernelAutoSelector,
    IDeepnoteServerProvider,
    IDeepnoteEnvironmentManager,
    IDeepnoteNotebookEnvironmentMapper,
    IDeepnoteLspClientManager,
    IServerHandleRegistry
} from '../kernels/deepnote/types';
import { DeepnoteAgentSkillsManager } from '../kernels/deepnote/deepnoteAgentSkillsManager.node';
import { DeepnoteToolkitInstaller } from '../kernels/deepnote/deepnoteToolkitInstaller.node';
import { DeepnoteServerStarter } from '../kernels/deepnote/deepnoteServerStarter.node';
import { DeepnoteKernelAutoSelector } from './deepnote/deepnoteKernelAutoSelector.node';
import { DeepnoteServerProvider } from '../kernels/deepnote/deepnoteServerProvider.node';
import { ServerHandleRegistry } from '../kernels/deepnote/deepnoteServerHandleRegistry.node';
import { DeepnoteLspClientManager } from '../kernels/deepnote/deepnoteLspClientManager.node';
import { DeepnoteInitNotebookRunner, IDeepnoteInitNotebookRunner } from './deepnote/deepnoteInitNotebookRunner.node';
import { DeepnoteRequirementsHelper, IDeepnoteRequirementsHelper } from './deepnote/deepnoteRequirementsHelper.node';
import { DeepnoteEnvironmentManager } from '../kernels/deepnote/environments/deepnoteEnvironmentManager.node';
import { DeepnoteEnvironmentStorage } from '../kernels/deepnote/environments/deepnoteEnvironmentStorage.node';
import { DeepnoteEnvironmentsView } from '../kernels/deepnote/environments/deepnoteEnvironmentsView.node';
import { DeepnoteEnvironmentsActivationService } from '../kernels/deepnote/environments/deepnoteEnvironmentsActivationService';
import { DeepnoteExtensionSidecarWriter } from '../kernels/deepnote/environments/deepnoteExtensionSidecarWriter.node';
import { DeepnoteNotebookEnvironmentMapper } from '../kernels/deepnote/environments/deepnoteNotebookEnvironmentMapper.node';
import { DeepnoteNotebookCommandListener } from './deepnote/deepnoteNotebookCommandListener';
import { DeepnoteInputBlockCellStatusBarItemProvider } from './deepnote/deepnoteInputBlockCellStatusBarProvider';
import { DeepnoteBigNumberCellStatusBarProvider } from './deepnote/deepnoteBigNumberCellStatusBarProvider';
import { DeepnoteNewCellLanguageService } from './deepnote/deepnoteNewCellLanguageService';
import { SqlIntegrationStartupCodeProvider } from './deepnote/integrations/sqlIntegrationStartupCodeProvider';
import { DeepnoteCellCopyHandler } from './deepnote/deepnoteCellCopyHandler';
import { DeepnoteEnvironmentTreeDataProvider } from '../kernels/deepnote/environments/deepnoteEnvironmentTreeDataProvider.node';
import { OpenInDeepnoteHandler } from './deepnote/openInDeepnoteHandler.node';
import { IntegrationKernelRestartHandler } from './deepnote/integrations/integrationKernelRestartHandler';
import { ISnapshotMetadataService, SnapshotService } from './deepnote/snapshots/snapshotService';
import { EnvironmentCapture, IEnvironmentCapture } from './deepnote/snapshots/environmentCapture.node';
import { DeepnoteFileChangeWatcher } from './deepnote/deepnoteFileChangeWatcher';
import { DeepnoteNotebookInfoStatusBar } from './deepnote/deepnoteNotebookInfoStatusBar';

export function registerTypes(serviceManager: IServiceManager, isDevMode: boolean) {
    registerControllerTypes(serviceManager, isDevMode);
    serviceManager.addSingleton<IExtensionSyncActivationService>(IExtensionSyncActivationService, LiveKernelSwitcher);
    serviceManager.addSingleton<INotebookCommandHandler>(INotebookCommandHandler, NotebookCommandListener);
    serviceManager.addBinding(INotebookCommandHandler, IExtensionSyncActivationService);
    serviceManager.addSingleton<INotebookEditorProvider>(INotebookEditorProvider, NotebookEditorProvider);
    // Bind the platform-layer interface to the same implementation
    serviceManager.addBinding(INotebookEditorProvider, IPlatformNotebookEditorProvider);
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
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        DeepnoteNotebookCommandListener
    );
    serviceManager.addSingleton<IDeepnoteNotebookManager>(IDeepnoteNotebookManager, DeepnoteNotebookManager);
    // Bind the platform-layer interface to the same implementation
    serviceManager.addBinding(IDeepnoteNotebookManager, IPlatformDeepnoteNotebookManager);
    serviceManager.addSingleton<IIntegrationStorage>(IIntegrationStorage, IntegrationStorage);
    serviceManager.addSingleton<IIntegrationDetector>(IIntegrationDetector, IntegrationDetector);
    serviceManager.addSingleton<IIntegrationWebviewProvider>(IIntegrationWebviewProvider, IntegrationWebviewProvider);
    serviceManager.addSingleton<IIntegrationManager>(IIntegrationManager, IntegrationManager);
    serviceManager.addSingleton<IFederatedAuthTokenStorage>(IFederatedAuthTokenStorage, FederatedAuthTokenStorage);
    serviceManager.addSingleton<IFederatedAuthSqlBlockCodeGenerator>(
        IFederatedAuthSqlBlockCodeGenerator,
        FederatedAuthSqlBlockCodeGenerator
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        FederatedAuthCommandHandlerNode
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        FederatedAuthKernelRestartBridge
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        FederatedAuthOrphanedTokenCleaner
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        SqlCellStatusBarProvider
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        StaleOutputStatusBarProvider
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        DirtyInputBlockStatusBarProvider
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        SqlIntegrationStartupCodeProvider
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        DeepnoteCellCopyHandler
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        OpenInDeepnoteHandler
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        IntegrationKernelRestartHandler
    );

    // Deepnote kernel services
    serviceManager.addSingleton<DeepnoteAgentSkillsManager>(DeepnoteAgentSkillsManager, DeepnoteAgentSkillsManager);
    serviceManager.addSingleton<IDeepnoteToolkitInstaller>(IDeepnoteToolkitInstaller, DeepnoteToolkitInstaller);
    serviceManager.addSingleton<IDeepnoteServerStarter>(IDeepnoteServerStarter, DeepnoteServerStarter);
    serviceManager.addBinding(IDeepnoteServerStarter, IExtensionSyncActivationService);
    serviceManager.addSingleton<IDeepnoteServerProvider>(IDeepnoteServerProvider, DeepnoteServerProvider);
    serviceManager.addBinding(IDeepnoteServerProvider, IExtensionSyncActivationService);
    serviceManager.addSingleton<IServerHandleRegistry>(IServerHandleRegistry, ServerHandleRegistry);
    serviceManager.addSingleton<IDeepnoteKernelAutoSelector>(IDeepnoteKernelAutoSelector, DeepnoteKernelAutoSelector);
    serviceManager.addBinding(IDeepnoteKernelAutoSelector, IExtensionSyncActivationService);
    serviceManager.addSingleton<IDeepnoteLspClientManager>(IDeepnoteLspClientManager, DeepnoteLspClientManager);
    serviceManager.addBinding(IDeepnoteLspClientManager, IExtensionSyncActivationService);
    serviceManager.addSingleton<IDeepnoteInitNotebookRunner>(IDeepnoteInitNotebookRunner, DeepnoteInitNotebookRunner);
    serviceManager.addBinding(IDeepnoteInitNotebookRunner, IExtensionSyncActivationService);
    serviceManager.addSingleton<IDeepnoteRequirementsHelper>(IDeepnoteRequirementsHelper, DeepnoteRequirementsHelper);
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        DeepnoteInputBlockCellStatusBarItemProvider
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        DeepnoteBigNumberCellStatusBarProvider
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        DeepnoteNewCellLanguageService
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        DeepnoteNotebookInfoStatusBar
    );

    // Deepnote configuration services
    serviceManager.addSingleton<DeepnoteEnvironmentStorage>(DeepnoteEnvironmentStorage, DeepnoteEnvironmentStorage);
    serviceManager.addSingleton<IDeepnoteEnvironmentManager>(IDeepnoteEnvironmentManager, DeepnoteEnvironmentManager);
    serviceManager.addSingleton<DeepnoteEnvironmentTreeDataProvider>(
        DeepnoteEnvironmentTreeDataProvider,
        DeepnoteEnvironmentTreeDataProvider
    );

    // Deepnote configuration view
    serviceManager.addSingleton<DeepnoteEnvironmentsView>(DeepnoteEnvironmentsView, DeepnoteEnvironmentsView);
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        DeepnoteEnvironmentsActivationService
    );

    // Deepnote configuration selection
    serviceManager.addSingleton<IDeepnoteNotebookEnvironmentMapper>(
        IDeepnoteNotebookEnvironmentMapper,
        DeepnoteNotebookEnvironmentMapper
    );

    // Sidecar file writer (exposes env mappings for external tools)
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        DeepnoteExtensionSidecarWriter
    );

    // Snapshot service
    serviceManager.addSingleton<IEnvironmentCapture>(IEnvironmentCapture, EnvironmentCapture);
    serviceManager.addSingleton<SnapshotService>(SnapshotService, SnapshotService);
    serviceManager.addBinding(SnapshotService, IExtensionSyncActivationService);
    serviceManager.addBinding(SnapshotService, ISnapshotMetadataService);

    // File change watcher for external edits
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        DeepnoteFileChangeWatcher
    );

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
