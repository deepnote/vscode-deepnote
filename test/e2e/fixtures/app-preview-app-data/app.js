// Shows on the page what appData() returned after a run, so the E2E test and its screenshot can read it.
function show(id, text) {
    document.getElementById(id).textContent = text;
}

async function call(id, label, fn) {
    try {
        show(id, `${label}: ${await fn()}`);
    } catch (error) {
        show(id, `${label} rejected: ${error.message}`);
    }
}

const notebook = window.Deepnote.connect().notebook('e2e-runs-notebook');

(async () => {
    await call('run', "run({ region: 'Asia' })", async () => {
        const { run } = await notebook.run({ region: 'Asia' });

        return `${run.status}, created at ${run.createdAt}`;
    });
    await call('after-run', 'appData() after the run', async () => JSON.stringify(await notebook.appData()));
})();
