import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import type { ObjectPreview, RemoteObject } from '../types';

/**
 * Renders a CDP RemoteObject the way the console does: a coloured inline summary
 * for primitives, and an expandable one-line preview for objects/arrays (click
 * to fetch own properties via `Runtime.getProperties`). Recursion is bounded by
 * `depth` so a self-referential object can't expand forever.
 */

function previewToString(p: ObjectPreview): string {
  if (p.subtype === 'array') {
    const vals = p.properties.map((pr) =>
      pr.type === 'string' ? `"${pr.value}"` : (pr.value ?? pr.type),
    );
    return `[${vals.join(', ')}${p.overflow ? ', …' : ''}]`;
  }
  const entries = p.properties.map((pr) =>
    pr.type === 'string'
      ? `${pr.name}: "${pr.value}"`
      : `${pr.name}: ${pr.value ?? pr.type}`,
  );
  const name = p.description && p.description !== 'Object' ? `${p.description} ` : '';
  return `${name}{${entries.join(', ')}${p.overflow ? ', …' : ''}}`;
}

function inlineText(obj: RemoteObject): string {
  switch (obj.type) {
    case 'string':
      return (obj.value as string) ?? obj.description ?? '';
    case 'number':
    case 'boolean':
      return String(obj.value ?? obj.description ?? '');
    case 'undefined':
      return 'undefined';
    case 'symbol':
    case 'bigint':
      return obj.description ?? String(obj.value ?? '');
    case 'function':
      return (obj.description ?? 'ƒ').split('{')[0].trim() || 'ƒ';
    case 'object':
      if (obj.subtype === 'null') return 'null';
      if (obj.preview) return previewToString(obj.preview);
      return obj.description ?? obj.className ?? 'Object';
    default:
      return obj.description ?? obj.type;
  }
}

function colorClass(obj: RemoteObject): string {
  switch (obj.type) {
    case 'string':
      return 'text-success';
    case 'number':
    case 'boolean':
      return 'text-accent';
    case 'function':
      return 'text-warning italic';
    case 'undefined':
      return 'text-fg-tertiary';
    case 'object':
      return obj.subtype === 'null' ? 'text-fg-tertiary' : 'text-fg-secondary';
    default:
      return 'text-fg-secondary';
  }
}

export function RemoteValue({
  obj,
  expandable = false,
  depth = 0,
}: {
  obj: RemoteObject;
  expandable?: boolean;
  depth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [props, setProps] = useState<{ name: string; value: RemoteObject }[] | null>(
    null,
  );
  const canExpand =
    expandable &&
    depth < 4 &&
    obj.type === 'object' &&
    obj.subtype !== 'null' &&
    !!obj.objectId;

  const toggle = async () => {
    if (!open && props === null && obj.objectId) {
      setProps(await useDevtoolsStore.getState().getProperties(obj.objectId));
    }
    setOpen((o) => !o);
  };

  if (!canExpand) {
    return <span className={cn('font-mono', colorClass(obj))}>{inlineText(obj)}</span>;
  }

  return (
    <span className="inline-flex flex-col align-top">
      <button
        type="button"
        onClick={toggle}
        className="inline-flex items-start gap-0.5 text-left hover:text-fg-primary"
      >
        <ChevronRight
          size={12}
          className={cn('mt-0.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <span className={cn('font-mono', colorClass(obj))}>{inlineText(obj)}</span>
      </button>
      {open && props ? (
        <span className="flex flex-col gap-0.5 pl-4 mt-0.5">
          {props.length === 0 ? (
            <span className="text-caption text-fg-tertiary font-mono">(no properties)</span>
          ) : (
            props.map((p) => (
              <span key={p.name} className="flex items-start gap-1 font-mono text-caption">
                <span className="text-fg-tertiary shrink-0">{p.name}:</span>
                <RemoteValue obj={p.value} expandable depth={depth + 1} />
              </span>
            ))
          )}
        </span>
      ) : null}
    </span>
  );
}
