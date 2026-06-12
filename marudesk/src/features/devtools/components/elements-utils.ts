import type { AXValue, EventListenerInfo } from '../types';

/**
 * Pure helpers for the Elements side panes (event listeners, accessibility,
 * fonts, layout overlays) and the DOM-editing actions. No store/CDP imports so
 * they stay trivially unit-testable.
 */

/** Read one attribute from CDP's flat `[name, value, name, value, …]` array. */
export function getAttr(attrs: string[] | undefined, name: string): string | undefined {
  if (!attrs) return undefined;
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] === name) return attrs[i + 1] ?? '';
  }
  return undefined;
}

/**
 * Toggle `visibility: hidden` inside an inline `style` attribute value,
 * preserving the other declarations. Used by "Hide element" (H): a hidden
 * element gets the declaration removed, anything else gets it appended (an
 * existing non-hidden `visibility` declaration is replaced — re-toggling then
 * removes it entirely, so the original value is not restored; acceptable for a
 * debugging affordance). Returns the new attribute value ('' = remove the attr).
 */
export function toggleVisibilityHidden(style: string | undefined): string {
  const decls = (style ?? '')
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  const idx = decls.findIndex(
    (d) => d.slice(0, d.indexOf(':')).trim().toLowerCase() === 'visibility',
  );
  if (idx >= 0) {
    const value = decls[idx].slice(decls[idx].indexOf(':') + 1).trim().toLowerCase();
    if (value === 'hidden') {
      decls.splice(idx, 1);
    } else {
      decls[idx] = 'visibility: hidden';
    }
  } else {
    decls.push('visibility: hidden');
  }
  return decls.join('; ');
}

/** Group listeners by event type, types sorted alphabetically. */
export function groupListenersByType(
  listeners: EventListenerInfo[],
): [string, EventListenerInfo[]][] {
  const byType = new Map<string, EventListenerInfo[]>();
  for (const l of listeners) {
    const group = byType.get(l.type);
    if (group) group.push(l);
    else byType.set(l.type, [l]);
  }
  return [...byType.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** The last path segment of a URL (or its host when the path is bare). */
export function fileNameOfUrl(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? u.host;
  } catch {
    return url;
  }
}

/**
 * `file.js:12:3` for a listener whose script URL is known (resolved via the
 * store's Debugger script map — best-effort: empty until the Sources panel has
 * enabled the Debugger domain), else a `VM<scriptId>` placeholder like Chrome.
 */
export function formatListenerLocation(
  listener: EventListenerInfo,
  url: string | undefined,
): string {
  const base = url ? fileNameOfUrl(url) : `VM${listener.scriptId}`;
  return `${base}:${listener.lineNumber + 1}:${listener.columnNumber + 1}`;
}

/** First line of a function's `description`, truncated for the row preview. */
export function handlerPreview(description: string | undefined, max = 80): string {
  if (!description) return '';
  const line = description.split('\n', 1)[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Render an AXValue's payload as display text ('' when there is no value). */
export function formatAxValue(value: AXValue | undefined): string {
  if (!value || value.value === undefined) return '';
  const v = value.value;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Classify a computed `display` value as a grid/flex container (or neither). */
export function layoutKind(display: string | undefined | null): 'grid' | 'flex' | null {
  if (!display) return null;
  if (display === 'grid' || display === 'inline-grid') return 'grid';
  if (display === 'flex' || display === 'inline-flex') return 'flex';
  return null;
}
