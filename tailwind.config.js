/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ['./src/webviews/webview-side/dataframe-renderer/**/*.{ts,tsx}'],
    theme: {
        extend: {
            colors: {
                'vscode-foreground': 'var(--vscode-foreground)',
                'vscode-background': 'var(--vscode-editor-background)',
                'vscode-border': 'var(--vscode-panel-border)'
            },
            borderColor: {
                'vscode-border': 'var(--vscode-panel-border)'
            },
            fontFamily: {
                mono: 'var(--vscode-editor-font-family)'
            }
        }
    },
    plugins: [],
    // Prevent Tailwind from conflicting with VSCode styles
    corePlugins: {
        preflight: false
    }
};
