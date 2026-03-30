import { IAsyncDisposable } from '../common/types';

export const ITelemetryService = Symbol('ITelemetryService');

export interface ITelemetryService extends IAsyncDisposable {
    trackEvent(eventName: string, properties?: Record<string, string | number | boolean>): void;
}
