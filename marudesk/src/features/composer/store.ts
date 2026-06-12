import { create } from 'zustand';
import type { CapturePayload } from '../../../shared/composer';
import type { Capture } from '../../../shared/capture';

/**
 * Context-drawer tab state + the capture→payload mapping the agent reuses. The
 * one-shot "Quick patch" surface was removed (docs/agentic-chat-v2-design.md D1):
 * the agent subsumes it — selected captures attach to the agent's first turn —
 * so there's a single, model-first AI surface instead of two divergent ones.
 */

type ComposerTab = 'agent' | 'captures' | 'supervisor' | 'specs';

type ComposerState = {
  tab: ComposerTab;
  /**
   * Monotonic counter bumped to ask the shell to open the context drawer — used
   * when a stage element pick would otherwise be invisible behind a collapsed
   * drawer. A counter (not a boolean) so a repeat pick re-opens it. Mirrors the
   * address-bar / find focus nonces in the web-page store.
   */
  drawerOpenNonce: number;
};

type ComposerActions = {
  setTab: (tab: ComposerTab) => void;
  /**
   * Reveal a just-captured element: switch to the Captures tab (its action home —
   * comment, "Send to agent", source ranking) and ask the shell to open the
   * drawer. The stagewise "select on the page → hand it to the agent" moment.
   */
  revealCaptures: () => void;
};

/** Map a renderer {@link Capture} to the lean payload attached to an agent turn. */
export function toPayload(capture: Capture): CapturePayload {
  if (capture.kind === 'console-error') {
    return {
      kind: 'console-error',
      id: capture.id,
      url: capture.url,
      comment: capture.comment,
      message: capture.message,
      stack: capture.stack,
      source: capture.source,
    };
  }
  if (capture.kind === 'terminal-error') {
    return {
      kind: 'terminal-error',
      id: capture.id,
      url: capture.url,
      comment: capture.comment,
      message: capture.message,
      excerpt: capture.excerpt,
      terminalId: capture.terminalId,
      shell: capture.shell,
      cwd: capture.cwd,
    };
  }
  return {
    kind: 'element',
    id: capture.id,
    url: capture.url,
    comment: capture.comment,
    tagName: capture.tagName,
    selector: capture.selector,
    text: capture.text,
    attributes: capture.attributes,
    outerHTML: capture.outerHTML,
    computedStyle: capture.computedStyle,
  };
}

export const useComposerStore = create<ComposerState & ComposerActions>((set) => ({
  tab: 'agent',
  drawerOpenNonce: 0,
  setTab: (tab) => set({ tab }),
  revealCaptures: () =>
    set((s) => ({ tab: 'captures', drawerOpenNonce: s.drawerOpenNonce + 1 })),
}));
