// Enables the extension's proposed VS Code APIs in the ExTester-managed VS Code instance.
//
// The Deepnote extension declares `enabledApiProposals` in package.json (notebook kernel /
// execution APIs, etc.). VS Code blocks proposed APIs for a normally-installed extension unless
// it is launched in extension-development mode or with `--enable-proposed-api`, neither of which
// ExTester's `setup-and-run` exposes. The supported, black-box-friendly alternative is the
// `extensionEnabledApiProposals` allowlist in the downloaded VS Code's `product.json` — the very
// mechanism stable VS Code uses to allow Microsoft extensions (e.g. ms-python.python) to use
// proposed APIs. This script writes our extension into that allowlist, idempotently.
//
// It must run AFTER VS Code has been downloaded (`extest get-vscode`) and is safe to re-run.
// ExTester caches VS Code under `os.tmpdir()/test-resources` (override with TEST_RESOURCES), and
// `setup-and-run` does not re-extract a cached VS Code, so the patch survives subsequent runs.

const fs = require('fs');
const os = require('os');
const path = require('path');

const extensionManifest = require('../../package.json');

function getStorageFolder() {
    return process.env.TEST_RESOURCES ? process.env.TEST_RESOURCES : path.join(os.tmpdir(), 'test-resources');
}

// Locate `*/resources/app/product.json` under the storage folder across platforms
// (VSCode-linux-x64, VSCode-win32-x64, "Visual Studio Code.app/Contents", …).
function findProductJson(storageFolder) {
    if (!fs.existsSync(storageFolder)) {
        return undefined;
    }

    for (const entry of fs.readdirSync(storageFolder)) {
        const base = path.join(storageFolder, entry);

        for (const candidate of [
            path.join(base, 'resources', 'app', 'product.json'),
            path.join(base, 'Contents', 'Resources', 'app', 'product.json')
        ]) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }

    return undefined;
}

function main() {
    const proposals = extensionManifest.enabledApiProposals;
    if (!Array.isArray(proposals) || proposals.length === 0) {
        console.log('No enabledApiProposals declared in package.json; nothing to do.');
        return;
    }

    const storageFolder = getStorageFolder();
    const productJsonPath = findProductJson(storageFolder);
    if (!productJsonPath) {
        console.error(
            `Could not find a VS Code product.json under ${storageFolder}. ` +
                `Download VS Code first (e.g. \`npm run setup:e2e:vscode\`), then re-run this script.`
        );
        process.exit(1);
    }

    const product = JSON.parse(fs.readFileSync(productJsonPath, 'utf8'));
    product.extensionEnabledApiProposals = product.extensionEnabledApiProposals || {};

    // Match on the canonical id and its lowercase form: VS Code compares extension ids
    // case-insensitively (ExtensionIdentifier.toKey lowercases), and our publisher is capitalized.
    const extensionId = `${extensionManifest.publisher}.${extensionManifest.name}`;
    for (const id of new Set([extensionId, extensionId.toLowerCase()])) {
        product.extensionEnabledApiProposals[id] = proposals;
    }

    fs.writeFileSync(productJsonPath, `${JSON.stringify(product, null, '\t')}\n`);

    console.log(`Enabled proposed APIs for ${extensionId} in ${productJsonPath}`);
    console.log(`Proposals: ${proposals.join(', ')}`);
}

main();
