#!/usr/bin/env node
// Script to fix telemetry import paths

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

function fixTelemetryImports(content) {
    let modified = content;
    let changeCount = 0;

    // Fix: './telemetry/index' -> './telemetry' (top-level telemetry.ts file)
    // Fix: '../telemetry/index' -> '../telemetry'
    // Fix: '../../telemetry/index' -> '../../telemetry' etc.
    const pattern = /(from\s+['"])((?:\.\.?\/)+)telemetry\/index(['"'])/g;
    modified = modified.replace(pattern, (match, before, dots, after) => {
        changeCount++;
        return `${before}${dots}telemetry${after}`;
    });

    // Fix the double path: './platform/telemetry/telemetry/index' -> './platform/telemetry'
    const doublePath = /(from\s+['"])((?:\.\.?\/)+)platform\/telemetry\/telemetry\/index(['"'])/g;
    modified = modified.replace(doublePath, (match, before, dots, after) => {
        changeCount++;
        return `${before}${dots}platform/telemetry${after}`;
    });

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
        const { content: newContent, changed, changeCount } = fixTelemetryImports(content);

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
    console.log(`🔗 Fixed ${totalImportsFixed} telemetry import${totalImportsFixed !== 1 ? 's' : ''}`);
}

main().catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
});
