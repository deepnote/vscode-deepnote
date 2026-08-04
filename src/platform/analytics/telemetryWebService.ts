import { injectable } from 'inversify';

import { ITelemetryService, TelemetryEvent } from './types';

@injectable()
export class TelemetryWebService implements ITelemetryService {
    public async dispose(): Promise<void> {
        // No-op for web
    }

    public trackEvent(_event: TelemetryEvent): void {
        // No-op for web
    }
}
