import { useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  DiffBlock,
  Drawer,
  Spinner,
  Surface,
  Toast,
  type DiffLine,
} from '../components/ui';
import { ArrowRight, Plus, Search } from 'lucide-react';

const SAMPLE_DIFF: DiffLine[] = [
  { kind: 'context', oldLineNumber: 12, newLineNumber: 12, content: 'function Button(props) {' },
  { kind: 'context', oldLineNumber: 13, newLineNumber: 13, content: '  const { children, variant = "primary" } = props;' },
  { kind: 'remove', oldLineNumber: 14, content: '  return <button>{children}</button>;' },
  { kind: 'add', newLineNumber: 14, content: '  return <button className={variant}>{children}</button>;' },
  { kind: 'context', oldLineNumber: 15, newLineNumber: 15, content: '}' },
];

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-title font-medium tracking-tight text-fg-primary">
          {title}
        </h2>
        {hint ? <p className="text-body-sm text-fg-tertiary">{hint}</p> : null}
      </header>
      <div className="flex flex-wrap items-start gap-4">{children}</div>
    </section>
  );
}

export function ComponentGallery() {
  const [drawerRight, setDrawerRight] = useState(false);
  const [drawerBottom, setDrawerBottom] = useState(false);
  const [toasts, setToasts] = useState<number[]>([0]);

  return (
    <div className="min-h-screen bg-surface-page text-fg-primary">
      <header className="sticky top-0 z-10 h-12 flex items-center justify-between gap-4 px-6 bg-surface-1 border-b border-subtle backdrop-blur">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="size-5 rounded bg-accent" />
          <span className="text-body-sm font-medium tracking-tight">
            Maru
          </span>
          <span className="text-fg-tertiary text-body-sm">/</span>
          <span className="text-fg-secondary text-body-sm">components</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            window.location.hash = '/';
          }}
        >
          Back to shell
        </Button>
      </header>

      <div className="mx-auto max-w-[1080px] px-6 py-10 flex flex-col gap-12">
        <div className="flex flex-col gap-2">
          <span className="text-caption uppercase tracking-wider text-fg-tertiary">
            Phase 0
          </span>
          <h1 className="text-hero font-medium tracking-tight">Component gallery</h1>
          <p className="text-body text-fg-secondary max-w-2xl">
            All seven base components rendered with their variants. Built on design
            tokens — no hardcoded hex. Sourced from DESIGN.md §4.
          </p>
        </div>

        <Section title="Buttons" hint="Primary, secondary, ghost. Sizes sm, md, lg.">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Button variant="primary" size="sm">Primary sm</Button>
              <Button variant="primary" size="md">Primary md</Button>
              <Button variant="primary" size="lg">Primary lg</Button>
            </div>
            <div className="flex items-center gap-3">
              <Button variant="secondary" size="sm">Secondary sm</Button>
              <Button variant="secondary" size="md">Secondary md</Button>
              <Button variant="secondary" size="lg">Secondary lg</Button>
            </div>
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="sm">Ghost sm</Button>
              <Button variant="ghost" size="md">Ghost md</Button>
              <Button variant="ghost" size="lg">Ghost lg</Button>
            </div>
            <div className="flex items-center gap-3">
              <Button variant="primary" leadingIcon={<Plus size={14} />}>
                With leading
              </Button>
              <Button variant="secondary" trailingIcon={<ArrowRight size={14} />}>
                With trailing
              </Button>
              <Button variant="primary" disabled>
                Disabled
              </Button>
            </div>
          </div>
        </Section>

        <Section title="Surfaces" hint="Panel, card, inset — three depth levels.">
          <Surface variant="panel" className="w-64 p-4">
            <div className="text-body-sm font-medium">Panel</div>
            <div className="text-caption text-fg-tertiary mt-1">surface-1</div>
          </Surface>
          <Surface variant="card" className="w-64 p-4">
            <div className="text-body-sm font-medium">Card</div>
            <div className="text-caption text-fg-tertiary mt-1">surface-2</div>
          </Surface>
          <Surface variant="inset" className="w-64 p-4">
            <div className="text-body-sm font-medium">Inset</div>
            <div className="text-caption text-fg-tertiary mt-1">surface-3</div>
          </Surface>
        </Section>

        <Section title="Drawer" hint="Slides from right (380px) or bottom (360px). Escape to close.">
          <Button variant="secondary" onClick={() => setDrawerRight(true)}>
            Open right drawer
          </Button>
          <Button variant="secondary" onClick={() => setDrawerBottom(true)}>
            Open bottom drawer
          </Button>
        </Section>

        <Section title="Diff block" hint="File header + line-numbered diff body with add/remove bars.">
          <DiffBlock
            filePath="src/components/ui/Button.tsx"
            lines={SAMPLE_DIFF}
            className="w-full"
          />
        </Section>

        <Section title="Spinner" hint="AI Timeline four-color quad-arc. Sizes 12/16/24/32.">
          <div className="flex items-center gap-6">
            <Spinner size={12} />
            <Spinner size={16} />
            <Spinner size={24} />
            <Spinner size={32} />
          </div>
        </Section>

        <Section title="Badge" hint="Neutral, accent, success, warning, error.">
          <Badge variant="neutral">Neutral</Badge>
          <Badge variant="accent">Accent</Badge>
          <Badge variant="success">Success</Badge>
          <Badge variant="warning">Warning</Badge>
          <Badge variant="error">Error</Badge>
        </Section>

        <Section title="Toast" hint="Status dot + title + optional description. Dismissible.">
          <div className="flex flex-col gap-3">
            <Toast
              variant="neutral"
              title="Workspace indexed"
              description="1,284 files ranked in 1.8s."
            />
            <Toast
              variant="success"
              title="Patch applied"
              description="src/components/ui/Button.tsx · +3 −1"
              onDismiss={() => undefined}
            />
            <Toast
              variant="warning"
              title="Path outside workspace"
              description="The AI returned an absolute path. Reject and re-ask."
            />
            <Toast variant="error" title="Claude request failed" />
            <div className="flex items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<Plus size={14} />}
                onClick={() => setToasts((t) => [...t, t.length])}
              >
                Add toast
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setToasts([])}
              >
                Clear
              </Button>
              <Badge variant="neutral">{toasts.length} live</Badge>
            </div>
            {toasts.length > 0 ? (
              <div className="fixed bottom-4 right-4 z-30 flex flex-col gap-2 items-end">
                {toasts.map((id) => (
                  <Toast
                    key={id}
                    variant="success"
                    title={`Live toast #${id + 1}`}
                    description="Triggered from the gallery."
                    onDismiss={() => setToasts((t) => t.filter((x) => x !== id))}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </Section>

        <Section title="Iconography" hint="Lucide React, 16px default, currentColor stroke.">
          <div className="flex items-center gap-4 text-fg-secondary">
            <Search size={16} />
            <Plus size={16} />
            <ArrowRight size={16} />
          </div>
        </Section>
      </div>

      <Drawer
        open={drawerRight}
        onOpenChange={setDrawerRight}
        anchor="right"
        ariaLabel="Right drawer demo"
      >
        <div className="flex flex-col h-full">
          <header className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-subtle">
            <h2 className="text-body-sm font-medium">Right drawer</h2>
            <button
              type="button"
              onClick={() => setDrawerRight(false)}
              aria-label="Close"
              className="text-fg-tertiary hover:text-fg-primary transition-colors duration-fast text-body leading-none"
            >
              ×
            </button>
          </header>
          <div className="flex-1 min-h-0 overflow-y-auto p-4 text-body-sm text-fg-secondary">
            380px wide. Slides in 200ms with the standard ease-out curve.
          </div>
        </div>
      </Drawer>

      <Drawer
        open={drawerBottom}
        onOpenChange={setDrawerBottom}
        anchor="bottom"
        ariaLabel="Bottom drawer demo"
      >
        <div className="flex flex-col h-full">
          <header className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-subtle">
            <h2 className="text-body-sm font-medium">Bottom drawer</h2>
            <button
              type="button"
              onClick={() => setDrawerBottom(false)}
              aria-label="Close"
              className="text-fg-tertiary hover:text-fg-primary transition-colors duration-fast text-body leading-none"
            >
              ×
            </button>
          </header>
          <div className="flex-1 min-h-0 overflow-y-auto p-4 text-body-sm text-fg-secondary">
            360px tall. Used for terminal/log surfaces in later phases.
          </div>
        </div>
      </Drawer>
    </div>
  );
}
