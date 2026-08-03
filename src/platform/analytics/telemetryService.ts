import { inject, injectable } from 'inversify';
import { PostHog } from 'posthog-node';
import { env, workspace } from 'vscode';

import { IExtensionSyncActivationService } from '../activation/types';
import { IApplicationEnvironment } from '../common/application/types';
import {
    IAsyncDisposableRegistry,
    IDisposableRegistry,
    IPersistentState,
    IPersistentStateFactory
} from '../common/types';
import { generateUuid } from '../common/uuid';
import { logger } from '../logging';
import { IS_POSTHOG_CONFIGURED, POSTHOG_API_KEY, POSTHOG_CHANNEL, POSTHOG_HOST } from './constants';
import { ITelemetryService, TelemetryEvent } from './types';

const USER_ID_STORAGE_KEY = 'deepnote-telemetry-anonymous-user-id';
const POSTHOG_FLUSH_AT = 20;
const POSTHOG_FLUSH_INTERVAL = 30000;
const POSTHOG_SHUTDOWN_TIMEOUT = 5000;

@injectable()
export class TelemetryService implements ITelemetryService, IExtensionSyncActivationService {
    private client: PostHog | null;

    // Attached to every event so metrics can be segmented by build channel, extension/VS Code
    // version, platform, and session.
    private readonly commonProperties: Record<string, string | number | boolean>;

    private readonly userId: string;

    private userIdState: IPersistentState<string>;

    constructor(
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry,
        @inject(IPersistentStateFactory) private readonly stateFactory: IPersistentStateFactory,
        @inject(IAsyncDisposableRegistry) asyncDisposables: IAsyncDisposableRegistry,
        @inject(IApplicationEnvironment) appEnvironment: IApplicationEnvironment
    ) {
        asyncDisposables.push(this);
        this.client = null;
        this.userIdState = this.stateFactory.createGlobalPersistentState<string>(USER_ID_STORAGE_KEY, '');
        this.userId = this.userIdState.value || generateUuid();
        this.commonProperties = {
            channel: POSTHOG_CHANNEL,
            extensionVersion: appEnvironment.extensionVersion,
            platform: process.platform,
            sessionId: env.sessionId
        };
    }

    public activate(): void {
        try {
            // Persistence is floated deliberately: the client and distinctId do not depend on it, and
            // awaiting it here would leave `client` null for any event racing activation.
            if (this.userIdState.value !== this.userId) {
                this.userIdState
                    .updateValue(this.userId)
                    .catch((error) => logger.debug(`Failed to persist telemetry user ID: ${error}`));
            }

            this.createClient();
        } catch (error) {
            logger.debug(`TelemetryService activation error: ${error}`);
        }

        this.disposables.push(
            workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('telemetry') || e.affectsConfiguration('deepnote.telemetry')) {
                    this.handleConfigChanged();
                }
            }),
            env.onDidChangeTelemetryEnabled(() => this.handleConfigChanged())
        );
    }

    public async dispose(): Promise<void> {
        await this.destroyClient();
    }

    public trackEvent(event: TelemetryEvent): void {
        try {
            if (!this.client) {
                return;
            }

            this.client.capture({
                distinctId: this.userId,
                event: event.eventName,
                properties: { ...event.properties, ...this.commonProperties, $process_person_profile: false }
            });
        } catch (ex) {
            logger.debug(`PostHog analytics error: ${ex}`);
        }
    }

    private createClient(): void {
        if (this.client || !this.isPostHogConfigured() || !this.isTelemetryEnabled()) {
            return;
        }

        this.client = new PostHog(POSTHOG_API_KEY, {
            flushAt: POSTHOG_FLUSH_AT,
            flushInterval: POSTHOG_FLUSH_INTERVAL,
            host: POSTHOG_HOST
        });
    }

    private async destroyClient(): Promise<void> {
        const client = this.client;
        this.client = null;

        if (!client) {
            return;
        }

        try {
            await client.shutdown(POSTHOG_SHUTDOWN_TIMEOUT);
        } catch (ex) {
            logger.debug(`PostHog shutdown error: ${ex}`);
        }
    }

    private handleConfigChanged(): void {
        try {
            if (this.isTelemetryEnabled()) {
                this.createClient();
            } else {
                this.destroyClient().catch((error) => {
                    logger.debug(`Failed to destroy PostHog client: ${error}`);
                });
            }
        } catch (error) {
            logger.debug(`Failed to handle telemetry configuration change: ${error}`);
        }
    }

    private isPostHogConfigured(): boolean {
        return IS_POSTHOG_CONFIGURED;
    }

    private isTelemetryEnabled(): boolean {
        if (!env.isTelemetryEnabled) {
            return false;
        }

        const telemetryLevel = workspace.getConfiguration('telemetry').get<string>('telemetryLevel', 'all');

        if (telemetryLevel !== 'all') {
            return false;
        }

        return workspace.getConfiguration('deepnote').get<boolean>('telemetry.enabled', true);
    }
}
