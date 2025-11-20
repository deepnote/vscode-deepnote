// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import fs from 'fs-extra';
import path from 'node:path';
import { startJupyter } from './preLaunchWebTest.js';
import jsonc from 'jsonc-parser';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const settingsFile = path.join(__dirname, '..', 'src', 'test', 'datascience', '.vscode', 'settings.json');

async function go() {
    let url = process.env.EXISTING_JUPYTER_URI;
    if (!url) {
        const info = await startJupyter(true);

        url = info.url;

        const tempDir = path.join(__dirname, '..', 'temp');

        await fs.ensureDir(tempDir);

        fs.writeFileSync(path.join(__dirname, '..', 'temp', 'deepnote.pid'), info.server.pid.toString());
    } else {
        console.log('Jupyter server URL provided in env args, no need to start one');
    }
    const settingsJson = fs.readFileSync(settingsFile).toString();
    const edits = jsonc.modify(settingsJson, ['deepnote.DEBUG_JUPYTER_SERVER_URI'], url, {});
    const updatedSettingsJson = jsonc.applyEdits(settingsJson, edits);
    fs.writeFileSync(settingsFile, updatedSettingsJson);
    process.exit(0);
}

void go();
