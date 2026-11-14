import { assert, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { createDeferred } from '../../../platform/common/utils/async';
import { DeepnoteCloudOperationLock } from './deepnoteCloudOperationLock';

use(chaiAsPromised);

suite('DeepnoteCloudOperationLock', () => {
    let lock: DeepnoteCloudOperationLock;

    setup(() => {
        lock = new DeepnoteCloudOperationLock();
    });

    test('calls onBusy instead of running while a run is pending, and runs again once that run resolves', async () => {
        let busyCalls = 0;
        const countBusy = () => busyCalls++;
        const release = createDeferred<string>();
        const first = lock.tryRunExclusive(() => release.promise, countBusy);
        let secondRan = false;

        const second = await lock.tryRunExclusive(async () => (secondRan = true), countBusy);

        assert.deepStrictEqual({ second, secondRan, busyCalls }, { second: undefined, secondRan: false, busyCalls: 1 });

        release.resolve('first');

        assert.strictEqual(await first, 'first');
        assert.strictEqual(await lock.tryRunExclusive(async () => 'third'), 'third');
    });

    test('rejects with the error of a run that rejects, and releases the lock', async () => {
        const error = new Error('publish failed');

        await assert.isRejected(
            lock.tryRunExclusive(() => Promise.reject(error)),
            error
        );
        assert.strictEqual(await lock.tryRunExclusive(async () => 'next'), 'next');
    });
});
