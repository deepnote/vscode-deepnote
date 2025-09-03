// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CustomCellRenderer } from './types';

export class RendererRegistry {
    private renderers = new Map<string, CustomCellRenderer>();

    register(cellType: string, renderer: CustomCellRenderer): void {
        this.renderers.set(cellType, renderer);
    }

    get(cellType: string): CustomCellRenderer | undefined {
        return this.renderers.get(cellType);
    }

    has(cellType: string): boolean {
        return this.renderers.has(cellType);
    }

    list(): string[] {
        return Array.from(this.renderers.keys());
    }
}