const notebook = window.Deepnote.connect().notebook('e2e-runs-notebook');
const status = document.getElementById('status');
const result = document.getElementById('result');

document.getElementById('run').addEventListener('click', async () => {
    status.textContent = 'running';
    result.textContent = '';
    try {
        const { run, result: runResult } = await notebook.run({ region: document.getElementById('region').value });
        status.textContent = `${run.status}${run.error ? `, ${run.error}` : ''}`;
        result.textContent = JSON.stringify(runResult());
    } catch (error) {
        status.textContent = `rejected: ${error.message}`;
    }
});
