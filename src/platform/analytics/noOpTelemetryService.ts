import { ITelemetryService, TelemetryEvent } from './types';

/**
 * No-op telemetry service for use in tests.
 */
export class NoOpTelemetryService implements ITelemetryService {
    public async dispose(): Promise<void> {
        // No-op
    }

    public trackEvent(_event: TelemetryEvent): void {
        // No-op
    }
}
