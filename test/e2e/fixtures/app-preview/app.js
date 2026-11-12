// Shows on the page what the Deepnote client calls returned, so the E2E test and its screenshots can read them.
function show(id, text) {
    document.getElementById(id).textContent = text;
}

async function call(id, label, fn) {
    try {
        show(id, `${label} resolved: ${JSON.stringify(await fn())}`);
    } catch (error) {
        show(id, `${label} rejected: ${error.message}`);
    }
}

show('client', `client: ${typeof (window.Deepnote && window.Deepnote.connect)}`);
show('styles', `styles: ${getComputedStyle(document.getElementById('title')).color}`);

const logo = document.getElementById('logo');
const showLogo = () => show('logo-status', `logo: ${logo.naturalWidth}x${logo.naturalHeight}`);
if (logo.complete) {
    showLogo();
} else {
    logo.addEventListener('load', showLogo);
}

const connection = window.Deepnote.connect();
const notebook = connection.notebook('e2e-preview-notebook');

(async () => {
    await call('inputs', 'inputs()', () => notebook.inputs());
    await call('inputs-again', 'inputs() again', () => notebook.inputs());
    await call('dataframe', 'dataframe()', () => connection.dataframe('sales'));
    const deepnoteRequests = performance
        .getEntriesByType('resource')
        .filter((entry) => new URL(entry.name).hostname.endsWith('deepnote.com'));
    show('network', `requests to deepnote.com: ${deepnoteRequests.length}`);
})();
