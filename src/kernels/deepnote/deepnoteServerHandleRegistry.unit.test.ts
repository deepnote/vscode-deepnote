import { assert } from 'chai';

import { ServerHandleRegistry } from './deepnoteServerHandleRegistry.node';

suite('ServerHandleRegistry', () => {
    let registry: ServerHandleRegistry;

    setup(() => {
        registry = new ServerHandleRegistry();
    });

    test('get returns undefined for a key that was never set', () => {
        assert.strictEqual(registry.get('file:///unknown.deepnote'), undefined);
    });

    test('set then get returns the stored handle', () => {
        registry.set('file:///nb.deepnote', 'handle-1');

        assert.strictEqual(registry.get('file:///nb.deepnote'), 'handle-1');
    });

    test('set overwrites the handle previously stored for a key', () => {
        registry.set('file:///nb.deepnote', 'handle-1');
        registry.set('file:///nb.deepnote', 'handle-2');

        assert.strictEqual(registry.get('file:///nb.deepnote'), 'handle-2');
    });

    test('handles for different keys do not collide', () => {
        registry.set('file:///a.deepnote', 'handle-a');
        registry.set('file:///b.deepnote', 'handle-b');

        assert.strictEqual(registry.get('file:///a.deepnote'), 'handle-a');
        assert.strictEqual(registry.get('file:///b.deepnote'), 'handle-b');
    });
});
