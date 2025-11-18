#!/usr/bin/env node
// Script to add .js extensions to all relative imports in TypeScript files
// This is required for ESM compatibility

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rootDir = path.join(__dirname, '..');
const srcDir = path.join(rootDir, 'src');

// Regex patterns to match import statements with relative paths
const importPatterns = [
    // import ... from './path' or '../path'
    /^(\s*import\s+.+\s+from\s+['"])(\.\/.+?|\.\.?\/.+?)(['"])/gm,
    // export ... from './path' or '../path'
    /^(\s*export\s+.+\s+from\s+['"])(\.\/.+?|\.\.?\/.+?)(['"])/gm,
    // import('./path') or import('../path')
    /(\bimport\s*\(\s*['"])(\.\/.+?|\.\.?\/.+?)(['"])/gm,
    // await import('./path')
    /(\bawait\s+import\s*\(\s*['"])(\.\/.+?|\.\.?\/.+?)(['"])/gm,
];

async function getAllTsFiles(dir) {
    const files = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            // Skip node_modules, out, dist, etc.
            if (!['node_modules', 'out', 'dist', '.git', '.vscode', 'resources'].includes(entry.name)) {
                files.push(...(await getAllTsFiles(fullPath)));
            }
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
            files.push(fullPath);
        }
    }

    return files;
}

function addJsExtension(content) {
    let modified = content;
    let changeCount = 0;

    for (const pattern of importPatterns) {
        modified = modified.replace(pattern, (match, before, importPath, after) => {
            // Skip if already has an extension
            if (/\.(js|ts|tsx|json|css|less|svg|png|jpg)$/i.test(importPath)) {
                return match;
            }

            changeCount++;
            return `${before}${importPath}.js${after}`;
        });
    }

    return { content: modified, changed: changeCount > 0, changeCount };
}

async function main() {
    console.log('🔍 Finding all TypeScript files in src/...');
    const tsFiles = await getAllTsFiles(srcDir);
    console.log(`📁 Found ${tsFiles.length} TypeScript files\n`);

    let totalFilesChanged = 0;
    let totalImportsChanged = 0;

    for (const file of tsFiles) {
        const content = await fs.readFile(file, 'utf-8');
        const { content: newContent, changed, changeCount } = addJsExtension(content);

        if (changed) {
            await fs.writeFile(file, newContent, 'utf-8');
            totalFilesChanged++;
            totalImportsChanged += changeCount;
            const relativePath = path.relative(rootDir, file);
            console.log(`✅ ${relativePath} (${changeCount} import${changeCount > 1 ? 's' : ''})`);
        }
    }

    console.log(`\n✨ Done!`);
    console.log(`📊 Modified ${totalFilesChanged} files`);
    console.log(`🔗 Updated ${totalImportsChanged} import statements`);
}

main().catch(error => {
    console.error('❌ Error:', error);
    process.exit(1);
});
