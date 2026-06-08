import type { StoreApi } from 'zustand';
import { toast } from '../../lib/toast';
import { toMessage } from '../../lib/toMessage';
import { useWebPageStore } from '../browser/store';
import { cdpSend, cdpTry } from './cdp';
import { consoleEntryToErrorCapture } from './capture';
import { entryId, msg, MAX_CONSOLE, MAX_HISTORY } from './store-internals';
import {
  COMMAND_LINE_API,
  dedupe,
  globalObjectProperties,
  MAX_COMPLETIONS,
  memberCompletions,
  parseCompletionContext,
  rankCompletions,
  type CompletionItem,
  type CompletionResult,
} from './console/completion';
import type { ConsoleEntry, RemoteObject } from './types';
import type { DevtoolsState, DevtoolsActions } from './store';

type DevtoolsStore = DevtoolsState & DevtoolsActions;
type SetState = StoreApi<DevtoolsStore>['setState'];
type GetState = StoreApi<DevtoolsStore>['getState'];

type ConsoleActions = Pick<
  DevtoolsActions,
  | '_pushConsole'
  | 'evaluate'
  | 'getCompletions'
  | 'clearConsole'
  | 'setPreserveLog'
  | 'setShowTimestamps'
  | 'setErrorCount'
  | 'captureConsoleError'
  | 'getProperties'
>;

/**
 * The Console panel actions for the devtools store: the console entry stream
 * (_pushConsole), REPL evaluate + autocomplete (getCompletions), log display
 * toggles, the always-on error-count mirror, "add error to AI context" capture,
 * and remote-object property expansion. Extracted from store.ts as a slice
 * creator; behavior is identical, with `set`/`get` passed in.
 */
export function createConsoleSlice(set: SetState, get: GetState): ConsoleActions {
  return {
    _pushConsole: (entry) => {
      const e: ConsoleEntry = {
        id: entryId(),
        timestamp: entry.timestamp ?? Date.now(),
        kind: entry.kind,
        args: entry.args,
        text: entry.text,
        stackTrace: entry.stackTrace,
        url: entry.url,
        lineNumber: entry.lineNumber,
      };
      const next = [...get().console, e];
      if (next.length > MAX_CONSOLE) next.splice(0, next.length - MAX_CONSOLE);
      set({ console: next });
    },

    evaluate: async (expression) => {
      const tabId = get().tabId;
      if (!tabId || !expression.trim()) return;
      await get()._ensureDomains(['Runtime']);
      // Record into history (most-recent last, de-duped against the previous
      // entry, capped) — drives ↑/↓ recall and history-backed completion.
      {
        const trimmed = expression.trim();
        const hist = get().commandHistory;
        if (hist[hist.length - 1] !== trimmed) {
          const next = [...hist, trimmed];
          if (next.length > MAX_HISTORY) next.splice(0, next.length - MAX_HISTORY);
          set({ commandHistory: next });
        }
      }
      get()._pushConsole({ kind: 'command', args: [], text: expression });
      try {
        const r = await cdpSend<{
          result: RemoteObject;
          exceptionDetails?: {
            text: string;
            exception?: RemoteObject;
            lineNumber?: number;
          };
        }>(tabId, 'Runtime.evaluate', {
          expression,
          objectGroup: 'console',
          includeCommandLineAPI: true,
          generatePreview: true,
          returnByValue: false,
          userGesture: true,
          awaitPromise: true,
          replMode: true,
        });
        if (r.exceptionDetails) {
          const ex = r.exceptionDetails.exception;
          get()._pushConsole({
            kind: 'exception',
            args: ex ? [ex] : [],
            text: ex ? undefined : r.exceptionDetails.text,
          });
        } else {
          get()._pushConsole({ kind: 'result', args: [r.result] });
        }
      } catch (err) {
        get()._pushConsole({
          kind: 'error',
          args: [],
          text: toMessage(err),
        });
      }
    },

    getCompletions: async (input, caret, force = false) => {
      const empty: CompletionResult = { prefix: '', items: [] };
      const tabId = get().tabId;
      if (!tabId) return empty;
      const ctx = parseCompletionContext(input, caret, force);
      if (!ctx) return empty;

      // Member completion: `obj.frag` / `obj[frag` → properties of the receiver.
      if (ctx.kind === 'member') {
        const names = await memberCompletions(tabId, ctx.receiver);
        const items = names.map(
          (text): CompletionItem => ({ text, kind: 'property', replace: 'token' }),
        );
        return rankCompletions(ctx.prefix, dedupe(items));
      }

      // Global completion: lexical names + global-object props + Command Line API
      // helpers, ranked by the typed token. Each replaces just the token.
      const identifiers: CompletionItem[] = [];
      const lexical = await cdpTry<{ names: string[] }>(
        tabId,
        'Runtime.globalLexicalScopeNames',
      );
      for (const n of lexical?.names ?? [])
        identifiers.push({ text: n, kind: 'global', replace: 'token' });

      const globals = await globalObjectProperties(tabId);
      for (const n of globals) identifiers.push({ text: n, kind: 'global', replace: 'token' });

      for (const n of COMMAND_LINE_API)
        identifiers.push({ text: n, kind: 'command-api', replace: 'token' });

      const ranked = rankCompletions(ctx.prefix, dedupe(identifiers));

      // History entries (the UI prefixes them with `>`) recall a WHOLE prior
      // command, so they match against the full pre-caret input and replace it
      // all. Appended after identifier matches and de-duped against them.
      const full = input.slice(0, Math.max(0, caret)).trimStart();
      const taken = new Set(ranked.items.map((i) => i.text));
      const history: CompletionItem[] = [];
      if (full) {
        const seen = new Set<string>();
        // Most-recent first for history.
        for (let i = get().commandHistory.length - 1; i >= 0; i--) {
          const h = get().commandHistory[i];
          if (h === full || seen.has(h) || taken.has(h)) continue;
          if (h.startsWith(full)) {
            seen.add(h);
            history.push({ text: h, kind: 'history', replace: 'all' });
          }
        }
      }

      return {
        prefix: ctx.prefix,
        items: [...ranked.items, ...history].slice(0, MAX_COMPLETIONS),
      };
    },

    clearConsole: () => set({ console: [] }),

    setPreserveLog: (on) => set({ preserveLog: on }),

    setShowTimestamps: (on) => set({ showTimestamps: on }),

    setErrorCount: (tabId, count) =>
      set((s) => {
        if (s.errorCountByTab[tabId] === count) return {};
        return { errorCountByTab: { ...s.errorCountByTab, [tabId]: count } };
      }),

    captureConsoleError: (entryId) => {
      const entry = get().console.find((e) => e.id === entryId);
      if (!entry || (entry.kind !== 'error' && entry.kind !== 'exception')) return;
      // Page URL (not the script URL) — its origin drives the deterministic
      // stack→workspace-file resolution in electron/llm.ts.
      const url = useWebPageStore.getState().currentUrl;
      const capture = consoleEntryToErrorCapture(entry, url);
      useWebPageStore.getState().addCapture(capture);
      toast({
        title: msg('devtools.toast.addedToContext'),
        description: capture.message.slice(0, 80),
        variant: 'success',
      });
    },

    getProperties: async (objectId) => {
      const tabId = get().tabId;
      if (!tabId) return [];
      const res = await cdpTry<{
        result: { name: string; value?: RemoteObject; enumerable: boolean }[];
      }>(tabId, 'Runtime.getProperties', {
        objectId,
        ownProperties: true,
        generatePreview: true,
      });
      if (!res?.result) return [];
      // Own, value-bearing properties (skip accessors without a value).
      return res.result
        .filter((p) => p.value !== undefined)
        .map((p) => ({ name: p.name, value: p.value as RemoteObject }));
    },
  };
}
