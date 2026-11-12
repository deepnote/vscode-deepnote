// Loaded by app pages through the preview server's swapped `<script src="/__deepnote/client.js">` tag, as a classic
// script, so `document.currentScript` is that tag while this runs.

import { createDeepnoteClient } from './deepnoteClient';

const script = document.currentScript;

Object.assign(window, {
    Deepnote: createDeepnoteClient(
        {
            token: script?.getAttribute('data-deepnote-token') ?? undefined,
            projectId: script?.getAttribute('data-deepnote-project-id') ?? undefined,
            apiBaseUrl: new URL('/__deepnote/v2', location.origin).href
        },
        {
            fetch: window.fetch.bind(window),
            now: Date.now,
            sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))
        }
    )
});
