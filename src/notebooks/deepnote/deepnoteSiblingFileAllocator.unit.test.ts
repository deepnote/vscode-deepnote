import { assert } from 'chai';
import { Uri } from 'vscode';

import { allocateSiblingUri, MAX_SIBLING_ALLOCATION_ATTEMPTS } from './deepnoteSiblingFileAllocator';

/**
 * Tests for the shared, collision-safe sibling-file allocator (§0).
 *
 * The allocator is the SINGLE filesystem-aware filename-allocation code path shared by the
 * splitter (§2) and the notebook file factory (§3). These tests exercise the REAL allocator
 * against an INJECTED `exists` probe, so no `workspace.fs` mocking is needed.
 */
suite('DeepnoteSiblingFileAllocator (allocateSiblingUri)', () => {
    const parentDir = Uri.file('/workspace/project');

    /** Build an `exists` probe that reports the given set of basenames (within parentDir) as present. */
    function existsFor(existingBasenames: string[]): (uri: Uri) => Promise<boolean> {
        const present = new Set(existingBasenames);

        return (uri: Uri) => Promise.resolve(present.has(uri.path.split('/').pop() ?? ''));
    }

    test('returns desiredFilename verbatim when nothing exists (regression: must not suffix a free name)', async () => {
        const result = await allocateSiblingUri(parentDir, 'report.deepnote', existsFor([]));

        assert.deepStrictEqual(result, Uri.joinPath(parentDir, 'report.deepnote'));
    });

    test('bumps to name-2 then name-3 as exists reports clashes (regression: must walk past every taken name)', async () => {
        // Only `report.deepnote` taken -> first free is `report-2.deepnote`.
        const second = await allocateSiblingUri(parentDir, 'report.deepnote', existsFor(['report.deepnote']));
        assert.deepStrictEqual(second, Uri.joinPath(parentDir, 'report-2.deepnote'));

        // `report.deepnote` AND `report-2.deepnote` taken -> first free is `report-3.deepnote`.
        const third = await allocateSiblingUri(
            parentDir,
            'report.deepnote',
            existsFor(['report.deepnote', 'report-2.deepnote'])
        );
        assert.deepStrictEqual(third, Uri.joinPath(parentDir, 'report-3.deepnote'));
    });

    test('suffixes the WHOLE base before .deepnote, not the first-dot stem (regression: report.backup -> report.backup-2)', async () => {
        const result = await allocateSiblingUri(
            parentDir,
            'report.backup.deepnote',
            existsFor(['report.backup.deepnote'])
        );

        // If the allocator suffixed the first-dot stem it would produce `report-2.backup.deepnote`
        // (and could clobber a sibling named `report-2...`); it must suffix the whole basename.
        assert.deepStrictEqual(result, Uri.joinPath(parentDir, 'report.backup-2.deepnote'));
    });

    test('respects an in-batch reserved set even when exists is false, and adds the chosen name to reserved (regression: two un-written siblings must not collide)', async () => {
        const reserved = new Set<string>();

        // First allocation: nothing on disk, nothing reserved -> takes the desired name and reserves it.
        const first = await allocateSiblingUri(parentDir, 'nb.deepnote', existsFor([]), reserved);
        assert.deepStrictEqual(first, Uri.joinPath(parentDir, 'nb.deepnote'));
        assert.isTrue(reserved.has('nb.deepnote'), 'chosen name must be added to reserved');

        // Second allocation of the SAME desired name: `nb.deepnote` is free on disk (exists=false)
        // but is reserved from the first pass, so it must be skipped and bumped to `nb-2.deepnote`.
        const second = await allocateSiblingUri(parentDir, 'nb.deepnote', existsFor([]), reserved);
        assert.deepStrictEqual(second, Uri.joinPath(parentDir, 'nb-2.deepnote'));
        assert.isTrue(reserved.has('nb-2.deepnote'), 'second chosen name must also be reserved');
    });

    test('throws after MAX_SIBLING_ALLOCATION_ATTEMPTS when everything clashes (regression: must not loop forever)', async () => {
        // `exists` always true -> every candidate clashes -> must throw, not hang.
        const alwaysExists = () => Promise.resolve(true);

        let threw = false;
        try {
            await allocateSiblingUri(parentDir, 'taken.deepnote', alwaysExists);
        } catch (error) {
            threw = true;
            assert.include(
                (error as Error).message,
                String(MAX_SIBLING_ALLOCATION_ATTEMPTS),
                'error should mention the attempt cap'
            );
        }

        assert.isTrue(threw, 'allocateSiblingUri should throw when no free name can be found');
    });
});
