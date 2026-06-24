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
    test('returns deepnote-config-server-${environmentId}-${notebookUri.toString()} (catches handle-format drift)', () => {
        const uri = Uri.file('/workspace/project/notebook.deepnote');

        assert.strictEqual(
            createDeepnoteServerConfigHandle('env-123', uri),
            `deepnote-config-server-env-123-${uri.toString()}`
        );
    });

    test('two different notebook URIs produce DIFFERENT handles (catches sibling collision)', () => {
        const uriA = Uri.file('/workspace/project/notebook-a.deepnote');
        const uriB = Uri.file('/workspace/project/notebook-b.deepnote');

        assert.notStrictEqual(
            createDeepnoteServerConfigHandle('env-1', uriA),
            createDeepnoteServerConfigHandle('env-1', uriB),
            'sibling notebooks sharing one environment must still get distinct server handles'
        );
    });

    test('same env + same URI yields a BYTE-IDENTICAL handle (producer/consumer match invariant)', () => {
        const uri = Uri.file('/workspace/project/notebook.deepnote');

        // Build two Uri instances for the same path to mimic producer vs. consumer building it
        // independently from `notebook.uri`.
        const produced = createDeepnoteServerConfigHandle('env-9', uri);
        const compared = createDeepnoteServerConfigHandle('env-9', Uri.file('/workspace/project/notebook.deepnote'));

        assert.strictEqual(produced, compared, 'the produced and compared handle must be byte-for-byte identical');
    });

    test('different environmentId for the same notebook produces different handles', () => {
        const uri = Uri.file('/workspace/project/notebook.deepnote');

        assert.notStrictEqual(
            createDeepnoteServerConfigHandle('env-1', uri),
            createDeepnoteServerConfigHandle('env-2', uri)
        );
    });
});
