export const IPostHogAnalyticsService = Symbol('IPostHogAnalyticsService');

export interface IPostHogAnalyticsService {
    trackEvent(eventName: string, properties?: Record<string, string | number | boolean>): void;
    shutdown(): Promise<void>;
}
