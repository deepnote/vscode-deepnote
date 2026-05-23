import express, { type Express, type Request, type Response } from 'express';
import * as http from 'http';
import { type AddressInfo } from 'net';
import { CancellationError, CancellationToken, Uri, env } from 'vscode';

import { logger } from '../../../../platform/logging';
import { exchangeAuthorizationCode } from './googleOAuthProvider.node';

/** Default OAuth-flow deadline (5 min) measured from listen(). After this the loopback server is torn down. */
export const OAUTH_FLOW_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Inputs for {@link runOAuthFlow}. The flow binds a loopback server on `127.0.0.1:0`, externalizes the
 * callback URL via `env.asExternalUri`, and fires `onListening` so the caller can build a deepnote.com
 * OAuth-proxy URL referencing that loopback URL as `finalRedirect`. When the loopback callback fires
 * with `code` + matching `state`, the code is exchanged for tokens directly against Google's `/token`
 * endpoint — the refresh token never goes through deepnote.com.
 */
export interface RunOAuthFlowParams {
    clientId: string;
    clientSecret: string;
    integrationId: string;
    onListening: (externalCallbackUrl: string) => Promise<void>;
    /** The same `redirect_uri` that deepnote.com used in the upstream `/authorize` call. Google rejects the exchange if they don't match. */
    redirectUri: string;
    /** CSRF nonce the caller supplied as `state` in the deepnote.com start URL. The callback must echo this exact value. */
    state: string;
    timeoutMs?: number;
    token: CancellationToken;
    /** PKCE verifier paired with the challenge sent in the upstream authorize call. */
    codeVerifier: string;
    /** Test seam: overrides Google's token endpoint URL when exchanging the code. */
    tokenUrl?: string;
}

/** Runs the loopback OAuth-callback flow; resolves with the refresh token, or rejects on cancellation/timeout/state-mismatch/exchange error. Cleans up the server unconditionally. */
export async function runOAuthFlow(params: RunOAuthFlowParams): Promise<{ refreshToken: string }> {
    const timeoutMs = params.timeoutMs ?? OAUTH_FLOW_TIMEOUT_MS;

    const app: Express = express();
    const server = http.createServer(app);

    let resolveCompletion!: (value: { refreshToken: string }) => void;
    let rejectCompletion!: (reason: Error) => void;
    const completion = new Promise<{ refreshToken: string }>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
    });

    let cancellationSubscription: { dispose(): void } | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
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

        // Route through `asExternalUri` so VS Code remote port forwarding (SSH-remote, WSL, dev-container) gives us a loopback URL the user's local browser can reach. In local VS Code this is a passthrough.
        const externalCallbackUrl = (
            await env.asExternalUri(Uri.parse(`http://127.0.0.1:${port}/auth/callback`))
        ).toString();

        logger.info(`runOAuthFlow: bound loopback on port ${port}; externalCallbackUrl=${externalCallbackUrl}`);

        app.get('/auth/callback', async (req: Request, res: Response) => {
            const code = typeof req.query.code === 'string' ? req.query.code : undefined;
            const callbackState = typeof req.query.state === 'string' ? req.query.state : undefined;
            const providerError = typeof req.query.error === 'string' ? req.query.error : undefined;
            const providerErrorDescription =
                typeof req.query.error_description === 'string' ? req.query.error_description : undefined;

            // State always has to match — both the success and error responses carry it (RFC 6749 §4.1.2 & §4.1.2.1).
            if (!callbackState) {
                const err = new Error('OAuth callback missing `state` query parameter.');
                rejectCompletion(err);
                res.status(400).send(renderErrorPage(err.message));
                return;
            }
            if (callbackState !== params.state) {
                const err = new Error('OAuth callback `state` did not match the expected value.');
                rejectCompletion(err);
                res.status(400).send(renderErrorPage(err.message));
                return;
            }

            // OAuth provider error (e.g., user cancelled consent → `access_denied`). Surface the description if present so the user sees the actual reason rather than a timeout.
            if (providerError) {
                const message = providerErrorDescription
                    ? `${providerError}: ${providerErrorDescription}`
                    : providerError;
                const err = new Error(`OAuth provider returned error: ${message}`);
                rejectCompletion(err);
                res.status(400).send(renderErrorPage(err.message));
                return;
            }

            if (!code) {
                const err = new Error('OAuth callback missing `code` query parameter.');
                rejectCompletion(err);
                res.status(400).send(renderErrorPage(err.message));
                return;
            }

            try {
                const { refreshToken } = await exchangeAuthorizationCode({
                    clientId: params.clientId,
                    clientSecret: params.clientSecret,
                    code,
                    codeVerifier: params.codeVerifier,
                    redirectUri: params.redirectUri,
                    tokenUrl: params.tokenUrl
                });
                resolveCompletion({ refreshToken });
                res.status(200).send(renderSuccessPage());
            } catch (err) {
                rejectCompletion(err instanceof Error ? err : new Error(String(err)));
                const message = err instanceof Error ? err.message : 'Authentication failed.';
                res.status(400).send(renderErrorPage(message));
            }
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

        await params.onListening(externalCallbackUrl);

        const result = await Promise.race<{ refreshToken: string }>([completion, timeoutPromise, cancellationPromise]);

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
