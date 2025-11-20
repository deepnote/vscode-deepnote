// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import path from 'node:path';
import jupyterServer from '../out/test/datascience/jupyterServer.node';
import fs from 'fs-extra';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function startJupyter(detached) {
    const server = jupyterServer.JupyterServer.instance;
    // Need to start jupyter here before starting the test as it requires node to start it.
    const uri = await server.startJupyterWithToken({ detached });

    // Use this token to write to the bundle so we can transfer this into the test.
    const extensionDevelopmentPath = path.resolve(__dirname, '../');
    const bundlePath = path.join(extensionDevelopmentPath, 'out', 'extension.web.bundle');
    const bundleFile = `${bundlePath}.js`;
    if (await fs.pathExists(bundleFile)) {
        const bundleContents = await fs.readFile(bundleFile, { encoding: 'utf-8' });
        const newContents = bundleContents.replace(
            /^(\s*)JUPYTER_SERVER_URI = ["'](.*)["'];$/gm,
            `$1JUPYTER_SERVER_URI = '${uri.toString()}';`
        );
        if (newContents === bundleContents) {
            throw new Error('JUPYTER_SERVER_URI in bundle not updated');
        }
        await fs.writeFile(bundleFile, newContents);
    }
    return { server, url: uri.toString() };
}
