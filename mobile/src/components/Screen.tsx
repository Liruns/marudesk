import type { ReactNode } from 'react';

/**
 * Standard mobile screen shell: a fixed top bar (safe-area padded) + a scrollable
 * body. Screens that own their own footer (Chat's composer) pass `noScroll` and
 * lay out their own flex column inside `children`.
 */
export function Screen({
  title,
  left,
  right,
  children,
  noScroll = false,
}: {
  title?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  noScroll?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {(title || left || right) && (
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: 'calc(var(--safe-top) + 8px) 10px 8px',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--surface-glass)',
            boxShadow: 'var(--highlight)',
            minHeight: 'calc(var(--safe-top) + 50px)',
            flexShrink: 0,
          }}
        >
          <div style={{ minWidth: 40, display: 'flex' }}>{left}</div>
          <div style={{ flex: 1, fontWeight: 500, fontSize: 14, textAlign: 'center' }}>{title}</div>
          <div style={{ minWidth: 40, display: 'flex', justifyContent: 'flex-end' }}>{right}</div>
        </header>
      )}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: noScroll ? 'hidden' : 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </div>
    </div>
  );
}
