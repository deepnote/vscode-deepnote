import React from 'react';
import ReactDOM from 'react-dom';
import type { ActivationFunction, OutputItem, RendererContext } from 'vscode-notebook-renderer';
import { ErrorBoundary } from 'react-error-boundary';
import { VegaRenderer } from './VegaRenderer';
import { ErrorFallback } from './ErrorBoundary';

/**
 * Renderer for Vega charts (application/vnd.vega.v5+json).
 */
export const activate: ActivationFunction = (_context: RendererContext<unknown>) => {
    const elementsCache: Record<string, HTMLElement | undefined> = {};
    return {
        renderOutputItem(outputItem: OutputItem, element: HTMLElement) {
            try {
                const spec = outputItem.json();
                const root = document.createElement('div');
                root.style.height = '500px';

                element.appendChild(root);
                elementsCache[outputItem.id] = root;
                ReactDOM.render(
                    React.createElement(
                        ErrorBoundary,
                        {
                            FallbackComponent: ErrorFallback,
                            onError: (error, info) => {
                                console.error('Vega renderer error:', error, info);
                            }
                        },
                        React.createElement(VegaRenderer, {
                            spec: spec
                        })
                    ),
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
                elementsCache[id] = undefined;
            }
        }
    };
};
