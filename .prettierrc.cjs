module.exports = {
    singleQuote: true,
    printWidth: 120,
    tabWidth: 4,
    endOfLine: 'auto',
    trailingComma: 'none',
    plugins: ['prettier-plugin-tailwindcss'],
    tailwindStylesheet: './src/webviews/webview-side/dataframe-renderer/tailwind.css',
    overrides: [
        {
            files: ['*.yml', '*.yaml'],
            options: {
                tabWidth: 2
            }
        },
        {
            files: ['*.md'],
            options: {
                tabWidth: 2
            }
        },
        {
            files: ['**/datascience/serviceRegistry.ts'],
            options: {
                printWidth: 240
            }
        }
    ]
};
