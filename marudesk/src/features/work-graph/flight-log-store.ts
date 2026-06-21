import { create } from 'zustand';

/**
 * Open/closed state of the Flight Log — the cross-node transcript overlay that
 * aggregates every Task's conversation in one place so flight-level context
 * isn't lost when chat is scoped per task (docs/mission-control-redesign.md,
 * Phase 2b). Kept as a tiny standalone store so the title-bar trigger and the
 * Shell-level overlay can talk without prop-drilling through the chrome.
 */
type FlightLogState = {
  open: boolean;
  show: () => void;
  hide: () => void;
  toggle: () => void;
};

export const useFlightLogStore = create<FlightLogState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
