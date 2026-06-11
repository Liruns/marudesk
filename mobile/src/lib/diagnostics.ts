export type DiagnosticLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export type DiagnosticLogEntry = {
  id: string;
  at: number;
  level: DiagnosticLogLevel;
  message: string;
};

type Listener = (logs: DiagnosticLogEntry[]) => void;

const MAX_LOGS = 200;
const logs: DiagnosticLogEntry[] = [];
const listeners = new Set<Listener>();
let installed = false;
let seq = 0;

export function pushDiagnosticLog(level: DiagnosticLogLevel, message: string): void {
  logs.push({ id: `${Date.now().toString(36)}-${++seq}`, at: Date.now(), level, message });
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  emit();
}

export function getDiagnosticLogs(): DiagnosticLogEntry[] {
  return [...logs];
}

export function subscribeDiagnosticLogs(listener: Listener): () => void {
  listeners.add(listener);
  listener(getDiagnosticLogs());
  return () => listeners.delete(listener);
}

export function clearDiagnosticLogs(): void {
  logs.splice(0, logs.length);
  emit();
}

export function installDiagnostics(): void {
  if (installed) return;
  installed = true;

  patchConsole('log');
  patchConsole('info');
  patchConsole('warn');
  patchConsole('error');
  patchConsole('debug');

  globalThis.addEventListener?.('error', (event) => {
    const message = event instanceof ErrorEvent
      ? `${event.message}${event.filename ? ` @ ${event.filename}:${event.lineno}` : ''}`
      : 'window error';
    pushDiagnosticLog('error', message);
  });

  globalThis.addEventListener?.('unhandledrejection', (event) => {
    pushDiagnosticLog('error', `unhandled rejection: ${formatValue(event.reason)}`);
  });

  pushDiagnosticLog('info', 'diagnostics installed');
}

function patchConsole(level: DiagnosticLogLevel): void {
  const original = console[level].bind(console) as (...args: unknown[]) => void;
  console[level] = (...args: unknown[]) => {
    original(...args);
    pushDiagnosticLog(level, args.map(formatValue).join(' '));
  };
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function emit(): void {
  const snapshot = getDiagnosticLogs();
  for (const listener of listeners) listener(snapshot);
}
