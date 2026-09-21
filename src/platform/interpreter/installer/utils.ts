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

// deepnote_toolkit's import name differs from its pip distribution name. The [server] extra pins the
// pylsp fork without its own [all] extras, so the spec repeats that pin with [all] to get the linting
// plugins; it has to stay in step with the toolkit's own pin.
export function translateModuleToPackages(moduleName: string): string[] {
    switch (moduleName) {
        case translateProductToModule(Product.deepnoteToolkit):
            return [`deepnote-toolkit[server]==${DEEPNOTE_TOOLKIT_VERSION}`, ...DEEPNOTE_TOOLKIT_PACKAGES];
        default:
            return [moduleName];
    }
}
