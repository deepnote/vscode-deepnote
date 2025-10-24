import type { ActivationFunction, OutputItem, RendererContext } from 'vscode-notebook-renderer';
import * as React from 'react';
import * as ReactDOM from 'react-dom';

import { SqlMetadataRenderer } from './SqlMetadataRenderer';

/**
 * Renderer for SQL metadata output (application/vnd.deepnote.sql-output-metadata+json).
 * This renderer displays information about SQL query execution, including cache status,
 * query size, and other metadata.
 */
export const activate: ActivationFunction = (_context: RendererContext<unknown>) => {
    const roots = new Map<string, HTMLElement>();

    return {
        renderOutputItem(outputItem: OutputItem, element: HTMLElement) {
            try {
                const data = outputItem.json();

                const root = document.createElement('div');
                element.appendChild(root);
                roots.set(outputItem.id, root);

                ReactDOM.render(React.createElement(SqlMetadataRenderer, { data }), root);
            } catch (error) {
                console.error(`Error rendering SQL metadata: ${error}`);
                const errorDiv = document.createElement('div');
                errorDiv.style.padding = '10px';
                errorDiv.style.color = 'var(--vscode-errorForeground)';
                errorDiv.textContent = `Error rendering SQL metadata: ${error}`;
                element.appendChild(errorDiv);
            }
        },

        disposeOutputItem(id?: string) {
            if (id) {
                const root = roots.get(id);
                if (root) {
                    ReactDOM.unmountComponentAtNode(root);
                    roots.delete(id);
                }
            }
        }
    };
};
