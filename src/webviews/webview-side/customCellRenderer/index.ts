// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ActivationFunction, RendererContext } from 'vscode-notebook-renderer';
import { RendererRegistry } from './renderers/rendererRegistry';
import { ButtonRenderer } from './renderers/buttonRenderer';

export const activate: ActivationFunction = (context: RendererContext<any>) => {
    const registry = new RendererRegistry();
    
    // Register custom renderers
    registry.register('button', new ButtonRenderer());
    
    return {
        renderOutputItem(outputItem, element) {
            // Clear previous content
            element.innerHTML = '';
            
            try {
                // Parse the custom cell data
                const data = outputItem.json() as {
                    cellType: string;
                    source: string;
                    metadata?: any;
                };
                
                // Get the appropriate renderer
                const renderer = registry.get(data.cellType);
                
                if (renderer) {
                    // Render the custom cell
                    renderer.render(element, data.source, data.metadata, context);
                } else {
                    // Fallback for unknown cell types
                    element.innerHTML = `
                        <div style="padding: 10px; border: 1px solid #e0e0e0; border-radius: 4px;">
                            <div style="color: #666; font-size: 12px;">Unknown cell type: ${data.cellType}</div>
                            <pre style="margin-top: 8px;">${escapeHtml(data.source)}</pre>
                        </div>
                    `;
                }
            } catch (error) {
                element.innerHTML = `
                    <div style="color: red; padding: 10px;">
                        Error rendering custom cell: ${error}
                    </div>
                `;
            }
        }
    };
};

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}