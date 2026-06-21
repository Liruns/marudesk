import type { TranslationKey } from '../../i18n/messages';

/**
 * Tour steps. `target` is a CSS selector for a `data-tour` anchor on the chrome;
 * a step with no target (or whose anchor isn't on screen) renders centered, so
 * the tour degrades gracefully instead of breaking.
 */
export type TourStep = {
  readonly target?: string;
  readonly title: TranslationKey;
  readonly body: TranslationKey;
};

export const TOUR_STEPS: readonly TourStep[] = [
  { title: 'tour.step.welcome.title', body: 'tour.step.welcome.body' },
  {
    target: '[data-tour="command-palette"]',
    title: 'tour.step.palette.title',
    body: 'tour.step.palette.body',
  },
  {
    target: '[data-tour="goal"]',
    title: 'tour.step.goal.title',
    body: 'tour.step.goal.body',
  },
  // Anchorless (centered) steps teach the implement → review → apply → commit
  // spine. They have no `target` so they render even on the empty-graph first
  // run, where no task is selected and the Instrument Dock isn't mounted.
  { title: 'tour.step.implement.title', body: 'tour.step.implement.body' },
  { title: 'tour.step.apply.title', body: 'tour.step.apply.body' },
  {
    target: '[data-tour="workspace"]',
    title: 'tour.step.workspace.title',
    body: 'tour.step.workspace.body',
  },
  {
    target: '[data-tour="flight-log"]',
    title: 'tour.step.flightLog.title',
    body: 'tour.step.flightLog.body',
  },
  { title: 'tour.step.done.title', body: 'tour.step.done.body' },
];
