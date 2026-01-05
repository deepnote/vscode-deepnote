// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Wrapper for vscode-tas-client to allow stubbing in tests
import { getExperimentationService as originalGetExperimentationService } from 'vscode-tas-client';

// Export a mutable object that can be stubbed in tests
export const tasClientWrapper = {
    getExperimentationService: originalGetExperimentationService
};
