import { assert } from 'chai';
import { Uri } from 'vscode';

import { createDeepnoteServerConfigHandle } from './deepnoteServerUtils.node';

/**
 * The handle is a producer/consumer match invariant: if its formula drifts between the kernel
 * selector (producer) and the clear/dispose consumers, handles stop matching and cleanup silently no-ops.
 */
suite('DeepnoteServerUtils - createDeepnoteServerConfigHandle', () => {
    test('two different notebook URIs produce DIFFERENT handles (catches sibling collision)', () => {
        const uriA = Uri.file('/workspace/project/notebook-a.deepnote');
        const uriB = Uri.file('/workspace/project/notebook-b.deepnote');

        assert.notStrictEqual(
            createDeepnoteServerConfigHandle('env-1', uriA),
            createDeepnoteServerConfigHandle('env-1', uriB),
            'sibling notebooks sharing one environment must still get distinct server handles'
        );
    });
});
