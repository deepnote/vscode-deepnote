// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { RendererContext } from 'vscode-notebook-renderer';

export interface CustomCellRenderer {
    render(
        element: HTMLElement,
        source: string,
        metadata: any,
        context: RendererContext<any>
    ): void;
}

export interface ButtonCellMetadata {
    label?: string;
    variant?: 'primary' | 'secondary' | 'danger' | 'success';
    size?: 'small' | 'medium' | 'large';
    disabled?: boolean;
    action?: {
        type: 'execute' | 'message' | 'command';
        value?: string;
    };
}