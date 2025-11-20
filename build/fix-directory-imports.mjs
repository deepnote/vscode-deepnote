#!/usr/bin/env node
// Script to fix directory imports - convert './foo' to './foo/index.js' where foo is a directory

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rootDir = path.join(__dirname, '..');
const srcDir = path.join(rootDir, 'src');

// Known directory imports that need to be converted to /index.js
const directoryImports = [
    'platform/logging',
    'telemetry',
    'platform/pythonEnvironments/info',
    'standalone/api'
];

async function getAllTsFiles(dir) {
    const files = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            if (!['node_modules', 'out', 'dist', '.git', '.vscode', 'resources'].includes(entry.name)) {
                files.push(...(await getAllTsFiles(fullPath)));
            }
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
            files.push(fullPath);
        }
    }

    return files;
}

function fixDirectoryImports(content) {
    let modified = content;
    let changeCount = 0;

    for (const dirImport of directoryImports) {
        // Match imports with any relative path prefix (./, ../, ../../foo/, etc.)
        // Captures: quote, prefix (e.g., './', '../../'), directoryImport, '.js', quote
        const pattern = new RegExp(`(['"])((?:\\.\\.\\/|\\.\\/)(?:.*\\/)?)${dirImport}\\.js(['"])`, 'g');

        const newModified = modified.replace(pattern, (match, quote1, prefix, quote2) => {
            changeCount++;
            return `${quote1}${prefix}${dirImport}/index.js${quote2}`;
        });
        modified = newModified;
    }

    return { content: modified, changed: changeCount > 0, changeCount };
}

async function main() {
    console.log('🔍 Finding all TypeScript files in src/...');
    const tsFiles = await getAllTsFiles(srcDir);
    console.log(`📁 Found ${tsFiles.length} TypeScript files\n`);

    let totalFilesChanged = 0;
    let totalImportsFixed = 0;

    for (const file of tsFiles) {
        const content = await fs.readFile(file, 'utf-8');
        const { content: newContent, changed, changeCount } = fixDirectoryImports(content);

        if (changed) {
            await fs.writeFile(file, newContent, 'utf-8');
            totalFilesChanged++;
            totalImportsFixed += changeCount;
            const relativePath = path.relative(rootDir, file);
            console.log(`✅ ${relativePath} (${changeCount} import${changeCount > 1 ? 's' : ''})`);
        }
    }

    console.log(`\n✨ Done!`);
    console.log(`📊 Modified ${totalFilesChanged} files`);
    console.log(`🔗 Fixed ${totalImportsFixed} directory import${totalImportsFixed !== 1 ? 's' : ''}`);
}

main().catch(error => {
    console.error('❌ Error:', error);
    process.exit(1);
});
