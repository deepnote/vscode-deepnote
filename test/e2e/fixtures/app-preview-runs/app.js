// Shows on the page what run() returned, so the E2E test and its screenshots can read it.
function show(id, text) {
    document.getElementById(id).textContent = text;
}

const notebook = window.Deepnote.connect().notebook('e2e-runs-notebook');

async function showRun(id, label, inputs) {
    try {
        const { run, result } = await notebook.run(inputs);
        show(`${id}-status`, `${label}: ${run.status}${run.error ? `, ${run.error}` : ''}`);
        show(`${id}-result`, `${label} result(): ${JSON.stringify(result())}`);
    } catch (error) {
        show(`${id}-status`, `${label} rejected: ${error.message}`);
        show(`${id}-result`, `${label} result(): none`);
    }
}

(async () => {
    try {
        await notebook.run({ unknown: 'x' });
        show('unknown-input', "run({ unknown: 'x' }) resolved");
    } catch (error) {
        show('unknown-input', `run({ unknown: 'x' }) rejected: ${error.message}`);
    }
    await showRun('asia', "run({ region: 'Asia' })", { region: 'Asia' });
    await showRun('empty', "run({ region: '' })", { region: '' });
})();
