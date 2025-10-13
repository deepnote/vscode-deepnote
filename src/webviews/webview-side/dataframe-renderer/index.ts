import './styles.css';

import * as React from 'react';
import * as ReactDOM from 'react-dom';

import type { ActivationFunction, OutputItem, RendererContext } from 'vscode-notebook-renderer';

import { DataframeRenderer } from './DataframeRenderer';

export const activate: ActivationFunction = (context: RendererContext<unknown>) => {
    return {
        renderOutputItem(outputItem: OutputItem, element: HTMLElement) {
            console.log('Dataframe renderer - rendering output item:', { outputItem, context });
            try {
                const data = outputItem.json();
                console.log('Dataframe renderer - received data:', data);

                const root = document.createElement('div');
                element.appendChild(root);

                ReactDOM.render(React.createElement(DataframeRenderer, { data, context }), root);
            } catch (error) {
                console.error('Error rendering dataframe:', error);
                const errorDiv = document.createElement('div');
                errorDiv.style.padding = '10px';
                errorDiv.style.color = 'var(--vscode-errorForeground)';
                errorDiv.textContent = `Error rendering dataframe: ${error}`;
                element.appendChild(errorDiv);
            }
        },

        disposeOutputItem(_id?: string) {
            // Cleanup if needed
        }
    };
};
