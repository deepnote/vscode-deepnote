/**
 * Error thrown when a project name is invalid for slug generation.
 * This occurs when the project name is empty or contains only special characters
 * that are removed during slugification.
 */
export class InvalidProjectNameError extends Error {
    constructor(message: string = 'Project name cannot be empty or contain only special characters') {
        super(message);
        this.name = 'InvalidProjectNameError';
    }
}
