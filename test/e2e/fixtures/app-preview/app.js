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

function inputControl(input) {
    if (input.type === 'input-select') {
        const select = document.createElement('select');
        select.multiple = input.multiple;
        const selected = [].concat(input.value);
        for (const option of input.options) {
            select.add(new Option(option, option, false, selected.includes(option)));
        }

        return select;
    }

    const control = document.createElement('input');
    if (input.type === 'input-slider') {
        Object.assign(control, { type: 'range', min: input.min, max: input.max, step: input.step });
    }
    control.value = input.value;

    return control;
}

/** Builds a form from the inputs, the way an app would, so the screenshots show them. */
function renderInputs(inputs) {
    const form = document.getElementById('inputs-form');
    for (const input of inputs) {
        const label = document.createElement('label');
        label.append(`${input.label || input.name} `, inputControl(input));
        if (input.type === 'input-slider') {
            label.append(` ${input.value} (${input.min} to ${input.max} by ${input.step})`);
        }
        form.append(label);
    }
}

const connection = window.Deepnote.connect();
const notebook = connection.notebook('e2e-preview-notebook');

(async () => {
    await call('inputs', 'inputs()', async () => {
        const inputs = await notebook.inputs();
        renderInputs(inputs);

        return inputs;
    });
    await call('missing-inputs', 'inputs() of an unknown notebook', () =>
        connection.notebook('e2e-missing-notebook').inputs()
    );
    await call('app-data', 'appData()', () => notebook.appData());
    await call('app-data-again', 'appData() again', () => notebook.appData());
    await call('dataframe', 'dataframe()', () => connection.dataframe('sales'));
    const deepnoteRequests = performance
        .getEntriesByType('resource')
        .filter((entry) => new URL(entry.name).hostname.endsWith('deepnote.com'));
    show('network', `requests to deepnote.com: ${deepnoteRequests.length}`);
})();
