import type { ConsoleKind } from './types';

/**
 * Map the two CDP console sources to the panel's {@link ConsoleKind}. They stay
 * distinct because the wire vocabularies differ: `Runtime.consoleAPICalled`
 * carries `assert`/`debug`/`info`, while `Log.entryAdded` uses `verbose` and has
 * no explicit info level.
 */

/** `Runtime.consoleAPICalled` `type` → kind. */
export function consoleKindFromApi(type: string): ConsoleKind {
  switch (type) {
    case 'error':
    case 'assert':
      return 'error';
    case 'warning':
      return 'warning';
    case 'debug':
      return 'debug';
    case 'info':
      return 'info';
    default:
      return 'log';
  }
}

/** `Log.entryAdded` `level` → kind. */
export function consoleKindFromLog(level: string): ConsoleKind {
  switch (level) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'verbose':
      return 'debug';
    default:
      return 'info';
  }
}
