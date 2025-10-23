import { ThemeIcon, TreeItem, TreeItemCollapsibleState } from 'vscode';
import { DeepnoteEnvironment, EnvironmentStatus } from './deepnoteEnvironment';
import { getDeepnoteEnvironmentStatusVisual } from './deepnoteEnvironmentPicker';

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

    private setupEnvironmentItem(): void {
        if (!this.environment || !this.status) {
            return;
        }

        const statusVisual = getDeepnoteEnvironmentStatusVisual(this.status);

        this.label = `${this.environment.name} [${statusVisual.text}]`;
        this.iconPath = new ThemeIcon(statusVisual.icon, { id: statusVisual.themeColor.id });
        this.contextValue = statusVisual.contextValue;

        // Make it collapsible to show info items
        this.collapsibleState = TreeItemCollapsibleState.Collapsed;

        // Set description with last used time
        const lastUsed = this.getRelativeTime(this.environment.lastUsedAt);
        this.description = `Last used: ${lastUsed}`;

        // Set tooltip with detailed info
        this.tooltip = this.buildTooltip();
    }

    private setupInfoItem(): void {
        // Info items are not clickable and don't have context menus
        this.contextValue = 'deepnoteEnvironment.info';
        this.collapsibleState = TreeItemCollapsibleState.None;
    }

    private setupCreateAction(): void {
        this.label = 'Create New Environment';
        this.iconPath = new ThemeIcon('add');
        this.contextValue = 'deepnoteEnvironment.create';
        this.collapsibleState = TreeItemCollapsibleState.None;
        this.command = {
            command: 'deepnote.environments.create',
            title: 'Create Environment'
        };
    }

    private buildTooltip(): string {
        if (!this.environment) {
            return '';
        }

        const lines: string[] = [];
        lines.push(`**${this.environment.name}**`);
        lines.push('');
        lines.push(`Status: ${this.status}`);
        lines.push(`Python: ${this.environment.pythonInterpreter.uri.fsPath}`);
        lines.push(`Venv: ${this.environment.venvPath.fsPath}`);
        // lines.push(`Python: ${this.environment.pythonInterpreter.uriFsPath}`);
        // lines.push(`Venv: ${this.environment.venvPathFsPath}`);

        if (this.environment.packages && this.environment.packages.length > 0) {
            lines.push(`Packages: ${this.environment.packages.join(', ')}`);
        }

        if (this.environment.toolkitVersion) {
            lines.push(`Toolkit: ${this.environment.toolkitVersion}`);
        }

        lines.push('');
        lines.push(`Created: ${this.environment.createdAt.toLocaleString()}`);
        lines.push(`Last used: ${this.environment.lastUsedAt.toLocaleString()}`);

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
     * Create an info item to display under an environment
     */
    public static createInfoItem(label: string, icon?: string): DeepnoteEnvironmentTreeItem {
        const item = new DeepnoteEnvironmentTreeItem(EnvironmentTreeItemType.InfoItem, undefined, undefined, label);

        if (icon) {
            item.iconPath = new ThemeIcon(icon);
        }

        return item;
    }
}
