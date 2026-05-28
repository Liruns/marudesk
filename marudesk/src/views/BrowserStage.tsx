import { useEffect, useRef, type FormEvent } from 'react';
import { ArrowRight, MousePointerClick } from 'lucide-react';
import { Button } from '../components/ui';
import { cn } from '../lib/cn';
import { useBrowserStore } from '../store/browser';

export function BrowserStage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingUrl = useBrowserStore((s) => s.pendingUrl);
  const currentUrl = useBrowserStore((s) => s.currentUrl);
  const inspectMode = useBrowserStore((s) => s.inspectMode);
  const setPendingUrl = useBrowserStore((s) => s.setPendingUrl);
  const commitNavigate = useBrowserStore((s) => s.commitNavigate);
  const toggleInspect = useBrowserStore((s) => s.toggleInspect);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const sendBounds = () => {
      const rect = el.getBoundingClientRect();
      void window.marudesk.invoke('browser:set-bounds', {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };

    sendBounds();
    const ro = new ResizeObserver(sendBounds);
    ro.observe(el);
    window.addEventListener('resize', sendBounds);
    window.addEventListener('scroll', sendBounds, true);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', sendBounds);
      window.removeEventListener('scroll', sendBounds, true);
      void window.marudesk.invoke('browser:set-bounds', {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });
    };
  }, []);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void commitNavigate();
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col gap-3 p-4">
      <form
        onSubmit={onSubmit}
        className="flex items-center gap-2 shrink-0"
        role="search"
      >
        <input
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://example.com"
          value={pendingUrl}
          onChange={(e) => setPendingUrl(e.target.value)}
          className={cn(
            'h-8 flex-1 min-w-0 rounded bg-surface-3 border border-default px-3',
            'text-body-sm text-fg-primary placeholder:text-fg-tertiary',
            'font-mono tabular-nums',
            'focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent',
            'transition-colors duration-fast',
          )}
          aria-label="Address"
        />
        <Button
          variant="secondary"
          size="sm"
          type="submit"
          trailingIcon={<ArrowRight size={14} />}
        >
          Go
        </Button>
        <Button
          variant={inspectMode ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => void toggleInspect()}
          leadingIcon={<MousePointerClick size={14} />}
          aria-pressed={inspectMode}
        >
          {inspectMode ? 'Inspect on' : 'Inspect'}
        </Button>
      </form>

      <div
        ref={containerRef}
        className={cn(
          'flex-1 min-h-0 rounded border bg-surface-1 relative overflow-hidden',
          inspectMode ? 'border-accent shadow-glow' : 'border-default',
          'transition-colors duration-fast',
        )}
        aria-label="Browser stage"
      >
        {!currentUrl ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-8 pointer-events-none">
            <span className="text-caption uppercase tracking-wider text-fg-tertiary">
              Browser stage
            </span>
            <h2 className="text-title text-fg-secondary">No page loaded</h2>
            <p className="text-body-sm text-fg-tertiary max-w-md">
              Enter a URL above and press Go to mount a page. Toggle Inspect to
              capture elements into the context cart.
            </p>
          </div>
        ) : null}
        {inspectMode ? (
          <div className="absolute top-2 left-2 z-10 pointer-events-none">
            <span className="inline-flex items-center gap-1.5 rounded-pill bg-accent-subtle text-accent text-caption font-medium px-2 py-0.5">
              <span className="size-1.5 rounded-pill bg-accent" />
              Inspect — click an element, Esc to exit
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
