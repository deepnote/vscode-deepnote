import type { ActivationFunction } from 'vscode-notebook-renderer';

const styleContent = `
.alert {
    width: auto;
    padding: 1em;
    margin-top: 1em;
    margin-bottom: 1em;
	border-style: solid;
	border-width: 1px;
}
.alert > *:last-child {
    margin-bottom: 0;
}
#preview > .alert:last-child {
    /* Prevent this being set to zero by the default notebook stylesheet */
    padding-bottom: 1em;
}

.alert-success {
    background-color: rgb(200,230,201);
    color: rgb(27,94,32);
}
.alert-info {
    background-color: rgb(178,235,242);
    color: rgb(0,96,100);
}
.alert-warning {
    background-color: rgb(255,224,178);
    color: rgb(230,81,0);
}
.alert-danger {
    background-color: rgb(255,205,210);
    color: rgb(183,28,28);
}

.ephemeral-cell {
    border-left: 3px solid var(--vscode-charts-yellow, #cca700);
    padding-left: 8px;
    opacity: 0.8;
}
.ephemeral-badge {
    display: inline-block;
    font-size: 0.75em;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--vscode-charts-yellow, #cca700);
    color: var(--vscode-editor-background, #1e1e1e);
    margin-bottom: 4px;
    font-weight: 600;
    letter-spacing: 0.03em;
}
`;

export const activate: ActivationFunction = async (ctx) => {
    const style = document.createElement('style');
    style.textContent = styleContent;
    const template = document.createElement('template');
    template.classList.add('markdown-style');
    template.content.appendChild(style);
    document.head.appendChild(template);

    const markdownRenderer = await ctx.getRenderer('vscode.markdown-it-renderer');
    if (markdownRenderer) {
        (markdownRenderer as any).extendMarkdownIt((md: any) => {
            addEphemeralCellWrapper(md);
        });
    }

    return undefined;
};

function addEphemeralCellWrapper(md: any): void {
    md.core.ruler.push('ephemeral_wrapper', (state: any) => {
        const metadata = state.env?.outputItem?.metadata;
        if (!metadata || metadata.is_ephemeral !== true) {
            return;
        }

        const openToken = new state.Token('html_block', '', 0);
        openToken.content = '<div class="ephemeral-cell"><span class="ephemeral-badge">\u2728 Ephemeral</span>\n';

        const closeToken = new state.Token('html_block', '', 0);
        closeToken.content = '</div>\n';

        state.tokens.unshift(openToken);
        state.tokens.push(closeToken);
    });
}
