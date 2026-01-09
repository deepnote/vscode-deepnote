import { l10n } from 'vscode';

import { BaseError } from './types';

/**
 * Error thrown when a project name is invalid for slug generation.
 * This occurs when the project name is empty or contains only special characters
 * that are removed during slugification.
 *
 * Cause:
 * The project name provided cannot be converted to a valid slug for use in filenames.
 *
 * Handled by:
 * The error should be caught and logged. The snapshot operation should be skipped
 * if the project name cannot be slugified.
 */
export class InvalidProjectNameError extends BaseError {
    constructor() {
        super('unknown', l10n.t('Project name cannot be empty or contain only special characters'));
        this.name = 'InvalidProjectNameError';
    }
}
