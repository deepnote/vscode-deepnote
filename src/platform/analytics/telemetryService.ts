import { inject, injectable } from 'inversify';
import { PostHog } from 'posthog-node';
import { workspace } from 'vscode';

import { IAsyncDisposableRegistry, IPersistentState, IPersistentStateFactory } from '../common/types';
import { generateUuid } from '../common/uuid';
import { logger } from '../logging';
import { POSTHOG_API_KEY, POSTHOG_HOST } from './constants';
import { ITelemetryService } from './types';

const USER_ID_STORAGE_KEY = 'posthog-anonymous-user-id';

@injectable()
export class TelemetryService implements ITelemetryService {
    private client: PostHog | undefined;

    private initialized = false;

    private userIdState: IPersistentState<string> | undefined;

    constructor(
        @inject(IPersistentStateFactory) private readonly stateFactory: IPersistentStateFactory,
        @inject(IAsyncDisposableRegistry) asyncDisposables: IAsyncDisposableRegistry
    ) {
        asyncDisposables.push(this);
    }

    public trackEvent(eventName: string, properties?: Record<string, string | number | boolean>): void {
        try {
            if (!this.isTelemetryEnabled()) {
                return;
            }

            if (!this.initialized) {
                this.initialize();
            }

            if (!this.client || !this.userIdState) {
                return;
            }

            this.client.capture({
                distinctId: this.userIdState.value,
                event: eventName,
                properties
            });
        } catch (ex) {
            logger.debug(`PostHog analytics error: ${ex}`);
        }
    }

    public async dispose(): Promise<void> {
        try {
            await this.client?.shutdown();
        } catch (ex) {
            logger.debug(`PostHog shutdown error: ${ex}`);
        }
    }

    private initialize(): void {
        this.initialized = true;

        this.userIdState = this.stateFactory.createGlobalPersistentState<string>(USER_ID_STORAGE_KEY, '');

        if (!this.userIdState.value) {
            void this.userIdState.updateValue(generateUuid());
        }

        this.client = new PostHog(POSTHOG_API_KEY, {
            flushAt: 20,
            flushInterval: 30000,
            host: POSTHOG_HOST
        });
    }

    private isTelemetryEnabled(): boolean {
        const telemetryLevel = workspace.getConfiguration('telemetry').get<string>('telemetryLevel', 'all');

        if (telemetryLevel === 'off') {
            return false;
        }

        return workspace.getConfiguration('deepnote').get<boolean>('telemetry.enabled', true);
    }
}
