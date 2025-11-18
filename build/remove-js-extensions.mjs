#!/usr/bin/env node
// Script to remove .js extensions from relative imports in TypeScript files
// This is for bundler-based module resolution where extensions are not needed

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rootDir = path.join(__dirname, '..');
const srcDir = path.join(rootDir, 'src');

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

function removeJsExtensions(content) {
    let modified = content;
    let changeCount = 0;

    // Pattern to match relative imports with .js extension
    // Matches: from './foo.js' or from '../bar/index.js'
    // Does NOT match: from 'package-name' or from 'node:fs'
    const patterns = [
        // import ... from './path.js' or '../path.js'
        /(\bfrom\s+['"])(\.\/?[^'"]+)\.js(['"])/g,
        // import('./path.js') or import('../path.js')
        /(\bimport\s*\(\s*['"])(\.\/?[^'"]+)\.js(['"])/g,
    ];

    for (const pattern of patterns) {
        modified = modified.replace(pattern, (match, before, importPath, after) => {
            changeCount++;
            return `${before}${importPath}${after}`;
        });
    }

    return { content: modified, changed: changeCount > 0, changeCount };
}

async function main() {
    console.log('🔍 Finding all TypeScript files in src/...');
    const tsFiles = await getAllTsFiles(srcDir);
    console.log(`📁 Found ${tsFiles.length} TypeScript files\n`);

    let totalFilesChanged = 0;
    let totalExtensionsRemoved = 0;

    for (const file of tsFiles) {
        const content = await fs.readFile(file, 'utf-8');
        const { content: newContent, changed, changeCount } = removeJsExtensions(content);

        if (changed) {
            await fs.writeFile(file, newContent, 'utf-8');
            totalFilesChanged++;
            totalExtensionsRemoved += changeCount;
            const relativePath = path.relative(rootDir, file);
            console.log(`✅ ${relativePath} (${changeCount} extension${changeCount > 1 ? 's' : ''})`);
        }
    }

    console.log(`\n✨ Done!`);
    console.log(`📊 Modified ${totalFilesChanged} files`);
    console.log(`🔗 Removed ${totalExtensionsRemoved} .js extension${totalExtensionsRemoved !== 1 ? 's' : ''}`);
}

main().catch(error => {
    console.error('❌ Error:', error);
    process.exit(1);
});
