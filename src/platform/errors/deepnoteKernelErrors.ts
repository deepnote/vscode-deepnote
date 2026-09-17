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
