import { ITelemetryService, TelemetryEvent } from './types';

/**
 * No-op telemetry service for use in tests.
 */
export class NoOpTelemetryService implements ITelemetryService {
    public trackEvent(_event: TelemetryEvent): void {
        // No-op
    }

    public async dispose(): Promise<void> {
        // No-op
    }
}
