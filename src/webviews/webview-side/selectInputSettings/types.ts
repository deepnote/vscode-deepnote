// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export interface SelectInputSettings {
    allowMultipleValues: boolean;
    allowEmptyValue: boolean;
    selectType: 'from-options' | 'from-variable';
    options: string[];
    selectedVariable: string;
}

export interface WebviewMessage {
    type: 'init' | 'save' | 'locInit' | 'cancel';
    settings?: SelectInputSettings;
    locStrings?: Record<string, string>;
}
