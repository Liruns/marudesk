import { useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { Badge, Button, Drawer } from '../components/ui';
import { BrowserStage } from './BrowserStage';
import { useBrowserStore } from '../store/browser';
import { useBrowserEvents } from '../store/useBrowserEvents';
import type { Capture } from '../types/capture';

function CaptureCard({ capture }: { capture: Capture }) {
  const removeCapture = useBrowserStore((s) => s.removeCapture);

  return (
    <article className="rounded border border-subtle bg-surface-2 p-3 flex flex-col gap-2">
      <header className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Badge variant="accent">{capture.tagName}</Badge>
          <span className="text-caption text-fg-tertiary tabular-nums shrink-0">
            {Math.round(capture.rect.width)}×{Math.round(capture.rect.height)}
          </span>
        </div>
        <button
          type="button"
          onClick={() => removeCapture(capture.id)}
          aria-label="Remove capture"
          className="text-fg-tertiary hover:text-fg-primary transition-colors duration-fast shrink-0"
        >
          <X size={14} />
        </button>
      </header>
      <div className="font-mono text-caption text-fg-secondary break-all">
        {capture.selector || '(no selector)'}
      </div>
      {capture.text ? (
        <div className="text-body-sm text-fg-secondary line-clamp-2">
          {capture.text}
        </div>
      ) : null}
    </article>
  );
}

export function Shell() {
  useBrowserEvents();
  const [drawerOpen, setDrawerOpen] = useState(true);
  const captures = useBrowserStore((s) => s.captures);
  const clearCaptures = useBrowserStore((s) => s.clearCaptures);

  return (
    <div className="h-screen flex flex-col bg-surface-page text-fg-primary">
      <header className="h-12 shrink-0 flex items-center justify-between gap-4 px-4 bg-surface-1 border-b border-subtle">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="size-5 rounded bg-accent" />
          <span className="text-body-sm font-medium tracking-tight">marudesk</span>
          <span className="text-fg-tertiary text-body-sm">/</span>
          <span className="text-fg-tertiary text-body-sm">No workspace</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              window.location.hash = '/dev/components';
            }}
          >
            Components
          </Button>
          <Button variant="secondary" size="sm">
            Open workspace
          </Button>
          <Button
            variant={drawerOpen ? 'secondary' : 'primary'}
            size="sm"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-pressed={drawerOpen}
          >
            Context
            {captures.length > 0 ? (
              <span className="ml-1 rounded-pill bg-accent-subtle text-accent px-1.5 text-caption tabular-nums">
                {captures.length}
              </span>
            ) : null}
          </Button>
        </div>
      </header>

      <main
        className="flex-1 min-h-0 flex transition-[padding] duration-standard"
        style={{ paddingRight: drawerOpen ? 380 : 0 }}
      >
        <BrowserStage />
      </main>

      <Drawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        anchor="right"
        ariaLabel="Context cart"
      >
        <div className="flex flex-col h-full">
          <header className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-subtle">
            <div className="flex items-center gap-2">
              <h2 className="text-body-sm font-medium text-fg-primary">
                Context cart
              </h2>
              {captures.length > 0 ? (
                <Badge variant="neutral">{captures.length}</Badge>
              ) : null}
            </div>
            <div className="flex items-center gap-1">
              {captures.length > 0 ? (
                <button
                  type="button"
                  onClick={clearCaptures}
                  aria-label="Clear all captures"
                  className="text-fg-tertiary hover:text-fg-primary transition-colors duration-fast"
                >
                  <Trash2 size={14} />
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close"
                className="text-fg-tertiary hover:text-fg-primary transition-colors duration-fast text-body leading-none ml-1"
              >
                ×
              </button>
            </div>
          </header>
          <div className="flex-1 min-h-0 overflow-y-auto p-3">
            {captures.length === 0 ? (
              <div className="text-body-sm text-fg-tertiary p-3">
                Toggle Inspect, then click any element in the browser to capture
                it. Captures stack here as context for the Claude composer.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {captures.map((c) => (
                  <CaptureCard key={c.id} capture={c} />
                ))}
              </div>
            )}
          </div>
        </div>
      </Drawer>
    </div>
  );
}
