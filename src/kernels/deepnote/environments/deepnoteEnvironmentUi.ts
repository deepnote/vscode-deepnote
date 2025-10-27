import { l10n } from 'vscode';

import { EnvironmentStatus } from './deepnoteEnvironment';

export function getDeepnoteEnvironmentStatusVisual(status: EnvironmentStatus): {
    icon: string;
    text: string;
    themeColorId: string;
    contextValue: string;
} {
    switch (status) {
        case EnvironmentStatus.Running:
            return {
                icon: 'vm-running',
                text: l10n.t('Running'),
                contextValue: 'deepnoteEnvironment.running',
                themeColorId: 'charts.green'
            };
        case EnvironmentStatus.Starting:
            return {
                icon: 'loading~spin',
                text: l10n.t('Starting...'),
                contextValue: 'deepnoteEnvironment.starting',
                themeColorId: 'charts.yellow'
            };
        case EnvironmentStatus.Stopped:
            return {
                icon: 'vm-outline',
                text: l10n.t('Stopped'),
                contextValue: 'deepnoteEnvironment.stopped',
                themeColorId: 'charts.gray'
            };
        case EnvironmentStatus.Error:
            return {
                icon: 'vm-outline',
                text: l10n.t('Error'),
                contextValue: 'deepnoteEnvironment.stopped',
                themeColorId: 'charts.gray'
            };
        default:
            status satisfies never;
            return {
                icon: 'vm-outline',
                text: l10n.t('Unknown'),
                contextValue: 'deepnoteEnvironment.stopped',
                themeColorId: 'charts.gray'
            };
    }
}
