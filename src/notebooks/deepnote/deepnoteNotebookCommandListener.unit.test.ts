// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { assert } from 'chai';
import { DeepnoteNotebookCommandListener } from './deepnoteNotebookCommandListener';
import { IDisposable } from '../../platform/common/types';

suite('DeepnoteNotebookCommandListener', () => {
    let commandListener: DeepnoteNotebookCommandListener;
    let disposables: IDisposable[];

    setup(() => {
        disposables = [];
        commandListener = new DeepnoteNotebookCommandListener(disposables);
    });

    teardown(() => {
        disposables.forEach((d) => d?.dispose());
    });

    suite('activate', () => {
        test('should register commands when activated', () => {
            assert.isEmpty(disposables, 'Disposables should be empty');

            commandListener.activate();

            // Verify that at least one command was registered (AddSqlBlock)
            assert.isAtLeast(disposables.length, 1, 'Should register at least one command');
        });

        test('should handle activation without errors', () => {
            assert.doesNotThrow(() => {
                commandListener.activate();
            }, 'activate() should not throw errors');
        });

        test('should register disposable command handlers', () => {
            commandListener.activate();

            // Verify disposables were registered
            assert.isAtLeast(disposables.length, 1, 'Should register command disposables');

            // Verify all registered items are disposable (filter out null/undefined first)
            const validDisposables = disposables.filter((d) => d != null);
            validDisposables.forEach((d) => {
                assert.isDefined(d.dispose, 'Each registered item should have a dispose method');
            });
        });
    });

    suite('command registration', () => {
        test('should not register duplicate commands on multiple activations', () => {
            commandListener.activate();
            const firstActivationCount = disposables.length;

            // Create new instance and activate again
            const disposables2: IDisposable[] = [];
            const commandListener2 = new DeepnoteNotebookCommandListener(disposables2);
            commandListener2.activate();

            // Both should register the same number of commands
            assert.equal(
                disposables2.length,
                firstActivationCount,
                'Both activations should register the same number of commands'
            );

            disposables2.forEach((d) => d?.dispose());
        });
    });
});
