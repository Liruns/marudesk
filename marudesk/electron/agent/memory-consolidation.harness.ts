import { check, passedCount } from '../harness-kit.ts';
import type { AgentMessage } from '../../shared/agent';
import {
  serializeSessionTrace,
  selectSessionsForConsolidation,
  buildConsolidationPrompt,
  assembleConsolidatedNote,
  MAX_CONSOLIDATED_SESSIONS,
  MAX_SESSION_TRACE_CHARS,
  type ConsolidationSession,
} from './memory-consolidation-core.ts';
import { MEMORY_CONSOLIDATION_INSTRUCTION } from './prompts.ts';

/**
 * Harness for the pure two-phase memory-consolidation core (SECOND-PASS item 4).
 * Pure + dependency-free — runs standalone under `node --experimental-strip-types`.
 *
 * Covers session→trace serialization (text + tool one-liners, reasoning omitted),
 * the recent-session selection + cap + empty-drop, the budgeted prompt assembly,
 * and the consolidated-note provenance footer.
 */

const msg = (role: 'user' | 'assistant', parts: AgentMessage['parts']): AgentMessage => ({
  id: Math.random().toString(36).slice(2),
  role,
  parts,
  timestamp: 0,
});

const session = (id: string, title: string, updatedAt: number, parts: AgentMessage['parts']): ConsolidationSession => ({
  id,
  title,
  updatedAt,
  messages: [msg('user', parts)],
});

/* ── serializeSessionTrace ────────────────────────────────────────────────── */
{
  const s: ConsolidationSession = {
    id: '1',
    title: 'fix',
    updatedAt: 1,
    messages: [
      msg('user', [{ type: 'text', text: 'fix the export' }]),
      msg('assistant', [
        { type: 'reasoning', text: 'secret thoughts' },
        { type: 'tool', call: { id: 't', name: 'read_file', state: 'ok', summary: 'src/app.ts', input: {} } },
        { type: 'text', text: 'patched it' },
      ]),
    ],
  };
  const trace = serializeSessionTrace(s);
  check('trace keeps user text', trace.includes('user: fix the export'));
  check('trace renders tool one-liner', trace.includes('[ran read_file — src/app.ts]'));
  check('trace keeps assistant text', trace.includes('patched it'));
  check('trace omits reasoning', !trace.includes('secret thoughts'));

  // Oversized trace is clipped + flagged.
  const huge = serializeSessionTrace({
    id: '2',
    title: 't',
    updatedAt: 1,
    messages: [msg('user', [{ type: 'text', text: 'x'.repeat(MAX_SESSION_TRACE_CHARS + 200) }])],
  });
  check('oversized trace is clipped', huge.length <= MAX_SESSION_TRACE_CHARS + 64);
  check('oversized trace is flagged truncated', huge.includes('session truncated'));
}

/* ── selectSessionsForConsolidation ───────────────────────────────────────── */
{
  const sessions: ConsolidationSession[] = [
    session('old', 'old', 1, [{ type: 'text', text: 'old work' }]),
    session('new', 'new', 100, [{ type: 'text', text: 'new work' }]),
    session('empty', 'empty', 50, [{ type: 'reasoning', text: 'only thoughts' }]), // empty trace → dropped
  ];
  const selected = selectSessionsForConsolidation(sessions);
  check('newest first', selected[0].session.id === 'new');
  check('empty-trace session dropped', !selected.some((x) => x.session.id === 'empty'));
  check('two non-empty sessions kept', selected.length === 2);

  // The cap: build MAX+5 non-empty sessions; only MAX are kept.
  const many: ConsolidationSession[] = Array.from({ length: MAX_CONSOLIDATED_SESSIONS + 5 }, (_v, i) =>
    session(`s${i}`, `s${i}`, i, [{ type: 'text', text: `work ${i}` }]),
  );
  check('selection respects the cap', selectSessionsForConsolidation(many).length === MAX_CONSOLIDATED_SESSIONS);
}

/* ── buildConsolidationPrompt ─────────────────────────────────────────────── */
{
  const selected = selectSessionsForConsolidation([
    session('a', 'Auth work', 2, [{ type: 'text', text: 'wired oauth' }]),
    session('b', 'Export work', 1, [{ type: 'text', text: 'added html export' }]),
  ]);
  const prompt = buildConsolidationPrompt(selected);
  check('prompt is produced', prompt !== null);
  if (prompt) {
    check('prompt carries the distill instruction', prompt.includes(MEMORY_CONSOLIDATION_INSTRUCTION));
    check('prompt wraps each session', prompt.includes('<session title="Auth work">'));
    check('prompt includes session content', prompt.includes('wired oauth') && prompt.includes('added html export'));
    // A hostile title can't break out of the attribute.
    const evil = buildConsolidationPrompt(
      selectSessionsForConsolidation([session('x', 'a"><script>', 1, [{ type: 'text', text: 'hi' }])]),
    );
    check('title is attribute-escaped', !!evil && !evil.includes('"><script>'));
  }
  check('empty selection → null prompt', buildConsolidationPrompt([]) === null);
}

/* ── assembleConsolidatedNote ─────────────────────────────────────────────── */
{
  const note = assembleConsolidatedNote('  ## Project\nMaru desktop app.  ', 3, Date.parse('2026-06-20T00:00:00Z'));
  check('note keeps the distilled body (trimmed)', note.startsWith('## Project\nMaru desktop app.'));
  check('note has a provenance footer', note.includes('Auto-consolidated from 3 recent sessions on 2026-06-20'));
  check('singular session count reads "session"', assembleConsolidatedNote('x', 1, Date.now()).includes('1 recent session on'));
}

console.log(`\n${passedCount()} checks passed`);
