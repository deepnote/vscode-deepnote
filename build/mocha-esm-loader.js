// ESM loader for Mocha tests
// This provides custom module resolution for mocked modules

import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

// Import test setup will happen after the loader is registered
let unittestsModule;

// Get absolute paths for imports in the loader
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const vscodeMockPath = pathToFileURL(path.join(projectRoot, 'out/test/vscode-mock.js')).href;
const telemetryMockPath = pathToFileURL(path.join(projectRoot, 'out/test/mocks/vsc/telemetryReporter.js')).href;

import { stat } from 'node:fs/promises';

export async function resolve(specifier, context, nextResolve) {
    // Intercept vscode module and point to our mock
    if (specifier === 'vscode') {
        // Return a special URL that we'll handle in load()
        return {
            url: 'vscode-mock:///vscode',
            shortCircuit: true
        };
    }

    // Intercept @vscode/extension-telemetry
    if (specifier === '@vscode/extension-telemetry') {
        return {
            url: 'vscode-mock:///telemetry',
            shortCircuit: true
        };
    }

    // Intercept @deepnote/convert
    if (specifier === '@deepnote/convert') {
        return {
            url: 'vscode-mock:///deepnote-convert',
            shortCircuit: true
        };
    }

    // Handle extensionless imports (both relative and node_modules)
    // Try the original specifier first
    try {
        const result = await nextResolve(specifier, context);
        return result;
    } catch (err) {
        // Check if specifier already has a .js extension
        const hasJsExtension = specifier.endsWith('.js');

        if (!hasJsExtension) {
            // Try adding .js (handles both extensionless and compound extensions like .node)
            try {
                const withJs = specifier + '.js';
                const result = await nextResolve(withJs, context);
                return result;
            } catch (jsErr) {
                // If .js doesn't work and it doesn't have any extension, try /index.js
                if (!path.extname(specifier)) {
                    try {
                        const withIndex = specifier + '/index.js';
                        return await nextResolve(withIndex, context);
                    } catch (indexErr) {
                        // Re-throw original error
                        throw err;
                    }
                }
                // Re-throw original error if it had a partial extension
                throw err;
            }
        }
        throw err;
    }
}

export async function load(url, context, nextLoad) {
    // Handle all vscode-mock URLs
    if (url.startsWith('vscode-mock:///')) {
        // Extract the module name from the URL
        const moduleName = url.replace('vscode-mock:///', '');

        if (moduleName === 'vscode') {
            // Lazy load the unittests module to get access to mockedVSCode
            if (!unittestsModule) {
                unittestsModule = await import(vscodeMockPath);
            }

            // Return the mocked vscode module with dynamic exports
            return {
                format: 'module',
                source: `
                import { mockedVSCode } from '${vscodeMockPath}';

                // Export default
                export default mockedVSCode;

                // Use a Proxy to export all properties dynamically
                // This ensures any property accessed from mockedVSCode is exported
                const handler = {
                    get(target, prop) {
                        // Return the property from mockedVSCode, or undefined if not found
                        return target[prop];
                    }
                };

                // Create proxy for dynamic exports
                const vsProxy = new Proxy(mockedVSCode, handler);

                // Export all known properties from mockedVSCode
                // Using Object.keys to get all current properties
                ${(() => {
                    // This will be evaluated when the module is loaded
                    return '';
                })()}

                // Export all vscode API exports used in the codebase
                // Use Proxy to create pass-through objects that dynamically resolve to vsProxy properties
                const createPassThrough = (prop) => new Proxy({}, {
                    get: (target, key) => {
                        const value = vsProxy[prop][key];
                        return typeof value === 'function' ? value.bind(vsProxy[prop]) : value;
                    },
                    set: (target, key, value) => {
                        vsProxy[prop][key] = value;
                        return true;
                    },
                    has: (target, key) => key in vsProxy[prop],
                    ownKeys: (target) => Reflect.ownKeys(vsProxy[prop]),
                    getOwnPropertyDescriptor: (target, key) => Reflect.getOwnPropertyDescriptor(vsProxy[prop], key)
                });

                const createClassProxy = (prop) => {
                    // Create a proxy that properly supports class extension
                    const proxyFn = new Proxy(function() {}, {
                        get: (target, key) => {
                            // Special handling for prototype to support class extension
                            if (key === 'prototype') {
                                return vsProxy[prop]?.prototype;
                            }
                            return vsProxy[prop]?.[key];
                        },
                        set: (target, key, value) => {
                            if (key === 'prototype' && vsProxy[prop]) {
                                vsProxy[prop].prototype = value;
                                return true;
                            }
                            if (vsProxy[prop]) {
                                vsProxy[prop][key] = value;
                            }
                            return true;
                        },
                        construct: (target, args) => new vsProxy[prop](...args),
                        apply: (target, thisArg, args) => vsProxy[prop].apply(thisArg, args)
                    });
                    // Set the prototype property to enable proper inheritance
                    if (vsProxy[prop]) {
                        Object.setPrototypeOf(proxyFn, vsProxy[prop]);
                    }
                    return proxyFn;
                };

                export const l10n = createPassThrough('l10n');
                export const MarkdownString = createClassProxy('MarkdownString');
                export const MarkedString = createClassProxy('MarkedString');
                export const Hover = createClassProxy('Hover');
                export const Disposable = createClassProxy('Disposable');
                export const ExtensionKind = createClassProxy('ExtensionKind');
                export const ExtensionMode = createClassProxy('ExtensionMode');
                export const ExtensionContext = createClassProxy('ExtensionContext');
                export const Extension = createClassProxy('Extension');
                export const CodeAction = createClassProxy('CodeAction');
                export const CodeActionKind = createClassProxy('CodeActionKind');
                export const CodeLens = createClassProxy('CodeLens');
                export const CodeLensProvider = createClassProxy('CodeLensProvider');
                export const Command = createClassProxy('Command');
                export const Event = createClassProxy('Event');
                export const EventEmitter = createClassProxy('EventEmitter');
                export const CancellationError = createClassProxy('CancellationError');
                export const CancellationToken = createClassProxy('CancellationToken');
                export const CancellationTokenSource = createClassProxy('CancellationTokenSource');
                export const CompletionItem = createClassProxy('CompletionItem');
                export const CompletionItemKind = createClassProxy('CompletionItemKind');
                export const CompletionItemProvider = createClassProxy('CompletionItemProvider');
                export const CompletionList = createClassProxy('CompletionList');
                export const CompletionTriggerKind = createClassProxy('CompletionTriggerKind');
                export const ConfigurationChangeEvent = createClassProxy('ConfigurationChangeEvent');
                export const ConfigurationTarget = createClassProxy('ConfigurationTarget');
                export const Diagnostic = createClassProxy('Diagnostic');
                export const DiagnosticSeverity = createClassProxy('DiagnosticSeverity');
                export const SymbolKind = createClassProxy('SymbolKind');
                export const SymbolInformation = createClassProxy('SymbolInformation');
                export const CallHierarchyItem = createClassProxy('CallHierarchyItem');
                export const IndentAction = createClassProxy('IndentAction');
                export const InputBox = createClassProxy('InputBox');
                export const LanguageConfiguration = createClassProxy('LanguageConfiguration');
                export const Memento = createClassProxy('Memento');
                export const OutputChannel = createClassProxy('OutputChannel');
                export const Progress = createClassProxy('Progress');
                export const ProgressLocation = createClassProxy('ProgressLocation');
                export const ProgressOptions = createClassProxy('ProgressOptions');
                export const ProviderResult = createClassProxy('ProviderResult');
                export const QuickInputButton = createClassProxy('QuickInputButton');
                export const QuickInputButtons = createClassProxy('QuickInputButtons');
                export const QuickPick = createClassProxy('QuickPick');
                export const QuickPickItem = createClassProxy('QuickPickItem');
                export const QuickPickItemKind = createClassProxy('QuickPickItemKind');
                export const QuickPickItemButtonEvent = createClassProxy('QuickPickItemButtonEvent');
                export const SaveDialogOptions = createClassProxy('SaveDialogOptions');
                export const SecretStorage = createClassProxy('SecretStorage');
                export const SecretStorageChangeEvent = createClassProxy('SecretStorageChangeEvent');
                export const SnippetString = createClassProxy('SnippetString');
                export const SnippetTextEdit = createClassProxy('SnippetTextEdit');
                export const StatusBarAlignment = createClassProxy('StatusBarAlignment');
                export const SignatureHelp = createClassProxy('SignatureHelp');
                export const TextDocument = createClassProxy('TextDocument');
                export const TextEditor = createClassProxy('TextEditor');
                export const TextEdit = createClassProxy('TextEdit');
                export const DocumentLink = createClassProxy('DocumentLink');
                export const Uri = createClassProxy('Uri');
                export const Range = createClassProxy('Range');
                export const Position = createClassProxy('Position');
                export const Selection = createClassProxy('Selection');
                export const Location = createClassProxy('Location');
                export const RelativePattern = createClassProxy('RelativePattern');
                export const ViewColumn = createClassProxy('ViewColumn');
                export const TextEditorRevealType = createClassProxy('TextEditorRevealType');
                export const TreeDataProvider = createClassProxy('TreeDataProvider');
                export const TreeItem = createClassProxy('TreeItem');
                export const TreeItemCollapsibleState = createClassProxy('TreeItemCollapsibleState');
                export const Variable = createClassProxy('Variable');
                export const VariablesResult = createClassProxy('VariablesResult');
                export const WebviewOptions = createClassProxy('WebviewOptions');
                export const WebviewPanel = createClassProxy('WebviewPanel');
                export const WebviewView = createClassProxy('WebviewView');
                export const WebviewViewProvider = createClassProxy('WebviewViewProvider');
                export const WebviewViewResolveContext = createClassProxy('WebviewViewResolveContext');
                export const WorkspaceConfiguration = createClassProxy('WorkspaceConfiguration');
                export const WorkspaceEdit = createClassProxy('WorkspaceEdit');
                export const WorkspaceFolder = createClassProxy('WorkspaceFolder');
                export const WorkspaceFoldersChangeEvent = createClassProxy('WorkspaceFoldersChangeEvent');
                export const workspace = createPassThrough('workspace');
                export const window = createPassThrough('window');
                export const languages = createPassThrough('languages');
                export const env = createPassThrough('env');
                export const debug = createPassThrough('debug');
                export const DebugAdapterTracker = createClassProxy('DebugAdapterTracker');
                export const DebugAdapterTrackerFactory = createClassProxy('DebugAdapterTrackerFactory');
                export const DebugAdapterExecutable = createClassProxy('DebugAdapterExecutable');
                export const DebugAdapterServer = createClassProxy('DebugAdapterServer');
                export const DebugConfiguration = createClassProxy('DebugConfiguration');
                export const DebugSession = createClassProxy('DebugSession');
                export const scm = createPassThrough('scm');
                export const notebooks = createPassThrough('notebooks');
                export const commands = createPassThrough('commands');
                export const extensions = createPassThrough('extensions');
                export const LogLevel = createClassProxy('LogLevel');
                export const FileStat = createClassProxy('FileStat');
                export const FileSystemWatcher = createClassProxy('FileSystemWatcher');
                export const FileType = createClassProxy('FileType');
                export const FileSystemError = createClassProxy('FileSystemError');
                export const FileDecoration = createClassProxy('FileDecoration');
                export const NotebookCell = createClassProxy('NotebookCell');
                export const NotebookData = createClassProxy('NotebookData');
                export const NotebookCellData = createClassProxy('NotebookCellData');
                export const NotebookCellExecution = createClassProxy('NotebookCellExecution');
                export const NotebookCellKind = createClassProxy('NotebookCellKind');
                export const NotebookCellOutput = createClassProxy('NotebookCellOutput');
                export const NotebookCellOutputItem = createClassProxy('NotebookCellOutputItem');
                export const NotebookCellRunState = createClassProxy('NotebookCellRunState');
                export const NotebookCellExecutionState = createClassProxy('NotebookCellExecutionState');
                export const NotebookController = createClassProxy('NotebookController');
                export const NotebookControllerAffinity = createClassProxy('NotebookControllerAffinity');
                export const NotebookControllerDetectionTask = createClassProxy('NotebookControllerDetectionTask');
                export const NotebookDocument = createClassProxy('NotebookDocument');
                export const NotebookDocumentChangeEvent = createClassProxy('NotebookDocumentChangeEvent');
                export const NotebookEditor = createClassProxy('NotebookEditor');
                export const NotebookEditorRevealType = createClassProxy('NotebookEditorRevealType');
                export const NotebookEdit = createClassProxy('NotebookEdit');
                export const NotebookExecution = createClassProxy('NotebookExecution');
                export const NotebookRange = createClassProxy('NotebookRange');
                export const NotebookRendererMessaging = createClassProxy('NotebookRendererMessaging');
                export const NotebookRendererScript = createClassProxy('NotebookRendererScript');
                export const NotebookVariableProvider = createClassProxy('NotebookVariableProvider');
                export const ColorThemeKind = createClassProxy('ColorThemeKind');
                export const UIKind = createClassProxy('UIKind');
                export const ThemeIcon = createClassProxy('ThemeIcon');
                export const ThemeColor = createClassProxy('ThemeColor');
                export const EndOfLine = createClassProxy('EndOfLine');
                export const PortAutoForwardAction = createClassProxy('PortAutoForwardAction');
                export const PortAttributes = createClassProxy('PortAttributes');
            `,
                shortCircuit: true
            };
        }

        // Handle telemetry mock
        if (moduleName === 'telemetry') {
            return {
                format: 'module',
                source: `
                    import { vscMockTelemetryReporter } from '${telemetryMockPath}';
                    export default vscMockTelemetryReporter;
                `,
                shortCircuit: true
            };
        }

        // Handle deepnote convert mock
        if (moduleName === 'deepnote-convert') {
            return {
                format: 'module',
                source: `
                    export const convertIpynbFilesToDeepnoteFile = async () => {
                        // Mock implementation - does nothing in tests
                    };
                `,
                shortCircuit: true
            };
        }

        // Unknown vscode-mock module
        throw new Error(`Unknown vscode-mock module: ${moduleName}`);
    }

    // Let Node.js handle all other URLs
    return nextLoad(url, context);
}
