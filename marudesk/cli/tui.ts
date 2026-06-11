import process from 'node:process';
import type { AgentChatState } from '../shared/agent';
import type { ProviderId } from '../shared/providers';
import type { AgentApprovalMode } from '../shared/settings';
import type { BridgeModelsResult } from '../shared/remote';
import type { SessionSummary } from '../shared/context';
import {
  bold,
  carriageReturn,
  charWidth,
  cursorUp,
  cyan,
  dim,
  disableBracketedPaste,
  enableBracketedPaste,
  eraseDown,
  gray,
  green,
  inverse,
  red,
  stringWidth,
  truncate,
  wrapText,
  yellow,
} from './ansi';
import type { BridgeClient } from './client';
import {
  backspace,
  del,
  deleteWordLeft,
  EMPTY_COMPOSER,
  emptyHistory,
  historyNext,
  historyPrev,
  insert,
  killToEnd,
  killToStart,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveWordLeft,
  moveWordRight,
  pushHistory,
  type ComposerState,
  type HistoryState,
} from './composer';
import { saveModelPref } from './config';
import { KeyDecoder, type KeyEvent } from './keys';
import { cliSlashQuery, DESKTOP_ONLY, filterCliSlash, resolveCliSlash } from './slash';
import { createTranscript } from './transcript';

/**
 * The interactive inline TUI (chat CLI v2 — docs/chat-cli-tui-design.md §5):
 * transcript streams into normal scrollback; a sticky bottom block (status
 * line + bordered composer + hint/menu/panel) is repainted in place each frame.
 * Claude Code / pi grammar — scrollback-preserving, works inside the app's
 * xterm terminal tab and any real terminal.
 */

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BUSY = new Set<AgentChatState['status']>(['thinking', 'working', 'waiting_for_user']);
const APPROVAL_MODES: AgentApprovalMode[] = ['read-only', 'ask', 'auto', 'plan'];

type PickerItem =
  | { kind: 'header'; label: string }
  | { kind: 'model'; provider: string; model: string; label: string }
  | { kind: 'session'; id: string; label: string };

type Mode =
  | { name: 'input' }
  | { name: 'approval'; turnId: string; callId: string }
  | {
      name: 'question';
      turnId: string;
      callId: string;
      index: number;
      selected: number;
      answers: Record<string, string>;
    }
  | { name: 'picker'; title: string; items: PickerItem[]; selected: number; filter: string };

export type TuiOptions = {
  client: BridgeClient;
  version: string;
  provider: string | null;
  model: string | null;
};

export async function runTui(opts: TuiOptions): Promise<number> {
  const io = process.stdout;
  const stdin = process.stdin;
  const client = opts.client;

  let provider = opts.provider;
  let model = opts.model;
  let mode: Mode = { name: 'input' };
  let composer: ComposerState = EMPTY_COMPOSER;
  let history: HistoryState = emptyHistory();
  let slashSelected = 0;
  let state: AgentChatState | null = null;
  let connected = true;
  let spinnerIdx = 0;
  let turnStartedAt: number | null = null;
  let ctrlCArmedAt = 0;
  let paintedRowsAboveCursor = 0;
  let exitResolve: ((code: number) => void) | null = null;
  const handledApprovals = new Set<string>();
  const handledQuestions = new Set<string>();
  let notice: string | null = null; // one-line hint shown under the composer

  const cols = (): number => Math.max(30, io.columns ?? 80);
  const transcript = createTranscript({ cols: () => cols() - 1 });

  /* ── painting ─────────────────────────────────────────────────────────── */

  const innerWidth = (): number => cols() - 5; // '│ ' + text + ' │', minus autowrap guard

  /** Wrap composer text and locate the cursor inside the wrapped layout. */
  const layoutComposer = (
    text: string,
    cursor: number,
    width: number,
  ): { lines: string[]; row: number; col: number } => {
    const lines: string[] = [];
    let row = 0;
    let col = 0;
    let line = '';
    let lineWidth = 0;
    let consumed = 0;
    let located = false;
    const locate = (): void => {
      if (!located && consumed >= cursor) {
        row = lines.length;
        col = lineWidth;
        located = true;
      }
    };
    locate();
    for (const ch of text) {
      if (ch === '\n') {
        lines.push(line);
        line = '';
        lineWidth = 0;
        consumed += 1;
        locate();
        continue;
      }
      const w = charWidth(ch.codePointAt(0) ?? 0);
      if (lineWidth + w > width) {
        lines.push(line);
        line = '';
        lineWidth = 0;
      }
      line += ch;
      lineWidth += w;
      consumed += ch.length;
      locate();
    }
    lines.push(line);
    if (!located) {
      row = lines.length - 1;
      col = lineWidth;
    }
    return { lines, row, col };
  };

  const statusLine = (): string => {
    const s = state;
    const busy = s ? BUSY.has(s.status) : false;
    const mark = !connected
      ? red('◌ reconnecting')
      : busy
        ? cyan(`${SPINNER[spinnerIdx % SPINNER.length]} ${s?.status ?? ''}`)
        : dim('●');
    const ref = provider && model ? `${provider}/${model}` : 'no model — /model';
    const parts = [mark, dim(ref)];
    if (s) {
      parts.push(dim(`ctx ${fmtTok(s.usage.contextTokens)}`));
      parts.push(dim(`↑${fmtTok(s.usage.inputTokens)} ↓${fmtTok(s.usage.outputTokens)}`));
    }
    if (busy && turnStartedAt) {
      parts.push(dim(`${Math.round((Date.now() - turnStartedAt) / 1000)}s`));
      parts.push(dim('esc to interrupt'));
    }
    return truncate(parts.join(dim(' · ')), cols() - 1);
  };

  const composerBlock = (): { lines: string[]; cursorRow: number; cursorCol: number } => {
    const width = innerWidth();
    const layout = layoutComposer(composer.text, composer.cursor, width);
    const top = `${gray('╭')}${gray('─'.repeat(cols() - 3))}${gray('╮')}`;
    const bottom = `${gray('╰')}${gray('─'.repeat(cols() - 3))}${gray('╯')}`;
    const body = layout.lines.map((l, i) => {
      const prefix = i === 0 ? `${cyan('❯')} ` : '  ';
      const pad = ' '.repeat(Math.max(0, width - stringWidth(l)));
      return `${gray('│')}${prefix}${l}${pad}${gray('│')}`;
    });
    return {
      lines: [top, ...body, bottom],
      cursorRow: 1 + layout.row,
      cursorCol: 1 + 2 + layout.col, // '│' + prompt cells
    };
  };

  const slashMenuLines = (): string[] => {
    if (mode.name !== 'input') return [];
    const query = cliSlashQuery(composer.text);
    if (query === null) return [];
    const matches = filterCliSlash(query);
    if (matches.length === 0) return [dim('  no matching command')];
    if (slashSelected >= matches.length) slashSelected = matches.length - 1;
    const width = cols() - 1;
    return matches.slice(0, 8).map((c, i) => {
      const hint = c.argHint ? ` ${dim(`<${c.argHint}>`)}` : '';
      const label = `  /${c.name}${hint}  ${dim(c.description)}`;
      return truncate(i === slashSelected ? inverse(`  /${c.name}`) + hint + `  ${dim(c.description)}` : label, width);
    });
  };

  const approvalLines = (): string[] => {
    const s = state;
    if (mode.name !== 'approval' || !s?.pendingApproval) return [];
    const a = s.pendingApproval;
    const width = cols() - 3;
    const lines: string[] = ['', `${yellow('⏸ approval needed')} ${bold(a.name)}`];
    for (const l of wrapText(a.detail, width)) lines.push(dim(`  ${l}`));
    if (a.diffs) {
      for (const d of a.diffs) {
        const before = d.before.length === 0 ? 0 : d.before.split('\n').length;
        const after = d.after.length === 0 ? 0 : d.after.split('\n').length;
        lines.push(`  ${cyan('~')} ${d.path} ${dim(`(${before} → ${after} lines)`)}`);
      }
    }
    lines.push(`  ${green('[y] approve')}   ${red('[n] deny')}`);
    return lines;
  };

  const questionLines = (): string[] => {
    const s = state;
    if (mode.name !== 'question' || !s?.pendingQuestions) return [];
    const q = s.pendingQuestions.questions[mode.index];
    if (!q) return [];
    const width = cols() - 3;
    const lines: string[] = [''];
    const count = s.pendingQuestions.questions.length;
    const counter = count > 1 ? dim(` (${mode.index + 1}/${count})`) : '';
    const selected = mode.selected;
    lines.push(`${yellow('? ')}${bold(q.question)}${counter}`);
    (q.options ?? []).forEach((opt, i) => {
      const row = `${i + 1}. ${opt}`;
      lines.push(i === selected ? `  ${inverse(truncate(row, width))}` : `  ${truncate(row, width)}`);
    });
    lines.push(dim('  ↑/↓ + enter to pick · or type a custom answer below'));
    return lines;
  };

  const pickerLines = (): string[] => {
    if (mode.name !== 'picker') return [];
    const width = cols() - 3;
    const lines: string[] = ['', `${cyan('◆')} ${bold(mode.title)} ${dim(`filter: ${mode.filter || '(type to filter)'}`)}`];
    const items = filteredPickerItems();
    if (items.length === 0) lines.push(dim('  nothing matches'));
    const windowed = pickerWindow(items, mode.selected, 10);
    for (const { item, index } of windowed) {
      if (item.kind === 'header') {
        lines.push(dim(`  ${item.label}`));
        continue;
      }
      const row = truncate(`  ${item.label}`, width);
      lines.push(index === mode.selected ? inverse(row) : row);
    }
    lines.push(dim('  ↑/↓ enter to select · esc to cancel'));
    return lines;
  };

  const filteredPickerItems = (): PickerItem[] => {
    if (mode.name !== 'picker') return [];
    const f = mode.filter.trim().toLowerCase();
    if (!f) return mode.items;
    const out: PickerItem[] = [];
    let header: PickerItem | null = null;
    for (const item of mode.items) {
      if (item.kind === 'header') {
        header = item;
        continue;
      }
      if (item.label.toLowerCase().includes(f)) {
        if (header) {
          out.push(header);
          header = null;
        }
        out.push(item);
      }
    }
    return out;
  };

  const pickerWindow = (
    items: PickerItem[],
    selected: number,
    size: number,
  ): { item: PickerItem; index: number }[] => {
    const indexed = items.map((item, index) => ({ item, index }));
    if (indexed.length <= size) return indexed;
    const sel = indexed.findIndex((e) => e.index === selected);
    const start = Math.max(0, Math.min(sel - Math.floor(size / 2), indexed.length - size));
    return indexed.slice(start, start + size);
  };

  const hintLine = (): string[] => {
    if (mode.name !== 'input') return [];
    if (notice) return [truncate(dim(`  ${notice}`), cols() - 1)];
    return [];
  };

  /** Repaint the sticky block (and commit finished scrollback lines first). */
  const paint = (commitLines: string[] = []): void => {
    const block: string[] = [];
    let cursorRow: number | null = null;
    let cursorCol = 0;

    const liveView = transcript.live(SPINNER[spinnerIdx % SPINNER.length]);
    // The repaint math (cursorUp over the previous block) breaks if the block
    // outgrows the terminal — cap the live tail so the whole block always fits.
    const rows = io.rows ?? 24;
    const liveBudget = Math.max(2, rows - 14);
    const liveLines =
      liveView.lines.length > liveBudget
        ? liveView.lines.slice(liveView.lines.length - liveBudget)
        : liveView.lines;
    block.push(...liveLines);
    block.push(statusLine());

    if (mode.name === 'approval') {
      block.push(...approvalLines());
    } else if (mode.name === 'picker') {
      block.push(...pickerLines());
    } else {
      if (mode.name === 'question') block.push(...questionLines());
      const c = composerBlock();
      cursorRow = block.length + c.cursorRow;
      cursorCol = c.cursorCol;
      block.push(...c.lines);
      block.push(...slashMenuLines());
      block.push(...hintLine());
    }

    const frame: string[] = [];
    if (paintedRowsAboveCursor > 0) frame.push(cursorUp(paintedRowsAboveCursor));
    frame.push(carriageReturn, eraseDown);
    for (const l of commitLines) frame.push(`${l}\n`);
    frame.push(block.join('\n'));
    // Park the cursor inside the composer (or at block end for panel modes).
    const lastRow = block.length - 1;
    if (cursorRow !== null) {
      const up = lastRow - cursorRow;
      frame.push(cursorUp(up));
      frame.push(`\x1b[${cursorCol + 1}G`);
      paintedRowsAboveCursor = cursorRow;
    } else {
      paintedRowsAboveCursor = lastRow;
    }
    io.write(frame.join(''));
  };

  /* ── agent wiring ─────────────────────────────────────────────────────── */

  const onState = (next: AgentChatState): void => {
    const hadTurn = state?.turnId ?? null;
    state = next;
    // Elapsed timer: starts when a turn begins (or a new turn replaces it),
    // clears when the loop leaves the busy states.
    if (!BUSY.has(next.status)) turnStartedAt = null;
    else if (!turnStartedAt || hadTurn !== next.turnId) turnStartedAt = Date.now();
    const update = transcript.apply(next);

    // Park on approval/question panels when the loop is waiting on us.
    if (next.pendingApproval && !handledApprovals.has(next.pendingApproval.callId)) {
      if (mode.name === 'input') {
        mode = { name: 'approval', turnId: next.pendingApproval.turnId, callId: next.pendingApproval.callId };
      }
    } else if (mode.name === 'approval') {
      mode = { name: 'input' };
    }
    if (next.pendingQuestions && !handledQuestions.has(next.pendingQuestions.callId)) {
      if (mode.name === 'input') {
        mode = {
          name: 'question',
          turnId: next.pendingQuestions.turnId,
          callId: next.pendingQuestions.callId,
          index: 0,
          selected: 0,
          answers: {},
        };
      }
    } else if (mode.name === 'question' && !next.pendingQuestions) {
      mode = { name: 'input' };
    }

    paint(update.commit);
  };

  // Assigned from inside connectStream (a closure), so give it a callable
  // default — TS's outer-scope flow analysis can't see closure assignments.
  let streamStop: () => void = () => {};
  let stopped = false;
  const connectStream = (): void => {
    const stream = client.events(onState);
    streamStop = stream.stop;
    void stream.done
      .catch(() => {})
      .finally(() => {
        if (stopped) return;
        connected = false;
        paint();
        // The app may be restarting (profile switch) — quietly retry.
        setTimeout(() => {
          if (stopped) return;
          connected = true;
          connectStream();
        }, 1500);
      });
  };

  const commitNotice = (lines: string[]): void => paint(lines);

  const send = async (prompt: string): Promise<void> => {
    if (!provider || !model) {
      await openModelPicker('pick a model first');
      paint();
      return;
    }
    try {
      const res = await client.send({
        provider: provider as ProviderId,
        model,
        prompt,
        captures: [],
      });
      if (!res.ok) commitNotice([red(`✗ not sent: ${res.reason}`)]);
      else turnStartedAt = Date.now();
    } catch (err) {
      commitNotice([red(`✗ ${(err as Error).message}`)]);
    }
  };

  const abortActive = (): void => {
    const turnId = state?.turnId;
    if (!turnId) return;
    void client.abort(turnId).catch(() => {});
  };

  /* ── pickers ──────────────────────────────────────────────────────────── */

  const openModelPicker = async (title = 'switch model'): Promise<void> => {
    let catalog: BridgeModelsResult;
    try {
      catalog = await client.models();
    } catch (err) {
      commitNotice([red(`✗ could not list models: ${(err as Error).message}`)]);
      return;
    }
    const items: PickerItem[] = [];
    const ordered = [...catalog.providers].sort((a, b) => {
      const score = (p: typeof a): number => (p.connected ? 0 : 2) + (p.experimental ? 1 : 0);
      return score(a) - score(b);
    });
    for (const p of ordered) {
      if (!p.connected) continue;
      items.push({
        kind: 'header',
        label: `${p.label}${p.experimental ? ' (experimental)' : ''}`,
      });
      for (const m of p.models) {
        items.push({
          kind: 'model',
          provider: p.id,
          model: m.id,
          label: `${p.id} · ${m.label === m.id ? m.id : `${m.label} (${m.id})`}`,
        });
      }
    }
    const disconnected = ordered.filter((p) => !p.connected);
    if (disconnected.length > 0) {
      items.push({
        kind: 'header',
        label: `not connected (Settings → AI Providers): ${disconnected.map((p) => p.label).join(', ')}`,
      });
    }
    if (!items.some((i) => i.kind === 'model')) {
      commitNotice([
        yellow('no connected provider — open the desktop app: Settings → AI Providers'),
      ]);
      return;
    }
    mode = { name: 'picker', title, items, selected: firstSelectable(items), filter: '' };
  };

  const openSessionsPicker = async (): Promise<void> => {
    let sessions: SessionSummary[];
    try {
      sessions = await client.sessions();
    } catch (err) {
      commitNotice([red(`✗ could not list sessions: ${(err as Error).message}`)]);
      return;
    }
    if (sessions.length === 0) {
      commitNotice([dim('no saved sessions yet')]);
      return;
    }
    const items: PickerItem[] = sessions.map((s) => ({
      kind: 'session',
      id: s.id,
      label: `${s.title || '(untitled)'} · ${s.provider}/${s.model} · ${s.messageCount} msgs · ${new Date(s.updatedAt).toLocaleString()}`,
    }));
    mode = { name: 'picker', title: 'resume a session', items, selected: 0, filter: '' };
  };

  const firstSelectable = (items: PickerItem[]): number => {
    const i = items.findIndex((it) => it.kind !== 'header');
    return i < 0 ? 0 : i;
  };

  const pickerMove = (dir: 1 | -1): void => {
    if (mode.name !== 'picker') return;
    const selected = mode.selected;
    const items = filteredPickerItems();
    if (items.length === 0) return;
    let i = items.findIndex((_, idx) => idx === selected);
    if (i < 0) i = 0;
    for (let step = 0; step < items.length; step++) {
      i = (i + dir + items.length) % items.length;
      if (items[i].kind !== 'header') break;
    }
    mode = { ...mode, selected: i };
  };

  const pickerAccept = async (): Promise<void> => {
    if (mode.name !== 'picker') return;
    const items = filteredPickerItems();
    const item = items[mode.selected];
    if (!item || item.kind === 'header') return;
    mode = { name: 'input' };
    if (item.kind === 'model') {
      provider = item.provider;
      model = item.model;
      saveModelPref({ provider, model });
      commitNotice([dim(`model → ${provider}/${model}`)]);
      return;
    }
    try {
      const res = await client.resumeSession(item.id);
      if (!res.ok) commitNotice([red('✗ could not resume (busy or other-workspace session?)')]);
    } catch (err) {
      commitNotice([red(`✗ ${(err as Error).message}`)]);
    }
  };

  /* ── slash actions ────────────────────────────────────────────────────── */

  const helpLines = (): string[] => {
    const out: string[] = ['', bold('commands')];
    for (const c of filterCliSlash('')) {
      const hint = c.argHint ? ` <${c.argHint}>` : '';
      out.push(`  ${cyan(`/${c.name}`)}${dim(hint)}  ${dim(c.description)}`);
    }
    out.push(dim(`  desktop panel only: ${DESKTOP_ONLY.map((d) => `/${d}`).join(' ')}`));
    out.push(dim('  esc interrupt · ctrl+c clear/exit · \\ + enter for a newline'));
    return out;
  };

  const statusLines = (): string[] => {
    const s = state;
    const out: string[] = ['', bold('status')];
    out.push(`  bridge      ${dim(client.url)}`);
    out.push(`  model       ${dim(provider && model ? `${provider}/${model}` : 'not set')}`);
    if (s) {
      out.push(`  agent       ${dim(s.status)}`);
      out.push(`  approval    ${dim(s.approvalMode)}`);
      out.push(
        `  tokens      ${dim(`↑${fmtTok(s.usage.inputTokens)} ↓${fmtTok(s.usage.outputTokens)} · ctx ${fmtTok(s.usage.contextTokens)}`)}`,
      );
      if (s.activeSessionId) out.push(`  session     ${dim(s.activeSessionId)}`);
    }
    return out;
  };

  const runSlash = async (line: string): Promise<boolean> => {
    const resolved = resolveCliSlash(line);
    if (!resolved) {
      commitNotice([red(`unknown command: ${line.split(/\s/)[0]} — /help lists commands`)]);
      return true;
    }
    const { command, arg } = resolved;
    if (command.kind === 'prompt') {
      await send(command.expand(arg));
      return true;
    }
    switch (command.action) {
      case 'help':
        commitNotice(helpLines());
        return true;
      case 'status':
        commitNotice(statusLines());
        return true;
      case 'new':
        try {
          await client.reset();
        } catch (err) {
          commitNotice([red(`✗ ${(err as Error).message}`)]);
        }
        return true;
      case 'model':
        await openModelPicker();
        return true;
      case 'sessions':
        await openSessionsPicker();
        return true;
      case 'resume':
        if (!arg) {
          await openSessionsPicker();
          return true;
        }
        try {
          const res = await client.resumeSession(arg);
          if (!res.ok) commitNotice([red('✗ could not resume that session')]);
        } catch (err) {
          commitNotice([red(`✗ ${(err as Error).message}`)]);
        }
        return true;
      case 'approval-mode': {
        const m = arg as AgentApprovalMode;
        if (!APPROVAL_MODES.includes(m)) {
          commitNotice([yellow(`usage: /approval-mode ${APPROVAL_MODES.join(' | ')}`)]);
          return true;
        }
        try {
          await client.setApprovalMode(m);
          commitNotice([dim(`approval mode → ${m} (applies next turn)`)]);
        } catch (err) {
          commitNotice([red(`✗ ${(err as Error).message}`)]);
        }
        return true;
      }
      case 'exit':
        exitResolve?.(0);
        return true;
    }
    return true;
  };

  /* ── key handling ─────────────────────────────────────────────────────── */

  const submit = async (): Promise<void> => {
    let text = composer.text;
    // `\` at end of line = literal newline (raw mode can't see shift+enter).
    if (text.endsWith('\\')) {
      composer = insert({ text: text.slice(0, -1), cursor: text.length - 1 }, '\n');
      return;
    }
    text = text.trim();
    composer = EMPTY_COMPOSER;
    slashSelected = 0;
    if (!text) return;
    history = pushHistory(history, text);

    if (mode.name === 'question') {
      await answerQuestion(text);
      return;
    }
    if (text.startsWith('/')) {
      await runSlash(text);
      return;
    }
    await send(text);
  };

  const answerQuestion = async (text: string): Promise<void> => {
    const s = state;
    if (mode.name !== 'question' || !s?.pendingQuestions) return;
    const questions = s.pendingQuestions.questions;
    const q = questions[mode.index];
    const answers = { ...mode.answers, [q.id]: text };
    if (mode.index + 1 < questions.length) {
      mode = { ...mode, index: mode.index + 1, selected: 0, answers };
      return;
    }
    handledQuestions.add(mode.callId);
    const { turnId, callId } = mode;
    mode = { name: 'input' };
    try {
      await client.respond(turnId, callId, answers);
    } catch (err) {
      commitNotice([red(`✗ ${(err as Error).message}`)]);
    }
  };

  const handleApprovalKey = async (ev: KeyEvent): Promise<void> => {
    if (mode.name !== 'approval') return;
    if (ev.type !== 'char') return;
    const ch = ev.ch.toLowerCase();
    if (ch !== 'y' && ch !== 'n') return;
    handledApprovals.add(mode.callId);
    const { turnId, callId } = mode;
    mode = { name: 'input' };
    try {
      await client.approve(turnId, callId, ch === 'y');
    } catch (err) {
      // e.g. the remote server's L-1 guard — surface the server's explanation.
      commitNotice([red(`✗ ${(err as Error).message}`)]);
    }
  };

  const handleKey = async (ev: KeyEvent): Promise<void> => {
    notice = null;

    if (mode.name === 'approval') {
      if (ev.type === 'esc') {
        abortActive();
        return;
      }
      await handleApprovalKey(ev);
      return;
    }

    if (mode.name === 'picker') {
      if (ev.type === 'esc') {
        mode = { name: 'input' };
        return;
      }
      if (ev.type === 'up') return pickerMove(-1);
      if (ev.type === 'down') return pickerMove(1);
      if (ev.type === 'enter') return void (await pickerAccept());
      if (ev.type === 'backspace') {
        mode = { ...mode, filter: mode.filter.slice(0, -1) };
        mode = { ...mode, selected: firstSelectable(filteredPickerItems()) };
        return;
      }
      if (ev.type === 'char') {
        mode = { ...mode, filter: mode.filter + ev.ch };
        mode = { ...mode, selected: firstSelectable(filteredPickerItems()) };
        return;
      }
      return;
    }

    if (mode.name === 'question') {
      const s = state;
      const q = s?.pendingQuestions?.questions[mode.index];
      const optionCount = q?.options?.length ?? 0;
      if (ev.type === 'up' && composer.text.length === 0 && optionCount > 0) {
        mode = { ...mode, selected: (mode.selected - 1 + optionCount) % optionCount };
        return;
      }
      if (ev.type === 'down' && composer.text.length === 0 && optionCount > 0) {
        mode = { ...mode, selected: (mode.selected + 1) % optionCount };
        return;
      }
      if (ev.type === 'enter' && composer.text.length === 0 && optionCount > 0) {
        await answerQuestion(q?.options?.[mode.selected] ?? '');
        return;
      }
      // fall through: free text uses the composer below
    }

    const slashOpen = mode.name === 'input' && cliSlashQuery(composer.text) !== null;

    switch (ev.type) {
      case 'char':
        composer = insert(composer, ev.ch);
        break;
      case 'paste':
        composer = insert(composer, ev.text);
        break;
      case 'enter': {
        if (slashOpen) {
          // Run the highlighted menu entry (claude-code: Enter executes it).
          const matches = filterCliSlash(cliSlashQuery(composer.text) ?? '');
          const chosen = matches[slashSelected];
          if (chosen) {
            composer = { text: `/${chosen.name}`, cursor: chosen.name.length + 1 };
          }
        }
        await submit();
        break;
      }
      case 'tab': {
        if (slashOpen) {
          const matches = filterCliSlash(cliSlashQuery(composer.text) ?? '');
          const chosen = matches[slashSelected];
          if (chosen) {
            const text = `/${chosen.name} `;
            composer = { text, cursor: text.length };
          }
        }
        break;
      }
      case 'backspace':
        composer = backspace(composer);
        break;
      case 'delete':
        composer = del(composer);
        break;
      case 'left':
        composer = moveLeft(composer);
        break;
      case 'right':
        composer = moveRight(composer);
        break;
      case 'home':
        composer = moveHome(composer);
        break;
      case 'end':
        composer = moveEnd(composer);
        break;
      case 'word-left':
        composer = moveWordLeft(composer);
        break;
      case 'word-right':
        composer = moveWordRight(composer);
        break;
      case 'up': {
        if (slashOpen) {
          slashSelected = Math.max(0, slashSelected - 1);
          break;
        }
        const prev = historyPrev(history, composer.text);
        if (prev) {
          history = prev.history;
          composer = { text: prev.text, cursor: prev.text.length };
        }
        break;
      }
      case 'down': {
        if (slashOpen) {
          slashSelected += 1;
          break;
        }
        const next = historyNext(history);
        if (next) {
          history = next.history;
          composer = { text: next.text, cursor: next.text.length };
        }
        break;
      }
      case 'esc': {
        if (mode.name === 'question') break; // questions park the turn; esc is a no-op
        if (state && BUSY.has(state.status)) {
          abortActive();
          notice = 'interrupting…';
        } else if (composer.text.length > 0) {
          composer = EMPTY_COMPOSER;
          slashSelected = 0;
        }
        break;
      }
      case 'shift-tab':
        break;
      case 'ctrl': {
        switch (ev.ch) {
          case 'c': {
            if (composer.text.length > 0) {
              composer = EMPTY_COMPOSER;
              slashSelected = 0;
              break;
            }
            const now = Date.now();
            if (now - ctrlCArmedAt < 1500) {
              exitResolve?.(0);
              return;
            }
            ctrlCArmedAt = now;
            if (state && BUSY.has(state.status)) abortActive();
            notice = 'press ctrl+c again to exit';
            break;
          }
          case 'd':
            if (composer.text.length === 0) {
              exitResolve?.(0);
              return;
            }
            composer = del(composer);
            break;
          case 'a':
            composer = moveHome(composer);
            break;
          case 'e':
            composer = moveEnd(composer);
            break;
          case 'u':
            composer = killToStart(composer);
            break;
          case 'k':
            composer = killToEnd(composer);
            break;
          case 'w':
            composer = deleteWordLeft(composer);
            break;
          case 'l':
            // Clear screen: drop the painted block bookkeeping and repaint.
            io.write('\x1b[2J\x1b[H');
            paintedRowsAboveCursor = 0;
            break;
          default:
            break;
        }
        break;
      }
    }
    if (ev.type === 'char' || ev.type === 'backspace') {
      const q = cliSlashQuery(composer.text);
      if (q !== null) slashSelected = Math.min(slashSelected, Math.max(0, filterCliSlash(q).length - 1));
      else slashSelected = 0;
    }
  };

  /* ── lifecycle ────────────────────────────────────────────────────────── */

  const banner = (): string[] => [
    `${cyan('◆')} ${bold('marudesk chat')} ${dim(`v${opts.version} · ${client.url}`)}`,
    dim(provider && model ? `  ${provider}/${model} · /help for commands` : '  /help for commands'),
    '',
  ];

  const decoder = new KeyDecoder();
  let escTimer: NodeJS.Timeout | null = null;

  const onStdin = (chunk: Buffer): void => {
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    const events = decoder.push(chunk);
    void (async () => {
      for (const ev of events) await handleKey(ev);
      if (decoder.hasPendingEscape()) {
        escTimer = setTimeout(() => {
          void (async () => {
            for (const ev of decoder.flushEscape()) await handleKey(ev);
            paint();
          })();
        }, 40);
      }
      paint();
    })();
  };

  const spinnerTimer = setInterval(() => {
    spinnerIdx += 1;
    const busy = (state && BUSY.has(state.status)) || !connected;
    if (busy) paint();
  }, 120);
  spinnerTimer.unref?.();

  const onResize = (): void => paint();

  const code = await new Promise<number>((resolve) => {
    exitResolve = resolve;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('data', onStdin);
    io.on('resize', onResize);
    io.write(enableBracketedPaste);
    paint(banner());
    connectStream();
    if (!provider || !model) {
      void openModelPicker('pick a model').then(() => paint());
    }
  });

  // Teardown: restore the terminal so the parent shell prompt isn't mangled.
  stopped = true;
  clearInterval(spinnerTimer);
  if (escTimer) clearTimeout(escTimer);
  streamStop();
  stdin.off('data', onStdin);
  io.off('resize', onResize);
  stdin.setRawMode?.(false);
  stdin.pause();
  io.write(`${disableBracketedPaste}\n`);
  return code;
}

function fmtTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}
