/**
 * Turn a raw IPC/exception message into user-facing copy.
 *
 * Electron's `ipcRenderer.invoke` rejections arrive with the transport
 * scaffolding attached, e.g.
 *   "Error invoking remote method 'git:status': Error: git:status: no workspace is open"
 * — channel names and duplicated "Error:" prefixes that should never reach a
 * user. This strips that scaffolding down to the human sentence. Callers handle
 * known, actionable cases (e.g. no workspace) with a dedicated empty state via
 * {@link isNoWorkspaceError} BEFORE falling back to this generic cleanup.
 */
function toRaw(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Error) return raw.message;
  return String(raw ?? '');
}

export function humanizeError(raw: unknown): string {
  let s = toRaw(raw);
  // Drop the Electron remote-invoke wrapper: "Error invoking remote method 'x':".
  s = s.replace(/^Error invoking remote method\s+'[^']*':\s*/i, '');
  // Collapse one or more leading "Error:" prefixes (the wrapper re-stringifies).
  s = s.replace(/^(?:Error:\s*)+/i, '');
  // Strip a leading "channel:method: " tag (e.g. "git:status: "). Conservative:
  // both segments must be alphanumeric/dash so URLs ("https://…") are untouched.
  s = s.replace(/^[a-z][a-z0-9-]*:[a-z0-9-]+:\s*/i, '');
  s = s.trim();
  if (!s) return '';
  // Capitalize the first letter for a sentence-like read, but only when the
  // first token is plain words — never rewrite a URL/identifier ("https://…").
  const firstToken = s.split(/\s+/, 1)[0] ?? '';
  if (/^[a-z][a-z']*$/.test(firstToken)) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  return s;
}

/** True when an error indicates there is no workspace/folder open. */
export function isNoWorkspaceError(raw: unknown): boolean {
  return /no workspace/i.test(toRaw(raw));
}
