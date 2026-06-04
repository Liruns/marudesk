import { RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { useBrowserStrings } from './browserStrings';

type Props = {
  readonly hasUrl: boolean;
  readonly inspectMode: boolean;
  readonly crashed: boolean;
  readonly onReload: () => void;
};

export function BrowserStageOverlays({
  hasUrl,
  inspectMode,
  crashed,
  onReload,
}: Props) {
  const { t, formatInspectHint } = useBrowserStrings();

  return (
    <>
      {!hasUrl ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-8 pointer-events-none">
          <span className="text-caption uppercase tracking-wider text-fg-tertiary">
            {t('browser.stage.kicker')}
          </span>
          <h2 className="text-title text-fg-secondary">{t('browser.stage.emptyTitle')}</h2>
          <p className="text-body-sm text-fg-tertiary max-w-md">
            {t('browser.stage.emptyBody')}
          </p>
        </div>
      ) : null}
      {inspectMode ? (
        <div className="absolute top-2 left-2 z-10 pointer-events-none">
          <span className="inline-flex items-center gap-1.5 rounded-pill bg-accent-subtle text-accent text-caption font-medium px-2 py-0.5">
            <span className="size-1.5 rounded-pill bg-accent" />
            {formatInspectHint()}
          </span>
        </div>
      ) : null}
      {crashed ? (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 text-center px-8 bg-surface-page">
          <span className="size-12 rounded-full bg-surface-2 text-warning flex items-center justify-center">
            <TriangleAlert size={24} />
          </span>
          <div className="flex flex-col gap-1.5">
            <h2 className="text-title text-fg-primary">{t('browser.crash.title')}</h2>
            <p className="text-body-sm text-fg-tertiary max-w-md">
              {t('browser.crash.body')}
            </p>
          </div>
          <Button
            variant="secondary"
            leadingIcon={<RotateCw size={15} />}
            onClick={onReload}
          >
            {t('browser.crash.reload')}
          </Button>
        </div>
      ) : null}
    </>
  );
}
