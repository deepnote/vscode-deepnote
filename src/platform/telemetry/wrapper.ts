// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Wrapper for telemetry functions to allow stubbing in tests
import {
    sendTelemetryEvent as originalSendTelemetryEvent,
    setSharedProperty as originalSetSharedProperty
} from './index';

// Export a mutable object that can be stubbed in tests
export const telemetryWrapper = {
    sendTelemetryEvent: originalSendTelemetryEvent,
    setSharedProperty: originalSetSharedProperty
};
