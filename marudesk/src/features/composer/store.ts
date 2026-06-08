import { create } from 'zustand';
import type { CapturePayload } from '../../../shared/composer';
import type { Capture } from '../../../shared/capture';

/**
 * Context-drawer tab state + the capture→payload mapping the agent reuses. The
 * one-shot "Quick patch" surface was removed (docs/agentic-chat-v2-design.md D1):
 * the agent subsumes it — selected captures attach to the agent's first turn —
 * so there's a single, model-first AI surface instead of two divergent ones.
 */

type ComposerTab = 'agent' | 'captures';

type ComposerState = {
  tab: ComposerTab;
};

type ComposerActions = {
  setTab: (tab: ComposerTab) => void;
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
  setTab: (tab) => set({ tab }),
}));
