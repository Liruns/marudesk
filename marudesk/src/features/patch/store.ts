import { create } from 'zustand';
import type {
  ApplyResult,
  PatchOp,
  PatchPreview,
} from '../../../shared/patch';
import { toMessage } from '../../lib/toMessage';

type PatchState = {
  opsText: string;
  parseError: string | null;
  preview: PatchPreview | null;
  previewing: boolean;
  applying: boolean;
  lastResult: ApplyResult | null;
};

type PatchActions = {
  setOpsText: (text: string) => void;
  setOps: (ops: PatchOp[]) => void;
  runPreview: () => Promise<void>;
  runApply: () => Promise<void>;
  reset: () => void;
};

function parseOps(text: string): { ops: PatchOp[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: `JSON parse error: ${toMessage(err)}` };
  }
  if (!Array.isArray(parsed)) {
    return { error: 'top-level value must be an array of ops' };
  }
  const ops: PatchOp[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const v = parsed[i];
    if (!v || typeof v !== 'object') {
      return { error: `ops[${i}] must be an object` };
    }
    const o = v as Record<string, unknown>;
    if (typeof o.path !== 'string' || o.path.length === 0) {
      return { error: `ops[${i}].path must be a non-empty string` };
    }
    if (typeof o.oldString !== 'string') {
      return { error: `ops[${i}].oldString must be a string` };
    }
    if (typeof o.newString !== 'string') {
      return { error: `ops[${i}].newString must be a string` };
    }
    ops.push({
      path: o.path,
      oldString: o.oldString,
      newString: o.newString,
    });
  }
  return { ops };
}

export const usePatchStore = create<PatchState & PatchActions>((set, get) => ({
  opsText: '',
  parseError: null,
  preview: null,
  previewing: false,
  applying: false,
  lastResult: null,

  setOpsText: (opsText) =>
    set({
      opsText,
      parseError: null,
      preview: null,
      lastResult: null,
    }),

  setOps: (ops) =>
    set({
      opsText: JSON.stringify(ops, null, 2),
      parseError: null,
      preview: null,
      lastResult: null,
    }),

  runPreview: async () => {
    const { opsText, previewing } = get();
    if (previewing) return;
    const parsed = parseOps(opsText);
    if ('error' in parsed) {
      set({ parseError: parsed.error, preview: null });
      return;
    }
    set({ parseError: null, previewing: true, lastResult: null });
    try {
      const preview = await window.marudesk.invoke(
        'patch:preview',
        parsed.ops,
      );
      set({ preview });
    } catch (err) {
      set({
        parseError: toMessage(err),
        preview: null,
      });
    } finally {
      set({ previewing: false });
    }
  },

  runApply: async () => {
    const { opsText, applying, preview } = get();
    if (applying) return;
    if (!preview || preview.hasErrors) return;
    const parsed = parseOps(opsText);
    if ('error' in parsed) {
      set({ parseError: parsed.error });
      return;
    }
    set({ applying: true, lastResult: null });
    try {
      const result = await window.marudesk.invoke(
        'patch:apply',
        parsed.ops,
      );
      set({ lastResult: result });
      // Refresh preview to reflect new disk state (or surface any residual mismatch).
      const fresh = await window.marudesk.invoke(
        'patch:preview',
        parsed.ops,
      );
      set({ preview: fresh });
    } catch (err) {
      set({
        lastResult: {
          ok: false,
          applied: [],
          errors: [{ path: '(invoke)', reason: toMessage(err) }],
        },
      });
    } finally {
      set({ applying: false });
    }
  },

  reset: () =>
    set({
      opsText: '',
      parseError: null,
      preview: null,
      previewing: false,
      applying: false,
      lastResult: null,
    }),
}));
