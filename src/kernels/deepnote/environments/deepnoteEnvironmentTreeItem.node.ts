import { l10n, ThemeColor, ThemeIcon, TreeItem, TreeItemCollapsibleState } from 'vscode';

import { DeepnoteEnvironment, EnvironmentStatus } from './deepnoteEnvironment';
import { getDeepnoteEnvironmentStatusVisual } from './deepnoteEnvironmentUi';

/**
 * Type of tree item in the environments view
 */
export enum EnvironmentTreeItemType {
    Environment = 'environment',
    InfoItem = 'info',
    CreateAction = 'create'
}

/**
 * Tree item for displaying environments and related info
 */
export class DeepnoteEnvironmentTreeItem extends TreeItem {
    constructor(
        public readonly type: EnvironmentTreeItemType,
        public readonly environment?: DeepnoteEnvironment,
        public readonly status?: EnvironmentStatus,
        label?: string,
        collapsibleState?: TreeItemCollapsibleState
    ) {
        super(label || '', collapsibleState);

        if (type === EnvironmentTreeItemType.Environment && environment) {
            this.setupEnvironmentItem();
        } else if (type === EnvironmentTreeItemType.InfoItem) {
            this.setupInfoItem();
        } else if (type === EnvironmentTreeItemType.CreateAction) {
            this.setupCreateAction();
        }
    }

    /**
     * Create an info item to display under an environment
     */
    public static createInfoItem(label: string, icon?: string): DeepnoteEnvironmentTreeItem {
        const item = new DeepnoteEnvironmentTreeItem(EnvironmentTreeItemType.InfoItem, undefined, undefined, label);

        if (icon) {
            item.iconPath = new ThemeIcon(icon);
        }

        return item;
    }

    private setupEnvironmentItem(): void {
        if (!this.environment || !this.status) {
            return;
        }

        const statusVisual = getDeepnoteEnvironmentStatusVisual(this.status);

        this.label = `${this.environment.name} [${statusVisual.text}]`;
        this.iconPath = new ThemeIcon(statusVisual.icon, new ThemeColor(statusVisual.themeColorId));
        this.contextValue = statusVisual.contextValue;

        // Make it collapsible to show info items
        this.collapsibleState = TreeItemCollapsibleState.Collapsed;

        // Set description with last used time
        const lastUsed = this.getRelativeTime(this.environment.lastUsedAt);
        this.description = l10n.t('Last used: {0}', lastUsed);

        // Set tooltip with detailed info
        this.tooltip = this.buildTooltip();
    }

    private setupInfoItem(): void {
        // Info items are not clickable and don't have context menus
        this.contextValue = 'deepnoteEnvironment.info';
        this.collapsibleState = TreeItemCollapsibleState.None;
    }

    private setupCreateAction(): void {
        this.label = l10n.t('Create New Environment');
        this.iconPath = new ThemeIcon('add');
        this.contextValue = 'deepnoteEnvironment.create';
        this.collapsibleState = TreeItemCollapsibleState.None;
        this.command = {
            command: 'deepnote.environments.create',
            title: l10n.t('Create Environment')
        };
    }

    private buildTooltip(): string {
        if (!this.environment) {
            return '';
        }

        const lines: string[] = [];
        lines.push(`**${this.environment.name}**`);
        lines.push('');
        lines.push(l10n.t('Status: {0}', this.status ?? l10n.t('Unknown')));
        lines.push(l10n.t('Python: {0}', this.environment.pythonInterpreter.uri.toString(true)));
        lines.push(l10n.t('Venv: {0}', this.environment.venvPath.toString(true)));

        if (this.environment.packages && this.environment.packages.length > 0) {
            lines.push(l10n.t('Packages: {0}', this.environment.packages.join(', ')));
        }

        if (this.environment.toolkitVersion) {
            lines.push(l10n.t('Toolkit: {0}', this.environment.toolkitVersion));
        }

        lines.push('');
        lines.push(l10n.t('Created: {0}', this.environment.createdAt.toLocaleString()));
        lines.push(l10n.t('Last used: {0}', this.environment.lastUsedAt.toLocaleString()));

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
            return l10n.t('just now');
        } else if (minutes < 60) {
            return minutes === 1 ? l10n.t('1 minute ago') : l10n.t('{0} minutes ago', minutes);
        } else if (hours < 24) {
            return hours === 1 ? l10n.t('1 hour ago') : l10n.t('{0} hours ago', hours);
        } else if (days < 7) {
            return days === 1 ? l10n.t('1 day ago') : l10n.t('{0} days ago', days);
        } else {
            return date.toLocaleDateString();
        }
    }
}
