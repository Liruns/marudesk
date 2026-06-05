import {
  FileText,
  FolderTree,
  Search,
  FilePen,
  Bug,
  ScrollText,
  Code,
  SquareTerminal,
  Network,
  RefreshCw,
  Cookie,
  Database,
  LayoutGrid,
  Globe,
  FileCode,
  History,
  Trash2,
  BookMarked,
  BookOpen,
  NotebookPen,
  FolderOpen,
  ExternalLink,
  type LucideIcon,
} from 'lucide-react';
import type { Locale, TranslationKey } from '../../../i18n/messages';
import type { AgentMessage, AgentStatus } from '../../../../shared/agent';

/* ── status ─────────────────────────────────────────────────────────────── */

export const STATUS_LABEL_KEY: Record<AgentStatus, TranslationKey> = {
  idle: 'agent.chat.status.ready',
  thinking: 'agent.chat.status.thinking',
  working: 'agent.chat.status.working',
  waiting_for_user: 'agent.chat.status.waiting',
  failed: 'agent.chat.status.stopped',
  completed: 'agent.chat.status.done',
};

export function isBusy(s: AgentStatus): boolean {
  return s === 'thinking' || s === 'working' || s === 'waiting_for_user';
}

/* ── locale-aware labels ────────────────────────────────────────────────── */

export function formatRuntimeChecks(locale: Locale, count: number): string {
  if (locale === 'ko') return `실행 중인 앱에서 런타임 확인 ${count}회`;
  return `${count} runtime check${count === 1 ? '' : 's'} on the live app`;
}

export function formatChangedFiles(locale: Locale, count: number): string {
  if (locale === 'ko') return `파일 ${count}개 변경됨`;
  return `${count} file${count === 1 ? '' : 's'} changed`;
}

export function formatSelectedCaptures(locale: Locale, count: number): string {
  if (locale === 'ko') return `캡처 ${count}개 선택됨`;
  return `${count} capture${count === 1 ? '' : 's'} selected`;
}

export function formatContextWindow(locale: Locale, value: string, pct: number): string {
  if (locale === 'ko') return `${value} (${pct}% 사용됨)`;
  return `${value} (${pct}% used)`;
}

export function formatUsageTitle(locale: Locale, input: string, output: string): string {
  if (locale === 'ko') return `입력 ${input}개 - 출력 ${output}개 토큰`;
  return `${input} input - ${output} output tokens`;
}

/** Compact token-count label: 200000 → "200K", 1048576 → "1M". */
export function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/* ── message text ───────────────────────────────────────────────────────── */

export function textOf(message: AgentMessage): string {
  return message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

/* ── @ file mentions ────────────────────────────────────────────────────── */

/**
 * Detect an in-progress `@file` mention at the caret. Returns the partial query
 * and the `@`'s index, or null when the caret isn't inside a mention token. The
 * `@` must sit at the start or after whitespace, with no whitespace between it
 * and the caret — so `@` mid-word (e.g. an email) never triggers the picker.
 */
export function mentionContext(text: string, caret: number): { query: string; start: number } | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '@') {
      const before = i === 0 ? '' : text[i - 1];
      if (i === 0 || /\s/.test(before)) return { query: text.slice(i + 1, caret), start: i };
      return null;
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

/** Rank workspace files for a mention query: basename prefix > path substring. */
export function matchFiles(files: { path: string }[], query: string, limit = 8): string[] {
  const q = query.toLowerCase();
  if (q === '') return files.slice(0, limit).map((f) => f.path);
  const scored: { path: string; score: number }[] = [];
  for (const f of files) {
    const path = f.path.toLowerCase();
    const base = path.slice(path.lastIndexOf('/') + 1);
    let score = -1;
    if (base.startsWith(q)) score = 0;
    else if (base.includes(q)) score = 1;
    else if (path.includes(q)) score = 2;
    if (score >= 0) scored.push({ path: f.path, score });
  }
  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length);
  return scored.slice(0, limit).map((s) => s.path);
}

/* ── tool presentation ──────────────────────────────────────────────────── */

export type ToolMeta = { labelKey: TranslationKey; icon: LucideIcon; runtime?: boolean };

/**
 * Per-tool presentation. `runtime` tools read/act on the LIVE running page over
 * CDP — marudesk's differentiator ([[marudesk-positioning-wedge]]). They get an
 * accent spine + accent icon so the transcript visibly shows the agent inspecting
 * the running app, not just the source.
 */
export const TOOL_META: Record<string, ToolMeta> = {
  read_file: { labelKey: 'agent.chat.tool.readFile', icon: FileText },
  list_files: { labelKey: 'agent.chat.tool.listFiles', icon: FolderTree },
  grep: { labelKey: 'agent.chat.tool.search', icon: Search },
  edit_file: { labelKey: 'agent.chat.tool.edit', icon: FilePen },
  multi_edit: { labelKey: 'agent.chat.tool.multiEdit', icon: FilePen },
  get_console_errors: { labelKey: 'agent.chat.tool.consoleErrors', icon: Bug, runtime: true },
  read_console: { labelKey: 'agent.chat.tool.consoleOutput', icon: ScrollText, runtime: true },
  query_dom: { labelKey: 'agent.chat.tool.queryDom', icon: Code, runtime: true },
  eval_js: { labelKey: 'agent.chat.tool.evalJs', icon: SquareTerminal, runtime: true },
  read_network: { labelKey: 'agent.chat.tool.network', icon: Network, runtime: true },
  read_network_body: { labelKey: 'agent.chat.tool.responseBody', icon: Network, runtime: true },
  reload_and_verify: { labelKey: 'agent.chat.tool.reloadVerify', icon: RefreshCw, runtime: true },
  // Context MCP — reads of the live app (runtime spine) vs. stored state.
  browser_cookies: { labelKey: 'agent.chat.tool.cookies', icon: Cookie, runtime: true },
  browser_storage: { labelKey: 'agent.chat.tool.webStorage', icon: Database, runtime: true },
  list_tabs: { labelKey: 'agent.chat.tool.listTabs', icon: LayoutGrid, runtime: true },
  read_page: { labelKey: 'agent.chat.tool.readPage', icon: Globe, runtime: true },
  list_terminals: { labelKey: 'agent.chat.tool.listTerminals', icon: SquareTerminal, runtime: true },
  read_terminal: { labelKey: 'agent.chat.tool.readTerminal', icon: SquareTerminal, runtime: true },
  read_editor: { labelKey: 'agent.chat.tool.readEditor', icon: FileCode },
  read_explorer: { labelKey: 'agent.chat.tool.explorerState', icon: FolderTree },
  list_sessions: { labelKey: 'agent.chat.tool.listSessions', icon: History },
  read_session: { labelKey: 'agent.chat.tool.readSession', icon: History },
  delete_session: { labelKey: 'agent.chat.tool.deleteSession', icon: Trash2 },
  list_memory: { labelKey: 'agent.chat.tool.listMemory', icon: BookMarked },
  read_memory: { labelKey: 'agent.chat.tool.readMemory', icon: BookOpen },
  write_memory: { labelKey: 'agent.chat.tool.writeMemory', icon: NotebookPen },
  delete_memory: { labelKey: 'agent.chat.tool.deleteMemory', icon: Trash2 },
  // PC control (acts on the computer, outside the workspace).
  open_path: { labelKey: 'agent.chat.tool.openPath', icon: FolderOpen, runtime: true },
  open_external: { labelKey: 'agent.chat.tool.openExternal', icon: ExternalLink, runtime: true },
  reveal_in_explorer: { labelKey: 'agent.chat.tool.reveal', icon: FolderTree, runtime: true },
};

/** reload_and_verify's verdict, parsed from the server-formatted result — the
 * closed-loop highlight: did the fix actually clear the runtime error? */
export function reloadVerdict(text?: string): { variant: 'success' | 'warning'; labelKey: TranslationKey } | null {
  if (!text) return null;
  if (/^GONE\b/.test(text) || text.includes('No console errors after reload')) {
    return { variant: 'success', labelKey: 'agent.chat.badge.errorsGone' };
  }
  if (/^STILL PRESENT\b/.test(text)) return { variant: 'warning', labelKey: 'agent.chat.badge.stillPresent' };
  return null;
}

/** get_console_errors P1 confidence: did the stack map to a workspace file? */
export function sourceConfidence(text?: string): { variant: 'accent' | 'neutral'; labelKey: TranslationKey } | null {
  if (!text) return null;
  if (text.includes('confidence: high')) return { variant: 'accent', labelKey: 'agent.chat.badge.sourceMapped' };
  if (text.includes('confidence: low')) return { variant: 'neutral', labelKey: 'agent.chat.badge.noSource' };
  return null;
}

export function stringField(input: unknown, key: string): string {
  const v = input as Record<string, unknown> | null;
  return v && typeof v[key] === 'string' ? (v[key] as string) : '';
}

/**
 * Map a tool name to the AI-timeline hue token for its left-border accent.
 * Four categories (matching tokens.css --ai-thinking/grep/read/edit):
 *   thinking  → planning / reasoning tools
 *   grep      → search / list tools
 *   read      → read / query / observe tools
 *   edit      → write / mutate / runtime-act tools
 */
export function toolTimelineHue(name: string): 'thinking' | 'grep' | 'read' | 'edit' | null {
  if (!name) return null;
  // grep / search / list
  if (['grep', 'list_files', 'list_tabs', 'list_terminals', 'list_sessions', 'list_memory'].includes(name))
    return 'grep';
  // read / observe / query
  if ([
    'read_file', 'read_console', 'query_dom', 'read_network', 'read_network_body',
    'read_page', 'read_terminal', 'read_editor', 'read_explorer', 'read_session',
    'read_memory', 'browser_cookies', 'browser_storage', 'get_console_errors',
  ].includes(name))
    return 'read';
  // edit / mutate / act
  if ([
    'edit_file', 'multi_edit', 'eval_js', 'reload_and_verify', 'open_path',
    'open_external', 'reveal_in_explorer', 'write_memory', 'delete_memory',
    'delete_session',
  ].includes(name))
    return 'edit';
  return null;
}

/* ── completion receipt (Antigravity "Walkthrough" parity) ──────────────── */

export type Receipt = {
  runtime: number;
  verdict: { variant: 'success' | 'warning'; labelKey: TranslationKey } | null;
};

/**
 * Derive a runtime-verified outcome from a finished turn: how many CDP checks
 * touched the live app, plus the last reload-and-verify verdict. Returns null
 * unless the agent actually probed the running app or ran a verify pass — pure
 * edits are covered by the Changes review, and plain Q&A needs no receipt.
 */
export function buildReceipt(messages: AgentMessage[]): Receipt | null {
  let runtime = 0;
  let verdict: Receipt['verdict'] = null;
  for (const m of messages) {
    for (const part of m.parts) {
      if (part.type !== 'tool') continue;
      if (TOOL_META[part.call.name]?.runtime) runtime++;
      if (part.call.name === 'reload_and_verify') {
        const v = reloadVerdict(part.call.resultText);
        if (v) verdict = v;
      }
    }
  }
  if (runtime === 0 && !verdict) return null;
  return { runtime, verdict };
}
