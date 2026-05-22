import * as crypto from 'crypto';
import express, { type Express, type Request, type Response } from 'express';
import * as http from 'http';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { type AddressInfo } from 'net';
import { CancellationError, CancellationToken } from 'vscode';

import { logger } from '../../../../platform/logging';

/** Default OAuth-flow deadline (5 min) measured from listen(). After this the loopback server is torn down. */
export const OAUTH_FLOW_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Inputs for {@link runOAuthFlow}. Strategy + completion pair must come from {@link buildBigQueryGoogleOAuthStrategy}.
 * `onListening` fires once with the start URL after the port is bound; `timeoutMs` is a test seam.
 */
export interface RunOAuthFlowParams {
    completion: Promise<{ refreshToken: string }>;
    integrationId: string;
    onListening: (startUrl: string) => Promise<void>;
    strategy: GoogleStrategy;
    timeoutMs?: number;
    token: CancellationToken;
}

/** Runs the loopback OAuth flow; resolves with the refresh token, or rejects on cancellation/timeout/OAuth error. Cleans up server + passport strategy unconditionally. */
export async function runOAuthFlow(params: RunOAuthFlowParams): Promise<{ refreshToken: string }> {
    const strategyName = `deepnote-google-oauth-${crypto.randomBytes(8).toString('hex')}`;
    const timeoutMs = params.timeoutMs ?? OAUTH_FLOW_TIMEOUT_MS;

    const app: Express = express();
    const server = http.createServer(app);

    let cancellationSubscription: { dispose(): void } | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
        passport.use(strategyName, params.strategy);

        // Loopback-only: Google "Desktop app" OAuth clients only accept redirects on the loopback interface.
        server.listen(0, '127.0.0.1');

        const listening = new Promise<number>((resolve, reject) => {
            // Forward-declared with `let` so each handler can `removeListener` the other (avoids use-before-define).
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

        // Patch the strategy's placeholder `_callbackURL` now that we know the bound port (used in both the authorize redirect and the token-exchange `redirect_uri`).
        (params.strategy as unknown as { _callbackURL: string })._callbackURL = callbackURL;

        // /auth/start kicks the authorize redirect with `accessType=offline` + `prompt=consent` so Google issues a refresh token even on re-authorization (passport-google-oauth20 strategy.js:138-143).
        app.get(
            '/auth/start',
            passport.authenticate(strategyName, {
                session: false,
                accessType: 'offline',
                prompt: 'consent'
            } as Parameters<typeof passport.authenticate>[1])
        );

        // /auth/callback runs the verify closure (resolves `completion` on success). Failures land in the error middleware below.
        app.get(
            '/auth/callback',
            passport.authenticate(strategyName, { session: false } as Parameters<typeof passport.authenticate>[1]),
            (_req: Request, res: Response) => {
                res.status(200).send(renderSuccessPage());
            }
        );

        // Renders an inline error page in the user's browser; the promise rejection comes from the verify closure separately.
        app.use((err: unknown, _req: Request, res: Response, _next: unknown) => {
            const message = err instanceof Error ? err.message : 'Authentication failed.';
            logger.error('OAuth loopback flow rendered error page.', err);
            res.status(400).send(renderErrorPage(message));
        });

        // Wire cancellation + timeout BEFORE onListening so a fast cancel inside the caller is observed (VSCode events don't replay).
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
        // `closeAllConnections` prevents the server hanging on a half-open TCP connection if the user closed the browser tab mid-flow.
        if (typeof (server as { closeAllConnections?: () => void }).closeAllConnections === 'function') {
            (server as { closeAllConnections: () => void }).closeAllConnections();
        }
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
        passport.unuse(strategyName);
    }
}

/** Inline-CSS success page rendered after consent. */
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

/** Inline-CSS error page rendered on OAuth failure; surfaces the underlying message so the user can act on it. */
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
