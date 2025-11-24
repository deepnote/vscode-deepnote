// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { assert } from 'chai';
import * as sinon from 'sinon';
import { ExperimentationTelemetry } from '../../../platform/common/experiments/telemetry.node';
import { telemetryWrapper } from '../../../platform/telemetry/wrapper';

suite('Experimentation telemetry', () => {
    const event = 'SomeEventName';

    let sandbox: sinon.SinonSandbox;
    let setSharedPropertyStub: sinon.SinonStub;
    let experimentTelemetry: ExperimentationTelemetry;
    let eventProperties: Map<string, string>;

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.replace(
            telemetryWrapper,
            'sendTelemetryEvent',
            sinon.stub().callsFake(() => {
                // Stub for telemetry (now disabled)
            })
        );
        setSharedPropertyStub = sandbox.replace(telemetryWrapper, 'setSharedProperty', sinon.stub()) as sinon.SinonStub;

        eventProperties = new Map<string, string>();
        eventProperties.set('foo', 'one');
        eventProperties.set('bar', 'two');

        experimentTelemetry = new ExperimentationTelemetry();
    });

    teardown(() => {
        sandbox.restore();
    });

    test('Calling postEvent should not throw (telemetry disabled)', () => {
        // Telemetry is now disabled, so we just verify the method doesn't throw
        assert.doesNotThrow(() => {
            experimentTelemetry.postEvent(event, eventProperties);
        });
    });

    test('Shared properties should be set for all telemetry events', () => {
        const shared = { key: 'shared', value: 'three' };

        experimentTelemetry.setSharedProperty(shared.key, shared.value);

        sinon.assert.calledOnce(setSharedPropertyStub);
    });
});
