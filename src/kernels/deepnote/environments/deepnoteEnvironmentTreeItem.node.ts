import { l10n, ThemeIcon, TreeItem, TreeItemCollapsibleState } from 'vscode';

import { DeepnoteEnvironment } from './deepnoteEnvironment';

/**
 * Type of tree item in the environments view
 */
export enum EnvironmentTreeItemType {
    Environment = 'environment',
    InfoItem = 'info',
    CreateAction = 'create'
}

export type DeepnoteEnvironmentTreeInfoItemId =
    | 'python'
    | 'venv'
    | 'managed'
    | 'packages'
    | 'toolkit'
    | 'created'
    | 'lastUsed';

/**
 * Tree item for displaying environments and related info
 */
export class DeepnoteEnvironmentTreeItem extends TreeItem {
    constructor(
        public readonly type: EnvironmentTreeItemType,
        public readonly environment?: DeepnoteEnvironment,
        label?: string,
        collapsibleState?: TreeItemCollapsibleState
    ) {
        super(label || '', collapsibleState);

        // Setup inline to avoid method binding issues with ES modules and TreeItem proxy
        if (type === EnvironmentTreeItemType.Environment && environment) {
            // setupEnvironmentItem inline
            this.id = environment.id;
            this.label = environment.name;
            this.collapsibleState = TreeItemCollapsibleState.Collapsed;

            // getRelativeTime inline
            const now = new Date();
            const diff = now.getTime() - environment.lastUsedAt.getTime();
            const seconds = Math.floor(diff / 1000);
            const minutes = Math.floor(seconds / 60);
            const hours = Math.floor(minutes / 60);
            const days = Math.floor(hours / 24);

            let lastUsed: string;
            if (seconds < 60) {
                lastUsed = l10n.t('just now');
            } else if (minutes < 60) {
                lastUsed = minutes === 1 ? l10n.t('1 minute ago') : l10n.t('{0} minutes ago', minutes);
            } else if (hours < 24) {
                lastUsed = hours === 1 ? l10n.t('1 hour ago') : l10n.t('{0} hours ago', hours);
            } else if (days < 7) {
                lastUsed = days === 1 ? l10n.t('1 day ago') : l10n.t('{0} days ago', days);
            } else {
                lastUsed = environment.lastUsedAt.toLocaleDateString();
            }

            this.description = l10n.t('Last used: {0}', lastUsed);

            // buildTooltip inline
            const lines: string[] = [];
            lines.push(`**${environment.name}**`);
            lines.push('');
            lines.push(l10n.t('Python: {0}', environment.pythonInterpreter.uri.toString(true)));
            lines.push(l10n.t('Venv: {0}', environment.venvPath.toString(true)));
            lines.push(
                environment.managedVenv
                    ? l10n.t('Type: Managed (created by extension)')
                    : l10n.t('Type: External (user-provided)')
            );

            if (environment.packages && environment.packages.length > 0) {
                lines.push(l10n.t('Packages: {0}', environment.packages.join(', ')));
            }

            if (environment.toolkitVersion) {
                lines.push(l10n.t('Toolkit: {0}', environment.toolkitVersion));
            }

            lines.push('');
            lines.push(l10n.t('Created: {0}', environment.createdAt.toLocaleString()));
            lines.push(l10n.t('Last used: {0}', environment.lastUsedAt.toLocaleString()));

            this.tooltip = lines.join('\n');
        } else if (type === EnvironmentTreeItemType.InfoItem) {
            // setupInfoItem inline
            this.contextValue = 'deepnoteEnvironment.info';
            this.collapsibleState = TreeItemCollapsibleState.None;
        } else if (type === EnvironmentTreeItemType.CreateAction) {
            // setupCreateAction inline
            this.id = 'create';
            this.label = l10n.t('Create New Environment');
            this.iconPath = new ThemeIcon('add');
            this.contextValue = 'deepnoteEnvironment.create';
            this.collapsibleState = TreeItemCollapsibleState.None;
            this.command = {
                command: 'deepnote.environments.create',
                title: l10n.t('Create Environment')
            };
        }
    }

    /**
     * Create an info item to display under an environment
     */
    public static createInfoItem(
        id: DeepnoteEnvironmentTreeInfoItemId,
        environmentId: string,
        label: string,
        icon?: string
    ): DeepnoteEnvironmentTreeItem {
        const item = new DeepnoteEnvironmentTreeItem(EnvironmentTreeItemType.InfoItem, undefined, label);
        item.id = `info-${environmentId}-${id}`;

        if (icon) {
            item.iconPath = new ThemeIcon(icon);
        }

        return item;
    }
}
