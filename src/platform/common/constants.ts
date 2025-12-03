// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export const PYTHON_LANGUAGE = 'python';
export const MARKDOWN_LANGUAGE = 'markdown';
export const NotebookCellScheme = 'vscode-notebook-cell';
export const PYTHON_UNTITLED = { scheme: 'untitled', language: PYTHON_LANGUAGE };
export const PYTHON_FILE = { scheme: 'file', language: PYTHON_LANGUAGE };
export const PYTHON_FILE_ANY_SCHEME = { language: PYTHON_LANGUAGE };
export const PYTHON_CELL = { scheme: NotebookCellScheme, language: PYTHON_LANGUAGE };
export const PYTHON = [PYTHON_UNTITLED, PYTHON_FILE, PYTHON_CELL];
export const InteractiveInputScheme = 'vscode-interactive-input';
export const JupyterNotebookView = 'jupyter-notebook';
export const InteractiveWindowView = 'interactive';

export const NOTEBOOK_SELECTOR = [
    { language: PYTHON_LANGUAGE, notebookType: JupyterNotebookView },
    { language: PYTHON_LANGUAGE, notebookType: InteractiveWindowView },
    { scheme: InteractiveInputScheme, language: PYTHON_LANGUAGE },
    { scheme: NotebookCellScheme, language: PYTHON_LANGUAGE }
];

export const CodespaceExtensionId = 'GitHub.codespaces';
export const JVSC_EXTENSION_ID = 'Deepnote.vscode-deepnote';
export const DATA_WRANGLER_EXTENSION_ID = 'ms-toolsai.datawrangler';
export const PROPOSED_API_ALLOWED_PUBLISHERS = ['donjayamanne'];
export const POWER_TOYS_EXTENSION_ID = 'ms-toolsai.vscode-jupyter-powertoys';
export const SENTINEL_EXTENSION_ID = 'ms-security.ms-sentinel';
export const JUPYTER_HUB_EXTENSION_ID = 'ms-toolsai.jupyter-hub';
export const AppinsightsKey = '0c6ae279ed8443289764825290e4f9e2-1a736e7c-1324-4338-be46-fc2a58ae4d14-7255';

export const STANDARD_OUTPUT_CHANNEL = 'STANDARD_OUTPUT_CHANNEL';

export * from '../constants';

export namespace HelpLinks {
    export const PythonInteractiveHelpLink = 'https://aka.ms/pyaiinstall';
    export const JupyterDataRateHelpLink = 'https://aka.ms/AA5ggm0'; // This redirects here: https://jupyter-notebook.readthedocs.io/en/stable/config.html
}

export namespace Settings {
    export const JupyterServerRemoteLaunchNameSeparator = '\n';
    export const JupyterServerRemoteLaunchService = JVSC_EXTENSION_ID;
    export const JupyterServerUriListMax = 10;
    // If this timeout expires, ignore the completion request sent to deepnote.
    export var IntellisenseTimeout = 2_000;
    export const IntellisenseResolveTimeout = 5_000;
}

export let isCI = false;
export function setCI(enabled: boolean) {
    isCI = enabled;
}

let _isTestExecution = false;
export function isTestExecution(): boolean {
    return _isTestExecution || isUnitTestExecution();
}
export function setTestExecution(enabled: boolean) {
    _isTestExecution = enabled;
}

let _isUnitTestExecution = false;
/**
 * Whether we're running unit tests (*.unit.test.ts).
 * These tests have a speacial meaning, they run fast.
 * @export
 * @returns {boolean}
 */
export function isUnitTestExecution(): boolean {
    return _isUnitTestExecution;
}
export function setUnitTestExecution(enabled: boolean) {
    _isUnitTestExecution = enabled;
}

export namespace Identifiers {
    export const GeneratedThemeName = 'ipython-theme'; // This needs to be all lower class and a valid class name.
    export const MatplotLibDefaultParams = '_VSCode_defaultMatplotlib_Params';
    export const MatplotLibFigureFormats = '_VSCode_matplotLib_FigureFormats';
    export const DefaultCodeCellMarker = '# %%';
    export const DefaultCommTarget = 'deepnote.widget';
    export const ALL_VARIABLES = 'ALL_VARIABLES';
    export const KERNEL_VARIABLES = 'KERNEL_VARIABLES';
    export const DEBUGGER_VARIABLES = 'DEBUGGER_VARIABLES';
    export const PYTHON_VARIABLES_REQUESTER = 'PYTHON_VARIABLES_REQUESTER';
    export const MULTIPLEXING_DEBUGSERVICE = 'MULTIPLEXING_DEBUGSERVICE';
    export const RUN_BY_LINE_DEBUGSERVICE = 'RUN_BY_LINE_DEBUGSERVICE';
    export const REMOTE_URI = 'https://remote/';
    export const REMOTE_URI_ID_PARAM = 'id';
    export const REMOTE_URI_HANDLE_PARAM = 'uriHandle';
    export const REMOTE_URI_EXTENSION_ID_PARAM = 'extensionId';
}

export namespace CodeSnippets {
    export const ImportIPython = '{0}\nfrom IPython import get_ipython\n\n{1}';
    export const MatplotLibInit = `import matplotlib\n%matplotlib inline\n${Identifiers.MatplotLibDefaultParams} = dict(matplotlib.rcParams)\n`;
    export const DisableJedi = '%config Completer.use_jedi = False';
}

// Identifier for the output panel that will display the output from the Jupyter Server.
export const JUPYTER_OUTPUT_CHANNEL = 'JUPYTER_OUTPUT_CHANNEL';

export const DefaultTheme = 'Default Light+';

// Python Module to be used when instantiating the Python Daemon.

export const PythonExtension = 'ms-python.python';
export const PythonEnvironmentExtension = 'ms-python.vscode-python-envs';
export const RendererExtension = 'ms-toolsai.jupyter-renderers';

export const LanguagesSupportedByPythonkernel = [
    'python',
    'html', // %%html
    'xml', // %%svg as svg is same as `xml`
    'javascript', // %%javascript, %%js
    'markdown', // %%markdown, %%latex
    'latex', // %%latex (some extensions register such languages)
    'shellscript', // %%script, %%bash, %%sh
    'bat', // %%script, %%bash, %%sh
    'powershell', // %%script powershell, %%script pwsh
    'kusto', // %%kqlmagic
    'ruby', // %%ruby
    'sql', // %%sql
    'perl', // %%perl
    'qsharp', // %%qsharp
    'json', // JSON cells for custom block types
    'plaintext', // plaintext cells (e.g., Deepnote input-text blocks)
    'raw' // raw cells (no formatting)
];
export const jupyterLanguageToMonacoLanguageMapping = new Map([
    ['bash', 'shellscript'],
    ['c#', 'csharp'],
    ['f#', 'fsharp'],
    ['q#', 'qsharp'],
    ['c++11', 'c++'],
    ['c++12', 'c++'],
    ['c++14', 'c++']
]);
/**
 * This will get updated with the list of VS Code languages.
 * This way, we can send those via telemetry, instead of having to hardcode the languages.
 */
export const VSCodeKnownNotebookLanguages: string[] = [
    'python',
    'r',
    'julia',
    'c++',
    'c#',
    'f#',
    'q#',
    'powershell',
    'java',
    'scala',
    'haskell',
    'bash',
    'cling',
    'rust',
    'sas',
    'sos',
    'ocaml'
];

export enum CommandSource {
    auto = 'auto',
    ui = 'ui',
    codelens = 'codelens',
    commandPalette = 'commandpalette'
}

export namespace Commands {
    export const RunAllCells = 'deepnote.runallcells';
    export const RunAllCellsAbove = 'deepnote.runallcellsabove';
    export const RunCellAndAllBelow = 'deepnote.runcellandallbelow';
    export const RunAllCellsAbovePalette = 'deepnote.runallcellsabove.palette';
    export const RunCellAndAllBelowPalette = 'deepnote.runcurrentcellandallbelow.palette';
    export const RunToLine = 'deepnote.runtoline';
    export const RunFromLine = 'deepnote.runfromline';
    export const RunCell = 'deepnote.runcell';
    export const RunCurrentCell = 'deepnote.runcurrentcell';
    export const RunCurrentCellAdvance = 'deepnote.runcurrentcelladvance';
    export const CreateNewInteractive = 'deepnote.createnewinteractive';
    export const ImportNotebookFile = 'deepnote.importnotebookfile';
    export const ExportFileAsNotebook = 'deepnote.exportfileasnotebook';
    export const InterruptKernel = 'deepnote.interruptkernel';
    export const RestartKernel = 'deepnote.restartkernel';
    export const RestartKernelAndRunAllCells = 'deepnote.restartkernelandrunallcells';
    export const RestartKernelAndRunUpToSelectedCell = 'deepnote.restartkernelandrunuptoselectedcell';
    export const NotebookEditorRemoveAllCells = 'deepnote.notebookeditor.removeallcells';
    export const NotebookEditorRunAllCells = 'deepnote.notebookeditor.runallcells';
    export const NotebookEditorRunSelectedCell = 'deepnote.notebookeditor.runselectedcell';
    export const NotebookEditorRunFocusedCell = 'deepnote.notebookeditor.runfocusedcell';
    export const NotebookEditorAddCellBelow = 'deepnote.notebookeditor.addcellbelow';
    export const ExpandAllCells = 'deepnote.expandallcells';
    export const CollapseAllCells = 'deepnote.collapseallcells';
    export const ExecSelectionInInteractiveWindow = 'deepnote.execSelectionInteractive';
    export const RunFileInInteractiveWindows = 'deepnote.runFileInteractive';
    export const DebugFileInInteractiveWindows = 'deepnote.debugFileInteractive';
    export const AddCellBelow = 'deepnote.addcellbelow';
    export const DebugCurrentCellPalette = 'deepnote.debugcurrentcell.palette';
    export const DebugCell = 'deepnote.debugcell';
    export const DebugStepOver = 'deepnote.debugstepover';
    export const DebugContinue = 'deepnote.debugcontinue';
    export const DebugStop = 'deepnote.debugstop';
    export const RunCurrentCellAndAddBelow = 'deepnote.runcurrentcellandaddbelow';
    export const InsertCellBelowPosition = 'deepnote.insertCellBelowPosition';
    export const InsertCellBelow = 'deepnote.insertCellBelow';
    export const InsertCellAbove = 'deepnote.insertCellAbove';
    export const DeleteCells = 'deepnote.deleteCells';
    export const SelectCell = 'deepnote.selectCell';
    export const SelectCellContents = 'deepnote.selectCellContents';
    export const ExtendSelectionByCellAbove = 'deepnote.extendSelectionByCellAbove';
    export const ExtendSelectionByCellBelow = 'deepnote.extendSelectionByCellBelow';
    export const MoveCellsUp = 'deepnote.moveCellsUp';
    export const MoveCellsDown = 'deepnote.moveCellsDown';
    export const ChangeCellToMarkdown = 'deepnote.changeCellToMarkdown';
    export const ChangeCellToCode = 'deepnote.changeCellToCode';
    export const GotoNextCellInFile = 'deepnote.gotoNextCellInFile';
    export const GotoPrevCellInFile = 'deepnote.gotoPrevCellInFile';
    export const ScrollToCell = 'deepnote.scrolltocell';
    export const CreateNewNotebook = 'deepnote.createnewnotebook';
    export const ViewJupyterOutput = 'deepnote.viewOutput';
    export const RefreshDeepnoteExplorer = 'deepnote.refreshExplorer';
    export const OpenDeepnoteNotebook = 'deepnote.openNotebook';
    export const OpenDeepnoteFile = 'deepnote.openFile';
    export const RevealInDeepnoteExplorer = 'deepnote.revealInExplorer';
    export const ManageIntegrations = 'deepnote.manageIntegrations';
    export const AddSqlBlock = 'deepnote.addSqlBlock';
    export const AddBigNumberChartBlock = 'deepnote.addBigNumberChartBlock';
    export const AddChartBlock = 'deepnote.addChartBlock';
    export const AddInputTextBlock = 'deepnote.addInputTextBlock';
    export const AddInputTextareaBlock = 'deepnote.addInputTextareaBlock';
    export const AddInputSelectBlock = 'deepnote.addInputSelectBlock';
    export const AddInputSliderBlock = 'deepnote.addInputSliderBlock';
    export const AddInputCheckboxBlock = 'deepnote.addInputCheckboxBlock';
    export const AddInputDateBlock = 'deepnote.addInputDateBlock';
    export const AddInputDateRangeBlock = 'deepnote.addInputDateRangeBlock';
    export const AddInputFileBlock = 'deepnote.addInputFileBlock';
    export const AddButtonBlock = 'deepnote.addButtonBlock';
    export const NewNotebook = 'deepnote.newNotebook';
    export const NewProject = 'deepnote.newProject';
    export const ImportNotebook = 'deepnote.importNotebook';
    export const ImportJupyterNotebook = 'deepnote.importJupyterNotebook';
    export const RenameProject = 'deepnote.renameProject';
    export const DeleteProject = 'deepnote.deleteProject';
    export const RenameNotebook = 'deepnote.renameNotebook';
    export const DeleteNotebook = 'deepnote.deleteNotebook';
    export const DuplicateNotebook = 'deepnote.duplicateNotebook';
    export const AddNotebookToProject = 'deepnote.addNotebookToProject';
    export const ExportProject = 'deepnote.exportProject';
    export const ExportNotebook = 'deepnote.exportNotebook';
    export const OpenInDeepnote = 'deepnote.openInDeepnote';
    export const ExportAsPythonScript = 'deepnote.exportAsPythonScript';
    export const ExportToHTML = 'deepnote.exportToHTML';
    export const ExportToPDF = 'deepnote.exportToPDF';
    export const Export = 'deepnote.export';
    export const NativeNotebookExport = 'deepnote.notebookeditor.export';
    export const LatestExtension = 'deepnote.latestExtension';
    export const EnableLoadingWidgetsFrom3rdPartySource = 'deepnote.enableLoadingWidgetScriptsFromThirdPartySource';
    export const ShowDataViewer = 'deepnote.showDataViewer';
    export const ShowJupyterDataViewer = 'deepnote.showJupyterDataViewer';
    export const RefreshDataViewer = 'deepnote.refreshDataViewer';
    export const ClearSavedJupyterUris = 'deepnote.clearSavedJupyterUris';
    export const OpenVariableView = 'deepnote.openVariableView';
    export const OpenOutlineView = 'deepnote.openOutlineView';
    export const InteractiveClearAll = 'deepnote.interactive.clearAllCells';
    export const InteractiveGoToCode = 'deepnote.interactive.goToCode';
    export const InteractiveCopyCell = 'deepnote.interactive.copyCell';
    export const InteractiveExportAsNotebook = 'deepnote.interactive.exportasnotebook';
    export const InteractiveExportAs = 'deepnote.interactive.exportas';
    export const RunByLine = 'deepnote.runByLine';
    export const RunAndDebugCell = 'deepnote.runAndDebugCell';
    export const RunByLineNext = 'deepnote.runByLineNext';
    export const RunByLineStop = 'deepnote.runByLineStop';
    export const InstallPythonExtensionViaKernelPicker = 'deepnote.installPythonExtensionViaKernelPicker';
    export const InstallPythonViaKernelPicker = 'deepnote.installPythonViaKernelPicker';
    export const ContinueEditSessionInCodespace = 'deepnote.continueEditSessionInCodespace';
}

export namespace CodeLensCommands {
    // If not specified in the options this is the default set of commands in our design time code lenses
    export const DefaultDesignLenses = [Commands.RunCurrentCell, Commands.RunAllCellsAbove, Commands.DebugCell];
    // If not specified in the options this is the default set of commands in our debug time code lenses
    export const DefaultDebuggingLenses = [Commands.DebugContinue, Commands.DebugStop, Commands.DebugStepOver];
    // These are the commands that are allowed at debug time
    export const DebuggerCommands = [Commands.DebugContinue, Commands.DebugStop, Commands.DebugStepOver];
}

export namespace EditorContexts {
    export const HasCodeCells = 'deepnote.hascodecells';
    export const IsInteractiveActive = 'deepnote.isinteractiveactive';
    export const OwnsSelection = 'deepnote.ownsSelection';
    export const HaveNativeCells = 'deepnote.havenativecells';
    export const HaveNative = 'deepnote.havenative';
    export const IsNativeActive = 'deepnote.isnativeactive';
    export const IsInteractiveOrNativeActive = 'deepnote.isinteractiveornativeactive';
    export const IsPythonOrNativeActive = 'deepnote.ispythonornativeactive';
    export const IsPythonOrInteractiveActive = 'deepnote.ispythonorinteractiveactive';
    export const IsPythonOrInteractiveOrNativeActive = 'deepnote.ispythonorinteractiveornativeeactive';
    export const CanRestartNotebookKernel = 'deepnote.notebookeditor.canrestartNotebookkernel';
    export const CanInterruptNotebookKernel = 'deepnote.notebookeditor.canInterruptNotebookKernel';
    export const CanRestartInteractiveWindowKernel = 'deepnote.interactive.canRestartNotebookKernel';
    export const CanInterruptInteractiveWindowKernel = 'deepnote.interactive.canInterruptNotebookKernel';
    export const RunByLineCells = 'deepnote.notebookeditor.runByLineCells';
    export const RunByLineDocuments = 'deepnote.notebookeditor.runByLineDocuments';
    export const DebugDocuments = 'deepnote.notebookeditor.debugDocuments';
    export const IsPythonNotebook = 'deepnote.ispythonnotebook';
    export const IsJupyterKernelSelected = 'deepnote.kernel.isjupyter';
    export const IsDataViewerActive = 'deepnote.dataViewerActive';
    export const HasNativeNotebookOrInteractiveWindowOpen = 'deepnote.hasNativeNotebookOrInteractiveWindowOpen';
    export const ZmqAvailable = 'deepnote.zmqavailable';
    export const ReplayLogLoaded = 'deepnote.replayLogLoaded';
    export const KernelSource = 'deepnote.kernelSource';
}

export namespace RegExpValues {
    export const PythonCellMarker = /^(#\s*%%|#\s*\<codecell\>|#\s*In\[\d*?\]|#\s*In\[ \])/;
    export const PythonMarkdownCellMarker = /^(#\s*%%\s*\[markdown\]|#\s*\<markdowncell\>)/;
    export const UrlPatternRegEx =
        '(?<PREFIX>https?:\\/\\/)((\\(.+\\s+or\\s+(?<IP>.+)\\))|(?<LOCAL>[^\\s]+))(?<REST>:.+)';
    export const HttpPattern = /https?:\/\//;
    export const ShapeSplitterRegEx = /.*,\s*(\d+).*/;
    export const SvgHeightRegex = /(\<svg.*height=\")(.*?)\"/;
    export const SvgWidthRegex = /(\<svg.*width=\")(.*?)\"/;
    export const SvgSizeTagRegex = /\<svg.*tag=\"sizeTag=\{(.*),\s*(.*)\}\"/;
}

export enum Telemetry {
    ImportNotebook = 'DATASCIENCE.IMPORT_NOTEBOOK',
    RunCurrentCell = 'DATASCIENCE.RUN_CURRENT_CELL',
    RunCurrentCellAndAdvance = 'DATASCIENCE.RUN_CURRENT_CELL_AND_ADVANCE',
    RunAllCells = 'DATASCIENCE.RUN_ALL_CELLS',
    RunAllCellsAbove = 'DATASCIENCE.RUN_ALL_CELLS_ABOVE',
    RunCellAndAllBelow = 'DATASCIENCE.RUN_CELL_AND_ALL_BELOW',
    RunCurrentCellAndAddBelow = 'DATASCIENCE.RUN_CURRENT_CELL_AND_ADD_BELOW',
    InsertCellBelowPosition = 'DATASCIENCE.RUN_INSERT_CELL_BELOW_POSITION',
    InsertCellBelow = 'DATASCIENCE.RUN_INSERT_CELL_BELOW',
    InsertCellAbove = 'DATASCIENCE.RUN_INSERT_CELL_ABOVE',
    DeleteCells = 'DATASCIENCE.RUN_DELETE_CELLS',
    SelectCell = 'DATASCIENCE.RUN_SELECT_CELL',
    SelectCellContents = 'DATASCIENCE.RUN_SELECT_CELL_CONTENTS',
    ExtendSelectionByCellAbove = 'DATASCIENCE.RUN_EXTEND_SELECTION_BY_CELL_ABOVE',
    ExtendSelectionByCellBelow = 'DATASCIENCE.RUN_EXTEND_SELECTION_BY_CELL_BELOW',
    MoveCellsUp = 'DATASCIENCE.RUN_MOVE_CELLS_UP',
    MoveCellsDown = 'DATASCIENCE.RUN_MOVE_CELLS_DOWN',
    ChangeCellToMarkdown = 'DATASCIENCE.RUN_CHANGE_CELL_TO_MARKDOWN',
    ChangeCellToCode = 'DATASCIENCE.RUN_CHANGE_CELL_TO_CODE',
    GotoNextCellInFile = 'DATASCIENCE.GOTO_NEXT_CELL_IN_FILE',
    GotoPrevCellInFile = 'DATASCIENCE.GOTO_PREV_CELL_IN_FILE',
    RunSelectionOrLine = 'DATASCIENCE.RUN_SELECTION_OR_LINE',
    RunToLine = 'DATASCIENCE.RUN_TO_LINE',
    RunFromLine = 'DATASCIENCE.RUN_FROM_LINE',
    /**
     * Exporting from the interactive window
     */
    ExportPythonFileInteractive = 'DATASCIENCE.EXPORT_PYTHON_FILE',
    ExportPythonFileAndOutputInteractive = 'DATASCIENCE.EXPORT_PYTHON_FILE_AND_OUTPUT',
    /**
     * User clicked export as quick pick button
     */
    ClickedExportNotebookAsQuickPick = 'DATASCIENCE.CLICKED_EXPORT_NOTEBOOK_AS_QUICK_PICK',
    /**
     * exported a notebook
     */
    ExportNotebookAs = 'DATASCIENCE.EXPORT_NOTEBOOK_AS',
    /**
     * User invokes export as format from command pallet
     */
    ExportNotebookAsCommand = 'DATASCIENCE.EXPORT_NOTEBOOK_AS_COMMAND',
    /**
     * An export to a specific format failed
     */
    ExportNotebookAsFailed = 'DATASCIENCE.EXPORT_NOTEBOOK_AS_FAILED',
    ZMQSupport = 'DS_INTERNAL.JUPYTER_ZMQ_SUPPORT',
    ZMQSupportFailure = 'DS_INTERNAL.JUPYTER_ZMQ_SUPPORT_FAILURE',
    SelfCertsMessageEnabled = 'DATASCIENCE.SELFCERTSMESSAGEENABLED',
    SelfCertsMessageClose = 'DATASCIENCE.SELFCERTSMESSAGECLOSE',
    ShiftEnterBannerShown = 'DS_INTERNAL.SHIFTENTER_BANNER_SHOWN',
    EnableInteractiveShiftEnter = 'DATASCIENCE.ENABLE_INTERACTIVE_SHIFT_ENTER',
    DisableInteractiveShiftEnter = 'DATASCIENCE.DISABLE_INTERACTIVE_SHIFT_ENTER',
    StartShowDataViewer = 'DATASCIENCE.START_SHOW_DATA_EXPLORER', // Called by the factory when attempting to load the data viewer
    ShowDataViewer = 'DATASCIENCE.SHOW_DATA_EXPLORER', // Called by the data viewer itself when it is actually loaded
    ShowDataViewerRowsLoaded = 'DATASCIENCE.SHOW_DATA_EXPLORER_ROWS_LOADED',
    FailedShowDataViewer = 'DATASCIENCE.FAILED_SHOW_DATA_EXPLORER', // Called by the factory when the data viewer fails to load
    RefreshDataViewer = 'DATASCIENCE.REFRESH_DATA_VIEWER',
    RunFileInteractive = 'DATASCIENCE.RUN_FILE_INTERACTIVE',
    DebugFileInteractive = 'DATASCIENCE.DEBUG_FILE_INTERACTIVE',
    PandasNotInstalled = 'DS_INTERNAL.SHOW_DATA_NO_PANDAS',
    PandasTooOld = 'DS_INTERNAL.SHOW_DATA_PANDAS_TOO_OLD',
    PandasOK = 'DS_INTERNAL.SHOW_DATA_PANDAS_OK',
    PandasInstallCanceled = 'DS_INTERNAL.SHOW_DATA_PANDAS_INSTALL_CANCELED',
    VariableExplorerVariableCount = 'DS_INTERNAL.VARIABLE_EXPLORER_VARIABLE_COUNT',
    AddCellBelow = 'DATASCIENCE.ADD_CELL_BELOW',
    GetPasswordFailure = 'DS_INTERNAL.GET_PASSWORD_FAILURE',
    GetPasswordSuccess = 'DS_INTERNAL.GET_PASSWORD_SUCCESS',
    CheckPasswordJupyterHub = 'DS_INTERNAL.JUPYTER_HUB_PASSWORD',
    OpenPlotViewer = 'DATASCIENCE.OPEN_PLOT_VIEWER',
    DebugCurrentCell = 'DATASCIENCE.DEBUG_CURRENT_CELL',
    CodeLensAverageAcquisitionTime = 'DS_INTERNAL.CODE_LENS_ACQ_TIME',
    DocumentWithCodeCells = 'DS_INTERNAL.DOCUMENT_WITH_CODE_CELLS',
    PerceivedJupyterStartupNotebook = 'DS_INTERNAL.PERCEIVED_JUPYTER_STARTUP_NOTEBOOK',
    GetActivatedEnvironmentVariables = 'DS_INTERNAL.GET_ACTIVATED_ENV_VARIABLES',
    VariableExplorerFetchTime = 'DS_INTERNAL.VARIABLE_EXPLORER_FETCH_TIME',
    KernelSpec = 'DS_INTERNAL.JUPYTER_KERNEL_SPEC',
    CellOutputMimeType = 'DS_INTERNAL.CELL_OUTPUT_MIME_TYPE',
    JupyterApiUsage = 'DATASCIENCE.JUPYTER_API_USAGE',
    KernelCodeCompletion = 'DATASCIENCE.JUPYTER_KERNEL_CODE_COMPLETION',
    KernelCodeCompletionCannotResolve = 'DATASCIENCE.JUPYTER_KERNEL_CODE_COMPLETION_CANNOT_RESOLVE',
    JupyterKernelApiUsage = 'DATASCIENCE.JUPYTER_KERNEL_API_USAGE',
    JupyterUriCanBeParsedAsUri = 'DATASCIENCE.JUPYTER_URI_CAN_BE_PARSED_AS_URI',
    NewJupyterKernelApiUsage = 'DATASCIENCE.JUPYTER_NEW_KERNEL_API_USAGE',
    NewJupyterKernelsApiUsage = 'DATASCIENCE.JUPYTER_NEW_KERNELS_API_USAGE',
    NewJupyterKernelApiExecution = 'DATASCIENCE.JUPYTER_NEW_KERNEL_API_EXEC',
    NewJupyterKernelApiKernelStartupWaitUntil = 'DATASCIENCE.JUPYTER_NEW_KERNEL_API_KERNEL_STARTUP_WAIT_UNTIL',
    JupyterKernelApiAccess = 'DATASCIENCE.JUPYTER_KERNEL_API_ACCESS',
    JupyterKernelStartupHook = 'DATASCIENCE.JUPYTER_KERNEL_STARTUP_HOOK',
    JupyterKernelSpecEnumeration = 'DATASCIENCE.JUPYTER_KERNEL_SPEC_FETCH_FAILURE',
    JupyterKernelHiddenViaFilter = 'DATASCIENCE.JUPYTER_KERNEL_HIDDEN_VIA_FILTER',
    JupyterKernelFilterUsed = 'DATASCIENCE.JUPYTER_KERNEL_FILTER_USED',
    DebugStepOver = 'DATASCIENCE.DEBUG_STEP_OVER',
    DebugContinue = 'DATASCIENCE.DEBUG_CONTINUE',
    DebugStop = 'DATASCIENCE.DEBUG_STOP',
    OpenNotebookAll = 'DATASCIENCE.NATIVE.OPEN_NOTEBOOK_ALL',
    UserInstalledJupyter = 'DATASCIENCE.USER_INSTALLED_JUPYTER',
    UserInstalledPandas = 'DATASCIENCE.USER_INSTALLED_PANDAS',
    UserDidNotInstallJupyter = 'DATASCIENCE.USER_DID_NOT_INSTALL_JUPYTER',
    UserDidNotInstallPandas = 'DATASCIENCE.USER_DID_NOT_INSTALL_PANDAS',
    KernelSpecLanguage = 'DATASCIENCE.KERNEL_SPEC_LANGUAGE',
    KernelLauncherPerf = 'DS_INTERNAL.KERNEL_LAUNCHER_PERF',
    AmbiguousGlobalKernelSpec = 'GLOBAL_PYTHON_KERNELSPEC',
    ActiveInterpreterListingPerf = 'DS_INTERNAL.ACTIVE_INTERPRETER_LISTING_PERF',
    ExperimentLoad = 'DS_INTERNAL.EXPERIMENT_LOAD',
    PythonModuleInstall = 'DS_INTERNAL.PYTHON_MODULE_INSTALL',
    PythonNotInstalled = 'DS_INTERNAL.PYTHON_NOT_INSTALLED',
    PythonExtensionNotInstalled = 'DS_INTERNAL.PYTHON_EXTENSION_NOT_INSTALLED',
    PythonExtensionInstalledViaKernelPicker = 'DS_INTERNAL.PYTHON_EXTENSION_INSTALLED_VIA_KERNEL_PICKER',
    NewFileForInteractiveWindow = 'DS_INTERNAL.NEW_FILE_USED_IN_INTERACTIVE',
    CreateInteractiveWindow = 'DS_INTERNAL.CREATED_INTERACTIVE_WINDOW',
    IPyWidgetLoadSuccess = 'DS_INTERNAL.IPYWIDGET_LOAD_SUCCESS',
    IPyWidgetLoadFailure = 'DS_INTERNAL.IPYWIDGET_LOAD_FAILURE',
    IPyWidgetWidgetVersionNotSupportedLoadFailure = 'DS_INTERNAL.IPYWIDGET_WIDGET_VERSION_NOT_SUPPORTED_LOAD_FAILURE',
    IPyWidgetExtensionJsInfo = 'DS_INTERNAL.IPYWIDGET_EXTENSIONJS_INFO',
    IPyWidgetNbExtensionCopyTime = 'DS_INTERNAL.IPYWIDGET_TIME_TO_COPY_NBEXTENSIONS_DIR',
    HashedIPyWidgetNameUsed = 'DS_INTERNAL.IPYWIDGET_USED_BY_USER',
    VSCNotebookCellTranslationFailed = 'DS_INTERNAL.VSCNOTEBOOK_CELL_TRANSLATION_FAILED',
    HashedIPyWidgetScriptDiscoveryError = 'DS_INTERNAL.IPYWIDGET_DISCOVERY_ERRORED',
    DiscoverIPyWidgetNamesPerf = 'DS_INTERNAL.IPYWIDGET_DISCOVER_WIDGETS_NB_EXTENSIONS',
    IPyWidgetPromptToUseCDN = 'DS_INTERNAL.IPYWIDGET_PROMPT_TO_USE_CDN',
    IPyWidgetPromptToUseCDNSelection = 'DS_INTERNAL.IPYWIDGET_PROMPT_TO_USE_CDN_SELECTION',
    IPyWidgetRenderFailure = 'DS_INTERNAL.IPYWIDGET_RENDER_FAILURE',
    IPyWidgetUnhandledMessage = 'DS_INTERNAL.IPYWIDGET_UNHANDLED_MESSAGE',
    RawKernelInfoResponse = 'DS_INTERNAL.RAWKERNEL_INFO_RESPONSE',
    RawKernelSessionStartNoIpykernel = 'DS_INTERNAL.RAWKERNEL_SESSION_NO_IPYKERNEL',
    RawKernelProcessLaunch = 'DS_INTERNAL.RAWKERNEL_PROCESS_LAUNCH',
    RawKernelSessionShutdown = 'DS_INTERNAL.RAWKERNEL_SESSION_SHUTDOWN',
    RawKernelSessionKernelProcessExited = 'DS_INTERNAL.RAWKERNEL_SESSION_KERNEL_PROCESS_EXITED',
    RawKernelSessionDisposed = 'DS_INTERNAL.RAWKERNEL_SESSION_DISPOSED',
    RunByLineVariableHover = 'DATASCIENCE.RUN_BY_LINE_VARIABLE_HOVER',
    InteractiveFileTooltipsPerf = 'DS_INTERNAL.INTERACTIVE_FILE_TOOLTIPS_PERF',
    NativeVariableViewLoaded = 'DS_INTERNAL.NATIVE_VARIABLE_VIEW_LOADED',
    NativeVariableViewMadeVisible = 'DS_INTERNAL.NATIVE_VARIABLE_VIEW_MADE_VISIBLE',
    NotebookStart = 'DATASCIENCE.NOTEBOOK_START',
    NotebookFirstStartBreakDown = 'DATASCIENCE.NOTEBOOK_FIRST_START_BREAKDOWN',
    NotebookFirstKernelAutoSelectionBreakDown = 'DATASCIENCE.NOTEBOOK_FIRST_KERNEL_AUTO_SELECTION_BREAKDOWN',
    NotebookInterrupt = 'DATASCIENCE.NOTEBOOK_INTERRUPT',
    NotebookRestart = 'DATASCIENCE.NOTEBOOK_RESTART',
    SwitchKernel = 'DS_INTERNAL.SWITCH_KERNEL',
    KernelCount = 'DS_INTERNAL.KERNEL_COUNT',
    ExecuteCell = 'DATASCIENCE.EXECUTE_CELL',
    ExecuteCode = 'DATASCIENCE.EXECUTE_CODE',
    ResumeCellExecution = 'DATASCIENCE.RESUME_EXECUTE_CELL',
    /**
     * Sent when a command we register is executed.
     */
    CommandExecuted = 'DS_INTERNAL.COMMAND_EXECUTED',
    /**
     * Telemetry event sent whenever the user toggles the checkbox
     * controlling whether a slice is currently being applied to an
     * n-dimensional variable.
     */
    DataViewerSliceEnablementStateChanged = 'DATASCIENCE.DATA_VIEWER_SLICE_ENABLEMENT_STATE_CHANGED',
    /**
     * Telemetry event sent when a slice is first applied in a
     * data viewer instance to a sliceable Python variable.
     */
    DataViewerDataDimensionality = 'DATASCIENCE.DATA_VIEWER_DATA_DIMENSIONALITY',
    /**
     * Telemetry event sent whenever the user applies a valid slice
     * to a sliceable Python variable in the data viewer.
     */
    DataViewerSliceOperation = 'DATASCIENCE.DATA_VIEWER_SLICE_OPERATION',
    RecommendExtension = 'DATASCIENCE.RECOMMENT_EXTENSION',
    CreatePythonEnvironment = 'DATASCIENCE.CREATE_PYTHON_ENVIRONMENT',
    // Sent when we get a jupyter execute_request error reply when running some part of our internal variable fetching code
    PythonVariableFetchingCodeFailure = 'DATASCIENCE.PYTHON_VARIABLE_FETCHING_CODE_FAILURE',
    // Sent when we get a jupyter execute_request error reply when running some part of interactive window debug setup code
    InteractiveWindowDebugSetupCodeFailure = 'DATASCIENCE.INTERACTIVE_WINDOW_DEBUG_SETUP_CODE_FAILURE',
    KernelCrash = 'DATASCIENCE.KERNEL_CRASH',
    RunTest = 'DS_INTERNAL.RUNTEST',
    PreferredKernelExactMatch = 'DS_INTERNAL.PREFERRED_KERNEL_EXACT_MATCH',
    NoActiveKernelSession = 'DATASCIENCE.NO_ACTIVE_KERNEL_SESSION',
    DataViewerUsingInterpreter = 'DATAVIEWER.USING_INTERPRETER',
    DataViewerUsingKernel = 'DATAVIEWER.USING_KERNEL',
    DataViewerWebviewLoaded = 'DATAVIEWER.WEBVIEW_LOADED',
    PlotViewerWebviewLoaded = 'PLOTVIEWER.WEBVIEW_LOADED',
    EnterRemoteJupyterUrl = 'DATASCIENCE.ENTER_REMOTE_JUPYTER_URL',
    NativeNotebookExecutionPerformance = 'DATASCIENCE.JUPYTER_NOTEBOOK_EXEC_PERFORMANCE',
    JupyterNotebookExecutionPerformance = 'DATASCIENCE.JUPYTER_JUPYTER_NOTEBOOK_EXEC_PERFORMANCE',
    NativeNotebookEditPerformance = 'DATASCIENCE.JUPYTER_NOTEBOOK_EDIT_PERFORMANCE',
    InvokeTool = 'InvokeTool',
    ConfigureNotebookToolCall = 'DATASCIENCE.JUPYTER_CONFIGURE_NOTEBOOK_TOOL_CALL'
}

export enum JupyterCommands {
    NotebookCommand = 'notebook',
    ConvertCommand = 'nbconvert',
    KernelSpecCommand = 'kernelspec'
}

export const DataScienceStartupTime = Symbol('DataScienceStartupTime');

// Default for notebook version (major & minor) used when creating notebooks.
export const defaultNotebookFormat = { major: 4, minor: 2 };

export const WIDGET_MIMETYPE = 'application/vnd.deepnote.widget-view+json';
export const WIDGET_STATE_MIMETYPE = 'application/vnd.deepnote.widget-state+json';
export const WIDGET_VERSION_NON_PYTHON_KERNELS = 8;

/**
 * Used as a fallback when determinining the extension id that calls into the Jupyter extension API fails.
 */
export const unknownExtensionId = 'unknown';
