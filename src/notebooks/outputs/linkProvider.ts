// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export const LineQueryRegex = /line=(\d+)/;

// The following list of commands represent those that can be executed
// in a markdown cell using the syntax: https://command:[my.vscode.command].
export const linkCommandAllowList = [
    'deepnote.latestExtension',
    'deepnote.viewOutput',
    'workbench.action.openSettings',
    'deepnote.enableLoadingWidgetScriptsFromThirdPartySource'
];
