// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import fs from 'fs-extra';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

try {
    const file = path.join(__dirname, '..', 'temp', 'jupyter.pid');
    if (fs.existsSync(file)) {
        const pid = parseInt(fs.readFileSync(file).toString().trim());
        fs.unlinkSync(file);
        if (pid > 0) {
            process.kill(pid);
        }
    }
} catch (ex) {
    console.warn(`Failed to kill Jupyter Server`, ex);
}
