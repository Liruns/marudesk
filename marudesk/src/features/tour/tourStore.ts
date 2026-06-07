import { create } from 'zustand';

/**
 * Interactive product tour state. A step-through spotlight over the real chrome
 * (workspace rail, tabs, activity bar). Opt-in: launched from the first-run guide
 * ("Take a tour"); a localStorage flag remembers it was seen.
 */

const SEEN_KEY = 'marudesk.tour.v1';

export function hasSeenTour(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true;
  }
}

function markTourSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // ignore
  }
}

type TourState = {
  readonly open: boolean;
  readonly start: () => void;
  readonly close: () => void;
};

export const useTourStore = create<TourState>((set) => ({
  open: false,
  start: () => set({ open: true }),
  close: () => {
    markTourSeen();
    set({ open: false });
  },
}));
