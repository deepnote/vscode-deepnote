module.exports = {
    singleQuote: true,
    printWidth: 120,
    tabWidth: 2,
    endOfLine: 'auto',
    trailingComma: 'es5',
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
        }
    ]
};
