import { databaseIntegrationTypes } from '@deepnote/database-integrations';
import { assert } from 'chai';

import * as localize from '../../common/utils/localize';
import { isConfigurableDatabaseIntegrationType } from './integrationTypes';

suite('integrationTypeLabels', () => {
    test('resolves a label for every configurable type', () => {
        assert.strictEqual(localize.Integrations.typeLabel('pgsql'), 'PostgreSQL');
        assert.strictEqual(localize.Integrations.typeLabel('big-query'), 'Google BigQuery');

        const configurable = databaseIntegrationTypes.filter(isConfigurableDatabaseIntegrationType);
        const unresolved = configurable.filter((type) => !localize.Integrations.typeLabel(type));

        assert.deepStrictEqual(unresolved, [], 'every configurable type needs a label the panel can show');
        assert.strictEqual(Object.keys(localize.Integrations.typeLabels).length, configurable.length);
    });
});
