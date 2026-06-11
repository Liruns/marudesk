import process from 'node:process';
import readline from 'node:readline/promises';
import type { AgentChatState } from '../shared/agent';
import type { ProviderId } from '../shared/providers';
import { bold, dim, green, red } from './ansi';
import type { BridgeClient } from './client';

/**
 * Plain line mode (chat CLI v2 — docs/chat-cli-tui-design.md §5): the v1 REPL
 * behavior, kept for `--prompt` one-shots, pipes, scripts, and non-TTY stdio —
 * the harness drives the CLI through this path. Streams assistant text deltas,
 * prints compact tool lines, answers questions/approvals over plain prompts.
 */

type LineRenderer = {
  /** Render one snapshot; returns true when a busy turn just settled. */
  render(state: AgentChatState): boolean;
  breakLine(): void;
};

const BUSY = new Set<AgentChatState['status']>(['thinking', 'working', 'waiting_for_user']);

function makeRenderer(io: NodeJS.WriteStream): LineRenderer {
  const printedText = new Map<string, number>();
  const toolPrinted = new Map<string, string>();
  let lastStatus: AgentChatState['status'] = 'idle';
  let openLine = false;

  const breakLine = (): void => {
    if (openLine) {
      io.write('\n');
      openLine = false;
    }
  };

  return {
    render(state) {
      // Streamed assistant text: print only the unprinted tail of the LAST
      // assistant message (earlier ones are already on screen).
      const last = [...state.messages].reverse().find((m) => m.role === 'assistant');
      if (last) {
        const text = last.parts
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join('');
        const done = printedText.get(last.id) ?? 0;
        if (text.length > done) {
          io.write(text.slice(done));
          printedText.set(last.id, text.length);
          openLine = !text.endsWith('\n');
        }
      }
      // Tool cards: one compact line per state transition worth showing.
      for (const m of state.messages) {
        for (const part of m.parts) {
          if (part.type !== 'tool') continue;
          const call = part.call;
          if (toolPrinted.get(call.id) === call.state) continue;
          toolPrinted.set(call.id, call.state);
          if (call.state === 'running') {
            breakLine();
            io.write(dim(`  ⚙ ${call.name}${call.summary ? ` — ${call.summary}` : ''}\n`));
          } else if (call.state === 'ok') {
            breakLine();
            io.write(dim(`  ✓ ${call.name}${call.summary ? ` — ${call.summary}` : ''}\n`));
          } else if (call.state === 'error' || call.state === 'denied') {
            breakLine();
            io.write(dim(red(`  ✗ ${call.name} (${call.state})\n`)));
          }
        }
      }
      const settled =
        BUSY.has(lastStatus) && (state.status === 'completed' || state.status === 'failed');
      lastStatus = state.status;
      if (settled) {
        breakLine();
        if (state.status === 'failed') {
          io.write(red(`✗ ${state.error ?? 'turn failed'}\n`));
        } else {
          const note = state.endNote ? ` (${state.endNote})` : '';
          const u = state.usage;
          io.write(
            green(`✔ done${note}`) +
              dim(` · in ${u.inputTokens} / out ${u.outputTokens} tok\n`),
          );
        }
      }
      return settled;
    },
    breakLine,
  };
}

function makeInteractor(
  rl: readline.Interface,
  client: BridgeClient,
  renderer: LineRenderer,
  io: NodeJS.WriteStream,
) {
  const handled = new Set<string>();
  return async (state: AgentChatState): Promise<void> => {
    const approval = state.pendingApproval;
    if (approval && !handled.has(approval.callId)) {
      handled.add(approval.callId);
      renderer.breakLine();
      io.write(`\n${bold('approval needed')}: ${approval.name}\n${dim(approval.detail)}\n`);
      const answer = (await rl.question('[a]pprove / [d]eny > ')).trim().toLowerCase();
      try {
        await client.approve(
          approval.turnId,
          approval.callId,
          answer === 'a' || answer === 'approve' || answer === 'y',
        );
      } catch (err) {
        io.write(red(`${(err as Error).message}\n`));
      }
      return;
    }
    const questions = state.pendingQuestions;
    if (questions && !handled.has(questions.callId)) {
      handled.add(questions.callId);
      renderer.breakLine();
      const answers: Record<string, string> = {};
      for (const q of questions.questions) {
        io.write(`\n${bold('question')}: ${q.question}\n`);
        if (q.options?.length) io.write(dim(`options: ${q.options.join(' | ')}\n`));
        answers[q.id] = (await rl.question('> ')).trim();
      }
      try {
        await client.respond(questions.turnId, questions.callId, answers);
      } catch (err) {
        io.write(red(`${(err as Error).message}\n`));
      }
    }
  };
}

export async function runLineMode(opts: {
  client: BridgeClient;
  provider: string;
  model: string;
  prompt: string | null;
}): Promise<number> {
  const { client } = opts;
  const io = process.stdout;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const renderer = makeRenderer(io);
  const interact = makeInteractor(rl, client, renderer, io);

  let activeTurnId: string | null = null;
  let settle: (() => void) | null = null;
  let streamClosed = false;

  const stream = client.events((state) => {
    const settled = renderer.render(state);
    void interact(state);
    if (settled) {
      activeTurnId = null;
      settle?.();
    }
  });
  void stream.done
    .catch((err: unknown) => {
      io.write(red(`event stream error: ${(err as Error).message}\n`));
    })
    .finally(() => {
      streamClosed = true;
      settle?.();
    });

  // Ctrl+C: abort the active turn first; a second ^C (or no turn) exits.
  rl.on('SIGINT', () => {
    if (activeTurnId) {
      const t = activeTurnId;
      activeTurnId = null;
      io.write(dim('\naborting…\n'));
      void client.abort(t).catch(() => {});
    } else {
      rl.close();
      stream.stop();
      process.exit(0);
    }
  });

  const send = async (prompt: string): Promise<void> => {
    const res = await client.send({
      provider: opts.provider as ProviderId,
      model: opts.model,
      prompt,
      captures: [],
    });
    if (!res.ok) {
      io.write(red(`not sent: ${res.reason}\n`));
      return;
    }
    activeTurnId = res.turnId;
    await new Promise<void>((resolve) => {
      settle = resolve;
    });
    settle = null;
  };

  if (opts.prompt !== null) {
    await send(opts.prompt);
    rl.close();
    stream.stop();
    return streamClosed && activeTurnId !== null ? 1 : 0;
  }

  io.write(dim(`${opts.provider}/${opts.model} — type a prompt, Ctrl+C to abort/exit\n`));
  for (;;) {
    const line = (await rl.question(bold('marudesk> '))).trim();
    if (!line) continue;
    if (line === '/exit' || line === '/quit') break;
    if (streamClosed) {
      io.write(red('event stream closed — restart the CLI.\n'));
      break;
    }
    await send(line);
  }
  rl.close();
  stream.stop();
  return 0;
}
