// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import path from 'path';
import Lint from 'tslint';
import { ExtensionRootDir } from '../util.js';

export class BaseRuleWalker extends Lint.RuleWalker {
    shouldIgnoreCurrentFile(node, filesToIgnore) {
        const sourceFile = node.getSourceFile();
        if (sourceFile && sourceFile.fileName) {
            const filename = path.resolve(ExtensionRootDir, sourceFile.fileName);
            if (filesToIgnore.indexOf(filename.replace(/\//g, path.sep)) >= 0) {
                return true;
            }
        }
        return false;
    }
}
