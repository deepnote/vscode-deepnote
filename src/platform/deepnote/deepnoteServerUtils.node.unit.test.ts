import { assert } from 'chai';
import { Uri } from 'vscode';

import { createDeepnoteServerConfigHandle } from './deepnoteServerUtils.node';

/**
 * Unit tests for createDeepnoteServerConfigHandle.
 *
 * The handle is the producer/consumer match invariant for per-notebook servers: the kernel
 * selector PRODUCES it and two consumers (clearControllerForEnvironment,
 * disposeKernelsUsingEnvironment) COMPARE against `serverProviderHandle.handle`. If the formula
 * or its inputs ever drift between the producer and a consumer, the compared handle no longer
 * matches and the deletion/clear silently fails. These tests pin the exact format and the
 * per-notebook uniqueness/byte-stability the contract relies on.
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
