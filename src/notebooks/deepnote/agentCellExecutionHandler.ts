import { NotebookCell, NotebookCellOutput, NotebookCellOutputItem, NotebookController } from 'vscode';

import type { Pocket } from '../../platform/deepnote/pocket';
import { logger } from '../../platform/logging';

export function isAgentCell(cell: NotebookCell): boolean {
    const pocket = cell.metadata?.__deepnotePocket as Pocket | undefined;

    return pocket?.type === 'agent';
}

export async function executeAgentCell(cell: NotebookCell, controller: NotebookController): Promise<void> {
    const execution = controller.createNotebookCellExecution(cell);
    execution.start(Date.now());

    try {
        await execution.clearOutput();
        const prompt = cell.document.getText();

        const output = new NotebookCellOutput([
            NotebookCellOutputItem.text(`[Agent] Received prompt (${prompt.length} chars)...\n`)
        ]);
        await execution.replaceOutput([output]);

        const chunks = [
            { delay: 500, text: '[Agent] Analyzing prompt...\n' },
            { delay: 1000, text: '[Agent] Generating plan...\n' },
            { delay: 2000, text: '[Agent] Executing steps...\n' },
            { delay: 3000, text: `[Agent] Done.\n\nPrompt: ${prompt}\n` }
        ];

        let accumulated = `[Agent] Received prompt (${prompt.length} chars)...\n`;
        for (const chunk of chunks) {
            await delay(chunk.delay);
            accumulated += chunk.text;
            await execution.replaceOutputItems(NotebookCellOutputItem.text(accumulated), output);
        }

        execution.end(true, Date.now());
    } catch (error) {
        logger.error('Agent cell execution failed', error);
        const message = error instanceof Error ? error.message : String(error);
        const stderrOutput = new NotebookCellOutput([NotebookCellOutputItem.stderr(message)]);
        await execution.replaceOutput([stderrOutput]).then(undefined, () => undefined);
        execution.end(false, Date.now());
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
