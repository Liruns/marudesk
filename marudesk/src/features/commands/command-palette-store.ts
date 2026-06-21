import { create } from 'zustand';

/**
 * Open/closed state of the ⌘K command palette — Mission Control's "summon
 * anything" entry (docs/mission-control-redesign.md, Phase 4). With the tab strip
 * and rails gone, this is how surfaces that aren't a task's Resource (Settings, a
 * fresh AI Chat / CLI chat, a new editor, a blank web tab) are opened as
 * instruments. Kept as a tiny standalone store so the title-bar trigger, the
 * Ctrl/⌘+K shortcut, and the Shell-level overlay share one source of truth.
 */
type CommandPaletteState = {
  open: boolean;
  show: () => void;
  hide: () => void;
  toggle: () => void;
};

export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
