import { deserializeDeepnoteFile, isExecutableBlock } from '@deepnote/blocks';

/** Counts notebooks in a serialized `.deepnote` file by parsing it with the canonical schema. */
export function notebookCount(yaml: string): number {
    return deserializeDeepnoteFile(yaml).project.notebooks.length;
}

/**
 * The text a block's stream outputs carry in a serialized `.deepnote`, concatenated in order.
 *
 * Parse rather than search the raw YAML: `serializeDeepnoteFile` folds at 120 columns, so a marker
 * that is one unbroken string in the block can sit across two lines in the file.
 */
export function blockStreamOutputText(yaml: string, blockId: string): string {
    const block = deserializeDeepnoteFile(yaml)
        .project.notebooks.flatMap((notebook) => notebook.blocks ?? [])
        .find((candidate) => candidate.id === blockId);

    if (!block) {
        throw new Error(`No block ${JSON.stringify(blockId)} in the serialized project.`);
    }

    if (!isExecutableBlock(block)) {
        throw new Error(`Block ${JSON.stringify(blockId)} is a ${block.type} block, which carries no outputs.`);
    }

    return (block.outputs ?? [])
        .map((output: { text?: string | string[] }) => {
            const text = output.text ?? '';

            return Array.isArray(text) ? text.join('') : text;
        })
        .join('');
}
