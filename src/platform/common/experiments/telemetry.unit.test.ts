// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { assert } from 'chai';
import * as sinon from 'sinon';
import { ExperimentationTelemetry } from '../../../platform/common/experiments/telemetry.node';
import * as Telemetry from '../../../platform/telemetry/index';

suite('Experimentation telemetry', () => {
    const event = 'SomeEventName';

    let telemetryEvents: { eventName: string; properties: object }[] = [];
    let sendTelemetryEventStub: sinon.SinonStub;
    let setSharedPropertyStub: sinon.SinonStub;
    let experimentTelemetry: ExperimentationTelemetry;
    let eventProperties: Map<string, string>;

    setup(() => {
        sendTelemetryEventStub = sinon
            .stub(Telemetry, 'sendTelemetryEvent')
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .callsFake((eventName: string, _, properties: any) => {
                const telemetry = { eventName, properties };
                telemetryEvents.push(telemetry);
            });
        setSharedPropertyStub = sinon.stub(Telemetry, 'setSharedProperty');

        eventProperties = new Map<string, string>();
        eventProperties.set('foo', 'one');
        eventProperties.set('bar', 'two');

        experimentTelemetry = new ExperimentationTelemetry();
    });

    teardown(() => {
        telemetryEvents = [];
        sinon.restore();
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
