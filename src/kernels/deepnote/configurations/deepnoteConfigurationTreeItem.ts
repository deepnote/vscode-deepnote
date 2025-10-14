// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ThemeIcon, TreeItem, TreeItemCollapsibleState } from 'vscode';
import { DeepnoteKernelConfiguration, KernelConfigurationStatus } from './deepnoteKernelConfiguration';

/**
 * Type of tree item in the kernel configurations view
 */
export enum ConfigurationTreeItemType {
    Configuration = 'configuration',
    InfoItem = 'info',
    CreateAction = 'create'
}

/**
 * Tree item for displaying kernel configurations and related info
 */
export class DeepnoteConfigurationTreeItem extends TreeItem {
    constructor(
        public readonly type: ConfigurationTreeItemType,
        public readonly configuration?: DeepnoteKernelConfiguration,
        public readonly status?: KernelConfigurationStatus,
        label?: string,
        collapsibleState?: TreeItemCollapsibleState
    ) {
        super(label || '', collapsibleState);

        if (type === ConfigurationTreeItemType.Configuration && configuration) {
            this.setupConfigurationItem();
        } else if (type === ConfigurationTreeItemType.InfoItem) {
            this.setupInfoItem();
        } else if (type === ConfigurationTreeItemType.CreateAction) {
            this.setupCreateAction();
        }
    }

    private setupConfigurationItem(): void {
        if (!this.configuration || !this.status) {
            return;
        }

        const isRunning = this.status === KernelConfigurationStatus.Running;
        const isStarting = this.status === KernelConfigurationStatus.Starting;

        // Set label with status indicator
        const statusText = isRunning ? '[Running]' : isStarting ? '[Starting...]' : '[Stopped]';
        this.label = `${this.configuration.name} ${statusText}`;

        // Set icon based on status
        if (isRunning) {
            this.iconPath = new ThemeIcon('vm-running', { id: 'charts.green' });
        } else if (isStarting) {
            this.iconPath = new ThemeIcon('loading~spin', { id: 'charts.yellow' });
        } else {
            this.iconPath = new ThemeIcon('vm-outline', { id: 'charts.gray' });
        }

        // Set context value for command filtering
        this.contextValue = isRunning
            ? 'deepnoteConfiguration.running'
            : isStarting
            ? 'deepnoteConfiguration.starting'
            : 'deepnoteConfiguration.stopped';

        // Make it collapsible to show info items
        this.collapsibleState = TreeItemCollapsibleState.Collapsed;

        // Set description with last used time
        const lastUsed = this.getRelativeTime(this.configuration.lastUsedAt);
        this.description = `Last used: ${lastUsed}`;

        // Set tooltip with detailed info
        this.tooltip = this.buildTooltip();
    }

    private setupInfoItem(): void {
        // Info items are not clickable and don't have context menus
        this.contextValue = 'deepnoteConfiguration.info';
        this.collapsibleState = TreeItemCollapsibleState.None;
    }

    private setupCreateAction(): void {
        this.label = 'Create New Configuration';
        this.iconPath = new ThemeIcon('add');
        this.contextValue = 'deepnoteConfiguration.create';
        this.collapsibleState = TreeItemCollapsibleState.None;
        this.command = {
            command: 'deepnote.configurations.create',
            title: 'Create Configuration'
        };
    }

    private buildTooltip(): string {
        if (!this.configuration) {
            return '';
        }

        const lines: string[] = [];
        lines.push(`**${this.configuration.name}**`);
        lines.push('');
        lines.push(`Status: ${this.status}`);
        lines.push(`Python: ${this.configuration.pythonInterpreter.uri.fsPath}`);
        lines.push(`Venv: ${this.configuration.venvPath.fsPath}`);

        if (this.configuration.packages && this.configuration.packages.length > 0) {
            lines.push(`Packages: ${this.configuration.packages.join(', ')}`);
        }

        if (this.configuration.toolkitVersion) {
            lines.push(`Toolkit: ${this.configuration.toolkitVersion}`);
        }

        lines.push('');
        lines.push(`Created: ${this.configuration.createdAt.toLocaleString()}`);
        lines.push(`Last used: ${this.configuration.lastUsedAt.toLocaleString()}`);

        return lines.join('\n');
    }

    private getRelativeTime(date: Date): string {
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (seconds < 60) {
            return 'just now';
        } else if (minutes < 60) {
            return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
        } else if (hours < 24) {
            return `${hours} hour${hours > 1 ? 's' : ''} ago`;
        } else if (days < 7) {
            return `${days} day${days > 1 ? 's' : ''} ago`;
        } else {
            return date.toLocaleDateString();
        }
    }

    /**
     * Create an info item to display under a configuration
     */
    public static createInfoItem(label: string, icon?: string): DeepnoteConfigurationTreeItem {
        const item = new DeepnoteConfigurationTreeItem(ConfigurationTreeItemType.InfoItem, undefined, undefined, label);

        if (icon) {
            item.iconPath = new ThemeIcon(icon);
        }

        return item;
    }
}
