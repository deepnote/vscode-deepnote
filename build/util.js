// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const ExtensionRootDir = path.dirname(__dirname);

export function getListOfFiles(filename) {
    filename = path.normalize(filename);
    if (!path.isAbsolute(filename)) {
        filename = path.join(__dirname, filename);
    }
    const data = fs.readFileSync(filename).toString();
    const files = JSON.parse(data);
    return files.map((file) => {
        return path.join(ExtensionRootDir, file.replace(/\//g, path.sep));
    });
}
