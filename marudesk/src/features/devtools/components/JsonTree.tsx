import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../../lib/cn';
import type { JsonValue } from '../json-value';

/**
 * A collapsible JSON tree for already-parsed payloads (Network response bodies,
 * WS/SSE frame payloads — parse via ../json-value's parseJsonContainer). Unlike
 * RemoteValue (which walks live page objects via Runtime.getProperties), this
 * renders a plain local value — no CDP round-trips. Nodes above
 * {@link DEFAULT_OPEN_DEPTH} start expanded; everything deeper is a click away.
 * Value colours follow the console's convention (RemoteValue): strings success,
 * numbers/booleans accent, null tertiary.
 */

const DEFAULT_OPEN_DEPTH = 2;

function leafClass(value: string | number | boolean | null): string {
  if (value === null) return 'text-fg-tertiary';
  if (typeof value === 'string') return 'text-success';
  return 'text-accent';
}

function leafText(value: string | number | boolean | null): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function summary(value: JsonValue[] | { [key: string]: JsonValue }): string {
  if (Array.isArray(value)) return `[…] (${value.length})`;
  return `{…} (${Object.keys(value).length})`;
}

function JsonNode({
  name,
  value,
  depth,
}: {
  name: string | null;
  value: JsonValue;
  depth: number;
}) {
  const container = typeof value === 'object' && value !== null;
  const [open, setOpen] = useState(depth < DEFAULT_OPEN_DEPTH);

  const label =
    name !== null ? (
      <>
        <span className="text-fg-secondary">{name}</span>
        <span className="text-fg-tertiary">: </span>
      </>
    ) : null;

  if (!container) {
    return (
      <div className="font-mono text-caption leading-snug break-all">
        {label}
        <span className={leafClass(value)}>{leafText(value)}</span>
      </div>
    );
  }

  const entries: [string, JsonValue][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value);

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-start gap-0.5 text-left font-mono text-caption leading-snug hover:text-fg-primary"
      >
        <ChevronRight
          size={12}
          className={cn('mt-0.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <span className="break-all">
          {label}
          <span className="text-fg-tertiary">
            {open ? (Array.isArray(value) ? '[' : '{') : summary(value)}
          </span>
        </span>
      </button>
      {open ? (
        <>
          <div className="pl-4 border-l border-subtle/60 ml-1.5">
            {entries.length === 0 ? (
              <div className="font-mono text-caption text-fg-tertiary">(empty)</div>
            ) : (
              entries.map(([k, v]) => <JsonNode key={k} name={k} value={v} depth={depth + 1} />)
            )}
          </div>
          <div className="font-mono text-caption text-fg-tertiary pl-3.5">
            {Array.isArray(value) ? ']' : '}'}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function JsonTree({ value }: { value: JsonValue }) {
  return <JsonNode name={null} value={value} depth={0} />;
}
