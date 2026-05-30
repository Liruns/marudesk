/**
 * Thin renderer-side CDP client. Wraps `devtools:cdp-send` and unwraps its
 * `{ ok, value } | { ok, error }` envelope: a resolved value on success, a
 * thrown {@link CdpError} on a command failure. The envelope distinction matters
 * — a failed command is recoverable (the panel shows a non-blocking error row),
 * whereas a dead session arrives separately as `devtools:detached` and resets
 * the whole session machine. So callers `try/catch` around individual commands;
 * they never tear down state on a throw here.
 *
 * Request↔response correlation is free: the main relay awaits
 * `webContents.debugger.sendCommand`, whose promise already pairs them, so this
 * client only has to type the result.
 */

export class CdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CdpError';
  }
}

export async function cdpSend<T = unknown>(
  tabId: string,
  method: string,
  params?: object,
  sessionId?: string,
): Promise<T> {
  const res = await window.marudesk.invoke('devtools:cdp-send', {
    tabId,
    method,
    params,
    sessionId,
  });
  if (res.ok) return res.value as T;
  throw new CdpError(res.error);
}

/**
 * Fire a command and swallow any failure (used for best-effort `*.enable` /
 * highlight calls where a reject on a navigating page is harmless). Returns the
 * value on success, `undefined` on failure.
 */
export async function cdpTry<T = unknown>(
  tabId: string,
  method: string,
  params?: object,
  sessionId?: string,
): Promise<T | undefined> {
  try {
    return await cdpSend<T>(tabId, method, params, sessionId);
  } catch {
    return undefined;
  }
}
