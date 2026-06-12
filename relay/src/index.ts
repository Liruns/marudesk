import { loadConfig } from './config.ts';
import { createServer } from './server.ts';

/**
 * Entrypoint: load config from env, boot the relay, log the surface. Runs for
 * local dev with nothing configured (ephemeral JWT secret + OAuth 503). Bind
 * 0.0.0.0 by default (a relay is meant to be reachable) — for dev set HOST to
 * 127.0.0.1 / leave PORT default and connect to localhost.
 *
 * Run: `npm start`  (node --experimental-strip-types src/index.ts)
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer({ config });
  const port = await server.listen();

  const oauthStatus = `google=${config.google ? 'on' : 'off'} github=${config.github ? 'on' : 'off'}`;
  console.log(`[relay] listening on http://${config.host}:${port}  (oauth: ${oauthStatus})`);
  console.log('[relay] HTTP: POST /auth/signup|login|refresh|logout|handoff, GET /me, GET /auth/{google,github}[/callback], GET /health');
  console.log('[relay] WS:   /connect?role=host|client&token=<accessToken>');

  const shutdown = (signal: string): void => {
    console.log(`[relay] ${signal} → shutting down`);
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[relay] failed to start:', err);
  process.exitCode = 1;
});
