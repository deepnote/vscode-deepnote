const { isBuiltin } = require('node:module');
const path = require('path');

const testFolder = path.join('src', 'test');

function reportIfMissing(context, node, allowed, name) {
    const fileName = context.filename;
    if (
        allowed.indexOf(name) === -1 &&
        isBuiltin(name) &&
        !fileName.endsWith('.node.ts') &&
        !fileName.endsWith('.test.ts') &&
        !fileName.includes(testFolder)
    ) {
        context.report({ node, message: `Do not import Node.js builtin module "${name}"` });
    }
    // Special case 'path'. Force everything to use the custom path
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
                    description: 'Check for node.js builtins in non-node files',
                    category: 'import'
                },
                schema: [
                    {
                        type: 'object',
                        properties: {
                            allow: {
                                type: 'array',
                                uniqueItems: true,
                                items: {
                                    type: 'string'
                                }
                            }
                        },
                        additionalProperties: false
                    }
                ]
            },
            create: function (context) {
                const options = context.options[0] || {};
                const allowed = options.allow || [];

                // `export { x }` and `export const x = 1` carry no source to check.
                function checkSource(node) {
                    if (node.source) {
                        reportIfMissing(context, node, allowed, node.source.value);
                    }
                }

                return {
                    ImportDeclaration: checkSource,
                    ExportNamedDeclaration: checkSource,
                    ExportAllDeclaration: checkSource,
                    ImportExpression(node) {
                        if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
                            reportIfMissing(context, node, allowed, node.source.value);
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
                            reportIfMissing(context, node, allowed, node.arguments[0].value);
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
