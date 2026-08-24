const { isBuiltin } = require('node:module');

// Force everything to use the custom vscode-path instead. General Node-builtin detection is
// handled by oxlint's native `import/no-nodejs-modules` rule (see oxlint.config.mts); this rule
// only still covers `path`, since that ban applies unconditionally, including in .node.ts files,
// which no-nodejs-modules can't express (it's turned off there for legitimate Node builtins).
function reportIfPath(context, node, name) {
    if (isBuiltin(name) && name === 'path') {
        context.report({ node, message: `Do not import path builtin module. Use the custom vscode-path instead.` });
    }
}

module.exports = {
    rules: {
        'node-imports': {
            meta: {
                type: 'problem',
                docs: {
                    description: 'Force use of the custom vscode-path module instead of the builtin `path`',
                    category: 'import'
                }
            },
            create: function (context) {
                // `export { x }` and `export const x = 1` carry no source to check.
                function checkSource(node) {
                    if (node.source) {
                        reportIfPath(context, node, node.source.value);
                    }
                }

                return {
                    ImportDeclaration: checkSource,
                    ExportNamedDeclaration: checkSource,
                    ExportAllDeclaration: checkSource,
                    ImportExpression(node) {
                        if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
                            reportIfPath(context, node, node.source.value);
                        }
                    },
                    CallExpression(node) {
                        if (
                            node.callee.type === 'Identifier' &&
                            node.callee.name === 'require' &&
                            node.arguments.length === 1 &&
                            node.arguments[0].type === 'Literal' &&
                            typeof node.arguments[0].value === 'string'
                        ) {
                            reportIfPath(context, node, node.arguments[0].value);
                        }
                    }
                };
            }
        },
        'dont-use-process': {
            meta: {
                type: 'problem',
                docs: {
                    description: 'Prevent use of process.env in non-node files',
                    category: 'best-practices'
                }
            },
            create: function (context) {
                return {
                    MemberExpression(node) {
                        const objectName = node.object.name;
                        const propertyName = node.property.name;
                        const fileName = context.filename;

                        if (
                            !fileName.endsWith('.node.ts') &&
                            objectName === 'process' &&
                            !node.computed &&
                            propertyName &&
                            propertyName === 'env'
                        ) {
                            context.report({ node, message: `process.env is not allowed in anything but .node files` });
                        }
                    }
                };
            }
        },
        'dont-use-fspath': {
            meta: {
                type: 'problem',
                docs: {
                    description: 'Prevent use of fsPath in non-node files',
                    category: 'best-practices'
                }
            },
            create: function (context) {
                return {
                    MemberExpression(node) {
                        const objectName = node.object.name;
                        const propertyName = node.property.name;
                        const fileName = context.filename;

                        if (
                            !fileName.endsWith('.node.ts') &&
                            !fileName.endsWith('.test.ts') &&
                            !node.computed &&
                            propertyName &&
                            propertyName === 'fsPath'
                        ) {
                            context.report({ node, message: `fsPath is not allowed in anything but .node files` });
                        }
                    }
                };
            }
        },
        'dont-use-filename': {
            meta: {
                type: 'problem',
                docs: {
                    description: 'Prevent use of __dirname and __filename in non-node files',
                    category: 'best-practices'
                }
            },
            create: function (context) {
                return {
                    Identifier(node) {
                        const objectName = node.name;
                        const fileName = context.filename;

                        if (
                            !fileName.endsWith('.node.ts') &&
                            !fileName.endsWith('.test.ts') &&
                            !node.computed &&
                            objectName &&
                            (objectName === '__dirname' || objectName === '__filename')
                        ) {
                            context.report({
                                node,
                                message: `${objectName} is not allowed in anything but .node files`
                            });
                        }
                    }
                };
            }
        },
        'no-for-in': {
            meta: {
                type: 'problem',
                docs: {
                    description: 'Disallow for..in loops',
                    category: 'best-practices'
                }
            },
            create: function (context) {
                return {
                    ForInStatement(node) {
                        context.report({
                            node,
                            message:
                                'for..in loops iterate over the entire prototype chain, which is virtually never what you want. Use Object.{keys,values,entries}, and iterate over the resulting array.'
                        });
                    }
                };
            }
        }
    }
};
