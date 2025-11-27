// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/* eslint-disable local-rules/dont-use-filename */

import * as path from '../../platform/vscode-path/path';
import { getDirname } from '../../platform/common/esmUtils.node';

const __dirname = getDirname(import.meta.url);

export const TEST_LAYOUT_ROOT = path.join(__dirname, '..', '..', '..', 'src', 'test', 'pythonEnvironments', 'common', 'envlayouts');

export const TEST_DATA_ROOT = path.join(__dirname, '..', '..', '..', 'src', 'test', 'pythonEnvironments', 'common', 'testdata');
