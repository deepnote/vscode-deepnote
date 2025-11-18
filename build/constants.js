// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ExtensionRootDir as _ExtensionRootDir } from './util.js';

export const ExtensionRootDir = _ExtensionRootDir;
export const isWindows = /^win/.test(process.platform);
export const isCI = process.env.TF_BUILD !== undefined || process.env.GITHUB_ACTIONS === 'true';
