import { cn } from '../../lib/cn';

export const STEP_BTN = cn(
  'size-7 rounded flex items-center justify-center shrink-0',
  'text-fg-secondary hover:text-fg-primary hover:bg-surface-2',
  'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
  'transition-colors duration-fast',
);
