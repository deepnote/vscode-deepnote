import * as crypto from 'crypto';
import express, { type Express, type Request, type Response } from 'express';
import * as http from 'http';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { type AddressInfo } from 'net';
import { CancellationError, CancellationToken } from 'vscode';

import { logger } from '../../../../platform/logging';

/**
 * Default deadline for the entire OAuth flow, measured from the moment the
 * loopback server starts listening. The user has 5 minutes to complete the
 * browser consent flow; after that the loopback server is torn down and the
 * promise rejects with a timeout error.
 *
 * Long enough to accommodate Google account-switcher interactions on a
 * mobile device; short enough that a forgotten flow doesn't tie up a port
 * indefinitely.
 */
export const OAUTH_FLOW_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Inputs for {@link runOAuthFlow}.
 *
 * The strategy + completion pair must come from
 * {@link buildBigQueryGoogleOAuthStrategy} (or an equivalent builder that
 * captures the refresh token via its internal verify closure). We do not
 * accept a separate verify here — production review found that splitting
 * the verify across the call site and the builder made it too easy to
 * forget wiring it (#6 in the plan).
 *
 * `onListening` is invoked once with the user-facing start URL after the
 * loopback server has bound a random port. The caller is expected to
 * launch the user's browser at that URL (typically via
 * `vscode.env.openExternal(env.asExternalUri(...))`).
 *
 * `timeoutMs` overrides {@link OAUTH_FLOW_TIMEOUT_MS}. It exists primarily
 * as a test seam — production callers should leave it undefined.
 */
export interface RunOAuthFlowParams {
    completion: Promise<{ refreshToken: string }>;
    integrationId: string;
    onListening: (startUrl: string) => Promise<void>;
    strategy: GoogleStrategy;
    timeoutMs?: number;
    token: CancellationToken;
}

/**
 * Runs the loopback OAuth flow. Returns when the user completes consent
 * (resolves with the captured refresh token) or rejects on cancellation,
 * timeout, or an OAuth error.
 *
 * Implementation outline (matches plan Step 5):
 *   - Creates an `express` app, mounts /auth/start + /auth/callback.
 *   - Boots an `http.createServer` on `0.0.0.0`-style ephemeral port via
 *     `listen(0, '127.0.0.1')`. Once listening, computes the callback URL
 *     using the bound port and patches it onto the strategy.
 *   - Registers the strategy under a per-flow random name so concurrent
 *     flows can coexist.
 *   - Invokes `params.onListening(startUrl)` so the caller can launch the
 *     user's browser.
 *   - Awaits whichever resolves first: the verify-driven `completion`,
 *     cancellation, or the timeout.
 *   - Cleans up unconditionally: closes the server, removes the strategy
 *     from passport, and clears the timeout.
 */
export async function runOAuthFlow(params: RunOAuthFlowParams): Promise<{ refreshToken: string }> {
    const strategyName = `deepnote-google-oauth-${crypto.randomBytes(8).toString('hex')}`;
    const timeoutMs = params.timeoutMs ?? OAUTH_FLOW_TIMEOUT_MS;

    const app: Express = express();
    const server = http.createServer(app);

    let cancellationSubscription: { dispose(): void } | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
        passport.use(strategyName, params.strategy);

        // Bind to 127.0.0.1 only — Google's "Desktop app" OAuth clients accept
        // loopback redirects only on the loopback interface.
        server.listen(0, '127.0.0.1');

        const listening = new Promise<number>((resolve, reject) => {
            // Forward-declared as `let` so each handler can reference the other
            // for `removeListener`. We could nest them but the lint rule for
            // use-before-define would catch either ordering.
            let onError: (err: Error) => void = () => undefined;
            let onListening: () => void = () => undefined;
            onError = (err: Error) => {
                server.removeListener('listening', onListening);
                reject(err);
            };
            onListening = () => {
                server.removeListener('error', onError);
                const address = server.address() as AddressInfo | null;
                if (!address || typeof address === 'string') {
                    reject(new Error('Loopback server did not bind a port.'));
                    return;
                }
                resolve(address.port);
            };
            server.once('error', onError);
            server.once('listening', onListening);
        });

        const port = await listening;
        const callbackURL = `http://127.0.0.1:${port}/auth/callback`;
        const startUrl = `http://127.0.0.1:${port}/auth/start`;

        // Override the placeholder `callbackURL` baked into the strategy. The
        // strategy uses the configured `callbackURL` when generating the
        // authorize redirect AND when exchanging the code at the token
        // endpoint (redirect_uri must match). Mutating this field is the
        // upstream-supported way of patching the strategy after listen(0).
        (params.strategy as unknown as { _callbackURL: string })._callbackURL = callbackURL;

        // Routes — must be registered after listen(), but before
        // onListening() returns control to the caller (otherwise the user's
        // browser races us).
        //
        // /auth/start kicks off the authorize redirect with the
        // Google-specific accessType=offline + prompt=consent options so we
        // get a refresh token even if the user has previously authorized
        // this OAuth client. passport-google-oauth20 forwards these into
        // the authorize URL natively (see strategy.js:138-143).
        app.get(
            '/auth/start',
            passport.authenticate(strategyName, {
                session: false,
                accessType: 'offline',
                prompt: 'consent'
            } as Parameters<typeof passport.authenticate>[1])
        );

        // /auth/callback runs the verify closure built by
        // buildBigQueryGoogleOAuthStrategy. The closure resolves the
        // `completion` promise on success and rejects on missing refresh
        // token. We render a success page on success and an error page on
        // failure — passport invokes the express error middleware on
        // failures, so we attach one below.
        app.get(
            '/auth/callback',
            passport.authenticate(strategyName, { session: false } as Parameters<typeof passport.authenticate>[1]),
            (_req: Request, res: Response) => {
                res.status(200).send(renderSuccessPage());
            }
        );

        // Express error handler — any error thrown by the passport
        // middleware or our routes lands here. We render an inline HTML
        // error page with the message so the user sees something
        // intelligible in their browser. The promise rejection comes from
        // the verify closure separately.
        app.use((err: unknown, _req: Request, res: Response, _next: unknown) => {
            const message = err instanceof Error ? err.message : 'Authentication failed.';
            logger.error('OAuth loopback flow rendered error page.', err);
            res.status(400).send(renderErrorPage(message));
        });

        // Set up cancellation + timeout BEFORE invoking onListening, so a
        // synchronous-or-fast cancellation inside the caller's onListening
        // handler is observed. (We can't rely on the token's listener
        // catching up after the fact — VSCode's EventEmitter does not
        // replay past fires to late subscribers.)
        const cancellationPromise = new Promise<never>((_, reject) => {
            if (params.token.isCancellationRequested) {
                reject(new CancellationError());
                return;
            }
            cancellationSubscription = params.token.onCancellationRequested(() => {
                reject(new CancellationError());
            });
        });
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
                reject(new Error(`OAuth flow timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
            }, timeoutMs);
        });

        await params.onListening(startUrl);

        const result = await Promise.race<{ refreshToken: string }>([
            params.completion,
            timeoutPromise,
            cancellationPromise
        ]);

        return result;
    } finally {
        if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
        }
        if (cancellationSubscription !== undefined) {
            cancellationSubscription.dispose();
        }
        // `closeAllConnections` is required when long-poll/streaming clients
        // are connected — passport's redirect flow uses short-lived
        // connections in practice, but if the user closes the browser tab
        // mid-flow, this prevents the server from hanging on a half-open
        // TCP connection.
        if (typeof (server as { closeAllConnections?: () => void }).closeAllConnections === 'function') {
            (server as { closeAllConnections: () => void }).closeAllConnections();
        }
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
        passport.unuse(strategyName);
    }
}

/**
 * Inline-CSS success page rendered to the user's browser after consent.
 * The user can close the tab and return to VS Code.
 */
function renderSuccessPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Authentication succeeded</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f4f6fa;
      color: #1f2937;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #ffffff;
      border-radius: 12px;
      padding: 32px 40px;
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
      max-width: 480px;
    }
    h1 { margin-top: 0; font-size: 1.5rem; }
    p { line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authentication succeeded.</h1>
    <p>You can close this window and return to VS Code.</p>
  </div>
</body>
</html>`;
}

/**
 * Inline-CSS error page rendered to the user's browser when the OAuth
 * flow fails — exposes the underlying message so the user can act on it
 * (e.g. "Revoke the app at myaccount.google.com/permissions and try
 * again.").
 */
function renderErrorPage(message: string): string {
    const safeMessage = String(message)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Authentication failed</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #fef2f2;
      color: #1f2937;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #ffffff;
      border-radius: 12px;
      padding: 32px 40px;
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
      max-width: 480px;
      border-left: 4px solid #dc2626;
    }
    h1 { margin-top: 0; font-size: 1.5rem; color: #dc2626; }
    p { line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authentication failed.</h1>
    <p>${safeMessage}</p>
  </div>
</body>
</html>`;
}
