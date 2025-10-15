import React from 'react';
import ReactDOM from 'react-dom';
import type { ActivationFunction, OutputItem, RendererContext } from 'vscode-notebook-renderer';
import { VegaRenderer } from './VegaRenderer';

interface Metadata {
    cellId?: string;
    cellIndex?: number;
    executionCount?: number;
    outputType?: string;
}

/**
 * Renderer for Vega/Vega-Lite charts (application/vnd.vega.v5+json).
 * Currently renders static text representation of the chart spec.
 */
export const activate: ActivationFunction = (_context: RendererContext<unknown>) => {
    const elementsCache: Record<string, HTMLElement> = {};
    return {
        renderOutputItem(outputItem: OutputItem, element: HTMLElement) {
            console.log(`Vega renderer - rendering output item: ${outputItem.id}`);
            try {
                const spec = outputItem.json();

                console.log(`Vega renderer - received spec with ${Object.keys(spec).length} keys`);

                const metadata = outputItem.metadata as Metadata | undefined;

                console.log('[VegaRenderer] Full metadata', metadata);

                const root = document.createElement('div');
                root.style.height = '500px';

                element.appendChild(root);
                elementsCache[outputItem.id] = root;
                ReactDOM.render(
                    React.createElement(VegaRenderer, {
                        spec: spec
                    }),
                    root
                );
            } catch (error) {
                console.error(`Error rendering Vega chart: ${error}`);
                const errorDiv = document.createElement('div');
                errorDiv.style.padding = '10px';
                errorDiv.style.color = 'var(--vscode-errorForeground)';
                errorDiv.textContent = `Error rendering chart: ${error}`;
                element.appendChild(errorDiv);
            }
        },

        disposeOutputItem(id?: string) {
            if (id && elementsCache[id]) {
                ReactDOM.unmountComponentAtNode(elementsCache[id]);
            }
        }
    };
};
