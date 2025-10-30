// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Base class for Deepnote kernel-related errors with troubleshooting guidance
 */
export abstract class DeepnoteKernelError extends Error {
    /**
     * User-friendly error message
     */
    public abstract readonly userMessage: string;

    /**
     * Detailed technical information about the error
     */
    public abstract readonly technicalDetails: string;

    /**
     * Actionable troubleshooting steps for the user
     */
    public abstract readonly troubleshootingSteps: string[];

    /**
     * Get a formatted error report for copying/sharing
     */
    public getErrorReport(): string {
        const lines = [
            '=== Deepnote Kernel Error Report ===',
            '',
            'Error Type: ' + this.constructor.name,
            'Message: ' + this.userMessage,
            '',
            'Technical Details:',
            this.technicalDetails,
            '',
            'Troubleshooting Steps:'
        ];

        this.troubleshootingSteps.forEach((step, index) => {
            lines.push(`${index + 1}. ${step}`);
        });

        return lines.join('\n');
    }
}

/**
 * Error thrown when virtual environment creation fails
 */
export class DeepnoteVenvCreationError extends DeepnoteKernelError {
    public readonly userMessage: string;
    public readonly technicalDetails: string;
    public readonly troubleshootingSteps: string[];

    constructor(
        public readonly pythonPath: string,
        public readonly venvPath: string,
        public readonly stderr: string,
        cause?: Error
    ) {
        super(`Failed to create virtual environment for Deepnote toolkit`);
        this.name = 'DeepnoteVenvCreationError';

        this.userMessage = 'Failed to create virtual environment for Deepnote toolkit';

        this.technicalDetails = [
            `Python interpreter: ${pythonPath}`,
            `Target venv path: ${venvPath}`,
            stderr ? `Error output:\n${stderr}` : 'No error output available',
            cause ? `Underlying error: ${cause.message}` : ''
        ]
            .filter(Boolean)
            .join('\n');

        this.troubleshootingSteps = [
            'Ensure Python is correctly installed and accessible',
            'Check that the Python interpreter has the "venv" module (try: python -m venv --help)',
            'Verify you have write permissions to the extension storage directory',
            'Check available disk space',
            'Try selecting a different Python interpreter in VS Code',
            'If using a system Python, consider installing a dedicated Python distribution (e.g., from python.org)'
        ];

        // Preserve the original error's stack trace if available
        if (cause && cause.stack) {
            this.stack = cause.stack;
        }
    }
}

/**
 * Error thrown when deepnote-toolkit package installation fails
 */
export class DeepnoteToolkitInstallError extends DeepnoteKernelError {
    public readonly userMessage: string;
    public readonly technicalDetails: string;
    public readonly troubleshootingSteps: string[];

    constructor(
        public readonly pythonPath: string,
        public readonly venvPath: string,
        public readonly packageUrl: string,
        public readonly stdout: string,
        public readonly stderr: string,
        cause?: Error
    ) {
        super(`Failed to install deepnote-toolkit package`);
        this.name = 'DeepnoteToolkitInstallError';

        this.userMessage = 'Failed to install deepnote-toolkit package';

        this.technicalDetails = [
            `Python interpreter: ${pythonPath}`,
            `Virtual environment: ${venvPath}`,
            `Package URL: ${packageUrl}`,
            stdout ? `Installation output:\n${stdout}` : '',
            stderr ? `Error output:\n${stderr}` : 'No error output available',
            cause ? `Underlying error: ${cause.message}` : ''
        ]
            .filter(Boolean)
            .join('\n');

        // Detect common error patterns and provide specific guidance
        const hasNetworkError =
            stderr.toLowerCase().includes('could not find a version') ||
            stderr.toLowerCase().includes('connection') ||
            stderr.toLowerCase().includes('timeout') ||
            stderr.toLowerCase().includes('ssl') ||
            stderr.toLowerCase().includes('certificate');

        const hasPermissionError =
            stderr.toLowerCase().includes('permission denied') || stderr.toLowerCase().includes('access is denied');

        const hasDependencyError =
            stderr.toLowerCase().includes('no matching distribution') ||
            stderr.toLowerCase().includes('could not find a version that satisfies');

        this.troubleshootingSteps = [
            ...(hasNetworkError
                ? [
                      'Check your internet connection',
                      'If behind a corporate firewall/proxy, configure pip proxy settings',
                      'Try disabling VPN temporarily'
                  ]
                : []),
            ...(hasPermissionError
                ? [
                      'Check file permissions in the extension storage directory',
                      'Try running VS Code with appropriate permissions'
                  ]
                : []),
            ...(hasDependencyError
                ? [
                      'Verify your Python version is compatible (Python 3.8+ required)',
                      'Try upgrading pip: python -m pip install --upgrade pip'
                  ]
                : []),
            'Ensure pip is working correctly: python -m pip --version',
            'Check that you can access the package URL in a browser',
            'Try manually installing: pip install deepnote-toolkit',
            'Check the Output panel for detailed installation logs',
            'If the issue persists, report it with the error details'
        ];

        if (cause && cause.stack) {
            this.stack = cause.stack;
        }
    }
}

/**
 * Error thrown when the Deepnote server fails to start
 */
export class DeepnoteServerStartupError extends DeepnoteKernelError {
    public readonly userMessage: string;
    public readonly technicalDetails: string;
    public readonly troubleshootingSteps: string[];

    constructor(
        public readonly pythonPath: string,
        public readonly port: number,
        public readonly reason: 'process_failed' | 'health_check_failed' | 'unknown',
        public readonly stdout: string,
        public readonly stderr: string,
        cause?: Error
    ) {
        super(`Deepnote server failed to start`);
        this.name = 'DeepnoteServerStartupError';

        this.userMessage = 'Deepnote server failed to start';

        this.technicalDetails = [
            `Python interpreter: ${pythonPath}`,
            `Port: ${port}`,
            `Failure reason: ${reason}`,
            stdout ? `Server output:\n${stdout}` : '',
            stderr ? `Server errors:\n${stderr}` : 'No error output available',
            cause ? `Underlying error: ${cause.message}` : ''
        ]
            .filter(Boolean)
            .join('\n');

        // Detect common error patterns
        const hasPortConflict =
            stderr.toLowerCase().includes('address already in use') ||
            (stderr.toLowerCase().includes('port') && stderr.toLowerCase().includes('in use'));

        const hasModuleError =
            stderr.toLowerCase().includes('no module named') ||
            stderr.toLowerCase().includes('modulenotfounderror') ||
            stderr.toLowerCase().includes('importerror');

        const hasPermissionError = stderr.toLowerCase().includes('permission denied');

        this.troubleshootingSteps = [
            ...(hasPortConflict
                ? [
                      `Port ${port} is already in use by another application`,
                      'Close other Jupyter servers or applications using that port',
                      'Restart VS Code to clean up orphaned server processes'
                  ]
                : []),
            ...(hasModuleError
                ? [
                      'The deepnote-toolkit package may not be correctly installed',
                      'Try reloading the VS Code window to trigger reinstallation',
                      'Check the Output panel for package installation errors'
                  ]
                : []),
            ...(hasPermissionError
                ? [
                      'Check that the server has permission to bind to the port',
                      'Verify firewall settings are not blocking local connections'
                  ]
                : []),
            'Check the Output panel for detailed server logs',
            'Ensure no antivirus software is blocking Python',
            'Try closing and reopening the notebook file',
            'Reload the VS Code window (Cmd/Ctrl+Shift+P → "Reload Window")',
            'If the issue persists, report it with the error details'
        ];

        if (cause && cause.stack) {
            this.stack = cause.stack;
        }
    }
}

/**
 * Error thrown when the Deepnote server fails to become ready within timeout
 */
export class DeepnoteServerTimeoutError extends DeepnoteKernelError {
    public readonly userMessage: string;
    public readonly technicalDetails: string;
    public readonly troubleshootingSteps: string[];

    constructor(
        public readonly serverUrl: string,
        public readonly timeoutMs: number,
        public readonly lastError?: string
    ) {
        super(`Deepnote server failed to start within ${timeoutMs / 1000} seconds`);
        this.name = 'DeepnoteServerTimeoutError';

        this.userMessage = `Deepnote server failed to start within ${timeoutMs / 1000} seconds`;

        this.technicalDetails = [
            `Server URL: ${serverUrl}`,
            `Timeout: ${timeoutMs}ms`,
            lastError ? `Last connection error: ${lastError}` : 'Server process started but health check failed',
            'The server process may still be starting or may have crashed silently'
        ]
            .filter(Boolean)
            .join('\n');

        this.troubleshootingSteps = [
            'The server may be slow to start - try waiting a bit longer and reloading',
            'Check the Output panel for server startup logs',
            'Ensure no firewall is blocking localhost connections',
            'Check that port is not being blocked by security software',
            'Verify Python and deepnote-toolkit are correctly installed',
            'Try closing other resource-intensive applications',
            'Reload the VS Code window (Cmd/Ctrl+Shift+P → "Reload Window")',
            'If the issue persists, report it with the error details'
        ];
    }
}

/**
 * Error thrown when Python interpreter is not found or invalid
 */
export class DeepnotePythonNotFoundError extends DeepnoteKernelError {
    public readonly userMessage: string;
    public readonly technicalDetails: string;
    public readonly troubleshootingSteps: string[];

    constructor(public readonly attemptedPath?: string) {
        super('Python interpreter not found');
        this.name = 'DeepnotePythonNotFoundError';

        this.userMessage = 'No Python interpreter found for Deepnote kernel';

        this.technicalDetails = attemptedPath
            ? `Attempted to use: ${attemptedPath}`
            : 'No Python interpreter is selected in VS Code';

        this.troubleshootingSteps = [
            'Install Python from python.org (Python 3.8 or later required)',
            'Install the Python extension for VS Code if not already installed',
            'Select a Python interpreter: Cmd/Ctrl+Shift+P → "Python: Select Interpreter"',
            'Ensure the selected Python interpreter is accessible from VS Code',
            'Reload the VS Code window after installing Python',
            'Check the Output panel for more details'
        ];
    }
}
