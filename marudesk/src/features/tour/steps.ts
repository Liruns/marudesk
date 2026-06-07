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
    target: '[data-tour="workspace-rail"]',
    title: 'tour.step.workspaces.title',
    body: 'tour.step.workspaces.body',
  },
  { target: '[data-tour="tabs"]', title: 'tour.step.tabs.title', body: 'tour.step.tabs.body' },
  {
    target: '[data-tour="activity-bar"]',
    title: 'tour.step.activity.title',
    body: 'tour.step.activity.body',
  },
  { title: 'tour.step.done.title', body: 'tour.step.done.body' },
];
