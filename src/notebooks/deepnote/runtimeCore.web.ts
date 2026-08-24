/** Web stands in for @deepnote/runtime-core, which needs Node built-ins. Agent blocks run on desktop only. */
const unsupported = (): never => {
    throw new Error('Deepnote agent blocks are not supported in the web extension host.');
};

export const executeAgentBlock = unsupported;
export const serializeNotebookContextFromBlocks = unsupported;
