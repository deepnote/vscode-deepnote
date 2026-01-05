// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { CancellationToken, Uri, Event, EventEmitter } from 'vscode';
import { JupyterServer, JupyterServerProvider } from '../../api';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { IJupyterServerProviderRegistry } from '../jupyter/types';
import { JVSC_EXTENSION_ID } from '../../platform/common/constants';
import { logger } from '../../platform/logging';
import { DeepnoteServerNotFoundError } from '../../platform/errors/deepnoteServerNotFoundError';
import { DeepnoteServerInfo, IDeepnoteServerProvider } from './types';

/**
 * Jupyter Server Provider for Deepnote kernels.
 * This provider resolves server connections for Deepnote kernels.
 */
@injectable()
export class DeepnoteServerProvider
    implements IDeepnoteServerProvider, IExtensionSyncActivationService, JupyterServerProvider
{
    public readonly id = 'deepnote-server';
    private readonly _onDidChangeServers = new EventEmitter<void>();
    public readonly onDidChangeServers: Event<void> = this._onDidChangeServers.event;

    // Map of server handles to server info
    private servers = new Map<string, DeepnoteServerInfo>();

    constructor(
        @inject(IJupyterServerProviderRegistry)
        private readonly jupyterServerProviderRegistry: IJupyterServerProviderRegistry,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry
    ) {}

    public activate() {
        // Register this server provider
        const collection = this.jupyterServerProviderRegistry.createJupyterServerCollection(
            JVSC_EXTENSION_ID,
            this.id,
            'Deepnote Toolkit Server',
            this
        );
        this.disposables.push(collection);
        logger.info('Deepnote server provider registered');
    }

    /**
     * Register a server for a specific handle.
     * Called by DeepnoteKernelAutoSelector when a server is started.
     */
    public registerServer(handle: string, serverInfo: DeepnoteServerInfo): void {
        logger.info(`Registering Deepnote server: ${handle} -> ${serverInfo.url}`);
        this.servers.set(handle, serverInfo);
        this._onDidChangeServers.fire();
    }

    /**
     * Unregister a server for a specific handle.
     * Called when the server is no longer needed or notebook is closed.
     * No-op if the handle doesn't exist.
     */
    public unregisterServer(handle: string): void {
        if (this.servers.has(handle)) {
            logger.info(`Unregistering Deepnote server: ${handle}`);
            this.servers.delete(handle);
            this._onDidChangeServers.fire();
        }
    }

    /**
     * Dispose of all servers and resources.
     */
    public dispose(): void {
        logger.info('Disposing Deepnote server provider, clearing all registered servers');
        this.servers.clear();
        this._onDidChangeServers.dispose();
    }

    /**
     * Provides the list of available Deepnote servers.
     */
    public async provideJupyterServers(_token: CancellationToken): Promise<JupyterServer[]> {
        const servers: JupyterServer[] = [];
        for (const [handle, info] of this.servers.entries()) {
            servers.push({
                id: handle,
                label: `Deepnote Toolkit (jupyter:${info.jupyterPort}, lsp:${info.lspPort})`,
                connectionInformation: {
                    baseUrl: Uri.parse(info.url),
                    token: info.token || ''
                }
            });
        }
        return servers;
    }

    /**
     * Resolves a Jupyter server by its handle.
     * This is called by the kernel infrastructure when starting a kernel.
     */
    public async resolveJupyterServer(server: JupyterServer, _token: CancellationToken): Promise<JupyterServer> {
        logger.info(`Resolving Deepnote server: ${server.id}`);
        const serverInfo = this.servers.get(server.id);

        if (!serverInfo) {
            throw new DeepnoteServerNotFoundError(server.id);
        }

        return {
            id: server.id,
            label: server.label,
            connectionInformation: {
                baseUrl: Uri.parse(serverInfo.url),
                token: serverInfo.token || ''
            }
        };
    }
}
