// Substituted at build time from the POSTHOG_API_KEY CI secret (see build/esbuild/build.ts).
declare const POSTHOG_API_KEY_BUILD: string | undefined;

// Substituted at build time from the POSTHOG_CHANNEL env var: 'stable' for main/release builds,
// 'pr' for pull-request builds, 'development' otherwise (see .github/workflows/cd.yml).
declare const POSTHOG_CHANNEL_BUILD: string | undefined;

const POSTHOG_API_KEY_PLACEHOLDER = '__POSTHOG_API_KEY__';

export const POSTHOG_API_KEY =
    typeof POSTHOG_API_KEY_BUILD !== 'undefined' && POSTHOG_API_KEY_BUILD
        ? POSTHOG_API_KEY_BUILD
        : POSTHOG_API_KEY_PLACEHOLDER;
export const POSTHOG_CHANNEL =
    typeof POSTHOG_CHANNEL_BUILD !== 'undefined' && POSTHOG_CHANNEL_BUILD ? POSTHOG_CHANNEL_BUILD : 'development';
export const POSTHOG_HOST = 'https://us.i.posthog.com';

export const IS_POSTHOG_CONFIGURED = POSTHOG_API_KEY !== POSTHOG_API_KEY_PLACEHOLDER && POSTHOG_API_KEY.length > 0;
