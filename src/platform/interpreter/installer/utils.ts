// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { WrappedError } from '../../errors/types';
import { DEEPNOTE_TOOLKIT_PACKAGES, DEEPNOTE_TOOLKIT_VERSION } from '../../common/constants';
import { Product } from './types';

// Licensed under the MIT License.
export function translateProductToModule(product: Product): string {
    switch (product) {
        case Product.jupyter:
            return 'jupyter';
        case Product.notebook:
            return 'notebook';
        case Product.pandas:
            return 'pandas';
        case Product.ipykernel:
            return 'ipykernel';
        case Product.nbconvert:
            return 'nbconvert';
        case Product.kernelspec:
            return 'kernelspec';
        case Product.pip:
            return 'pip';
        case Product.ensurepip:
            return 'ensurepip';
        case Product.deepnoteToolkit:
            return 'deepnote_toolkit';
        default: {
            throw new WrappedError(
                `Product ${product} cannot be installed as a Python Module.`,
                undefined,
                'unknownProduct'
            );
        }
    }
}

// deepnote_toolkit's import name differs from its pip distribution name. The [server] extra pins
// the deepnote-python-lsp-server fork of pylsp; the spec repeats that pin as a direct requirement
// with the fork's own [all] extras so the editor's `python -m pylsp` gets its linting plugins.
// Installing upstream python-lsp-server alongside the fork would write the same `pylsp` module twice,
// and uv only honours a pre-release pin like 1.13.1rc2 when it appears on a direct requirement.
// Keep the spec's pin identical to the toolkit's when bumping `version`.
export function translateModuleToPackages(moduleName: string): string[] {
    switch (moduleName) {
        case translateProductToModule(Product.deepnoteToolkit):
            return [`deepnote-toolkit[server]==${DEEPNOTE_TOOLKIT_VERSION}`, ...DEEPNOTE_TOOLKIT_PACKAGES];
        default:
            return [moduleName];
    }
}
