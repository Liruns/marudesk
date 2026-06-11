import process from 'node:process';
import { dim, red } from './ansi';
import { createClient } from './client';
import { parseArgs, resolveConnection, resolveModelPref } from './config';
import { runLineMode } from './line-mode';
import { runTui } from './tui';

/**
 * marudesk chat CLI (chat CLI v2 — docs/chat-cli-tui-design.md): drive the
 * desktop app's AI Chat from a terminal, Claude Code-style.
 *
 * The desktop app always runs a loopback companion listener and drops a
 * same-user handshake (`cli-bridge.json` in userData) while it does — so with
 * the app open, `npm run chat` (or the embedded "AI Chat (CLI)" terminal tab)
 * just works. `--url/--token` or MARUDESK_BRIDGE_URL/TOKEN target another
 * bridge (e.g. the remote server) explicitly.
 *
 * Modes:
 *  - TTY → the interactive inline TUI (composer, slash menu, approvals,
 *    pickers). `--line` forces the plain REPL instead.
 *  - `--prompt`/`-p` or non-TTY stdio → line mode: send, stream plainly, exit
 *    (pipes/scripts/harness).
 *
 * Zero dependencies; Node 20+.
 */

const HELP = `marudesk chat CLI
  (no flags)           interactive TUI (requires a TTY)
  --prompt,-p <text>   one-shot: send, stream the reply, exit
  --line               plain line-mode REPL instead of the TUI
  --provider <id>      provider id (remembered in cli-prefs.json)
  --model <id>         model id (remembered)
  --url <url>          bridge URL (else env MARUDESK_BRIDGE_URL, else cli-bridge.json)
  --token <token>      bearer token (else env MARUDESK_BRIDGE_TOKEN, else cli-bridge.json)
In-TUI: /help lists commands (/model /sessions /new /review …), esc interrupts.
Requires the marudesk desktop app to be running.`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const io = process.stdout;
  if (args.help) {
    io.write(`${HELP}\n`);
    return;
  }

  const conn = resolveConnection(args);
  if (!conn) {
    io.write(
      `${red('no bridge connection')} — start the marudesk desktop app (its CLI bridge is on while it runs),\n` +
        `or pass --url/--token (env: MARUDESK_BRIDGE_URL / MARUDESK_BRIDGE_TOKEN).\n`,
    );
    process.exitCode = 1;
    return;
  }

  const client = createClient(conn);
  let version: string;
  try {
    version = (await client.health()).version;
  } catch (err) {
    io.write(red(`could not reach the bridge at ${conn.url}: ${(err as Error).message}\n`));
    process.exitCode = 1;
    return;
  }

  const pref = resolveModelPref(args);
  const interactive =
    args.prompt === null && !args.line && process.stdin.isTTY === true && io.isTTY === true;

  if (interactive) {
    const code = await runTui({
      client,
      version,
      provider: pref.provider,
      model: pref.model,
    });
    process.exit(code);
  }

  // Line mode needs a concrete model up front (no interactive picker).
  if (!pref.provider || !pref.model) {
    io.write(
      `${red('no model selected')} — pass --provider and --model once (they are remembered),\n` +
        `e.g. npm run chat -- --provider anthropic --model claude-sonnet-4-6 --prompt "hi"\n`,
    );
    process.exitCode = 1;
    return;
  }

  io.write(dim(`connected — marudesk v${version} at ${conn.url}\n`));
  const code = await runLineMode({
    client,
    provider: pref.provider,
    model: pref.model,
    prompt: args.prompt,
  });
  process.exit(code);
}

await main();
