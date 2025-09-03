import type { ActivationFunction } from 'vscode-notebook-renderer';

export const activate: ActivationFunction = (_context) => ({
    renderOutputItem(data, element) {
        element.innerText = JSON.stringify(data.json());
    }
});
