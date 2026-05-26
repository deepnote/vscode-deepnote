import { assert } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

// Source files are read at test time because the React component imports `require(*.svg)`
// modules that the unit-test loader cannot resolve. The fallback string and the localized
// string must stay in sync, so the test asserts on both.
const sourceRoot = path.resolve(__dirname, '../../../../src');
const bigQueryFormSourcePath = path.join(sourceRoot, 'webviews/webview-side/integrations/BigQueryForm.tsx');
const localizeSourcePath = path.join(sourceRoot, 'platform/common/utils/localize.ts');

suite('BigQueryForm', () => {
    test('renders the Google OAuth help text with Web-application client and the deepnote.com callback URL', () => {
        // Catches: 'Desktop app' help made users register the wrong OAuth client and Google rejected the redirect.

        // Arrange
        const formSource = fs.readFileSync(bigQueryFormSourcePath, 'utf8');
        const localizeSource = fs.readFileSync(localizeSourcePath, 'utf8');

        // The `getLocString` fallback in the form renders only when the localized collection
        // is missing the key, so the form fallback and the localized string must both encode
        // the corrected guidance.
        const oauthHelpFallbackMatch = formSource.match(
            /getLocString\(\s*'integrationsBigQueryGoogleOauthHelp',\s*("[^"]+"|'[^']+'|`[^`]+`)\s*\)/
        );
        assert.isNotNull(oauthHelpFallbackMatch, 'integrationsBigQueryGoogleOauthHelp fallback not found in form');
        const formFallback = oauthHelpFallbackMatch![1];

        const localizeMatch = localizeSource.match(
            /bigQueryGoogleOauthHelp\s*=\s*l10n\.t\(\s*("[^"]+"|'[^']+'|`[^`]+`)\s*\)/
        );
        assert.isNotNull(localizeMatch, 'bigQueryGoogleOauthHelp not found in localize.ts');
        const localizedString = localizeMatch![1];

        // Act / Assert
        for (const [label, text] of [
            ['form fallback', formFallback],
            ['localized string', localizedString]
        ] as const) {
            assert.include(text, 'Web application', `${label} must mention "Web application" OAuth client`);
            assert.include(
                text,
                '/auth/bigquery/google-oauth-callback',
                `${label} must mention the deepnote.com callback URL`
            );
        }
    });
});
