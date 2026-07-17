import { deserializeDeepnoteFile } from '@deepnote/blocks';

/** Counts notebooks in a serialized `.deepnote` file by parsing it with the canonical schema. */
export function notebookCount(yaml: string): number {
    return deserializeDeepnoteFile(yaml).project.notebooks.length;
}
