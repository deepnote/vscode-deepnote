// Substituted at build time from the POSTHOG_API_KEY CI secret (see build/esbuild/build.ts).
// Left undefined in local builds, where telemetry falls back to this inert placeholder.
declare const POSTHOG_API_KEY_BUILD: string | undefined;

const POSTHOG_API_KEY_PLACEHOLDER = '__POSTHOG_API_KEY__';

export const POSTHOG_API_KEY =
    typeof POSTHOG_API_KEY_BUILD !== 'undefined' && POSTHOG_API_KEY_BUILD
        ? POSTHOG_API_KEY_BUILD
        : POSTHOG_API_KEY_PLACEHOLDER;
export const POSTHOG_HOST = 'https://us.i.posthog.com';

// Guards against initializing PostHog with the inert placeholder key in local/unconfigured builds.
export const IS_POSTHOG_CONFIGURED = POSTHOG_API_KEY !== POSTHOG_API_KEY_PLACEHOLDER && POSTHOG_API_KEY.length > 0;
