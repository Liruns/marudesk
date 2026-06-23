import { useEffect, useState } from 'react';
import { useDevtoolsStore } from '../store';
import { cdpTry } from '../cdp';
import type { PlatformFontUsage } from '../types';
import { useI18n } from '../../../i18n/useI18n';

/**
 * The Fonts pane for the selected node: `CSS.getPlatformFontsForNode` lists the
 * platform fonts that actually rendered the node's text — family, how many
 * glyphs each drew, and whether it came from a web font (`isCustomFont`) or the
 * system. Re-fetched on every selection change.
 */
export function FontsPane() {
  const { t } = useI18n();
  const tabId = useDevtoolsStore((s) => s.tabId);
  const selectedId = useDevtoolsStore((s) => s.selectedId);
  // null = loading (the fetch always lands an array). Reset on selection change
  // via the store-previous-prop pattern (render-time, no effect cascade) —
  // matches NetworkPanel's Detail.
  const [fonts, setFonts] = useState<PlatformFontUsage[] | null>(null);
  const key = `${tabId ?? ''}:${selectedId ?? 'none'}`;
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    setFonts(null);
  }

  useEffect(() => {
    let cancelled = false;
    if (!tabId || selectedId === null) return;
    void cdpTry<{ fonts: PlatformFontUsage[] }>(tabId, 'CSS.getPlatformFontsForNode', {
      nodeId: selectedId,
    }).then((res) => {
      if (!cancelled) setFonts(res?.fonts ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [tabId, selectedId]);

  if (selectedId === null) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        {t('devtools.fonts.selectPrompt')}
      </div>
    );
  }
  if (fonts === null) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        {t('devtools.fonts.loading')}
      </div>
    );
  }
  if (fonts.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        {t('devtools.fonts.noText')}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto py-1">
      {fonts.map((f) => (
        <div
          key={`${f.familyName}/${f.postScriptName ?? ''}`}
          className="flex items-center gap-2 px-2 py-1 border-b border-subtle/60"
        >
          <div className="flex-1 min-w-0">
            <div className="font-mono text-caption text-fg-primary truncate">
              {f.familyName}
            </div>
            {f.postScriptName && f.postScriptName !== f.familyName ? (
              <div className="font-mono text-caption text-fg-tertiary truncate">
                {f.postScriptName}
              </div>
            ) : null}
          </div>
          <span className="text-caption text-fg-secondary tabular-nums shrink-0">
            {t('devtools.fonts.glyphCount').replace('{count}', String(f.glyphCount))}
          </span>
          <span
            className={
              f.isCustomFont
                ? 'px-1 rounded-sm bg-accent-subtle/60 text-accent text-caption shrink-0'
                : 'px-1 rounded-sm bg-surface-3 text-fg-tertiary text-caption shrink-0'
            }
          >
            {f.isCustomFont ? t('devtools.fonts.webFont') : t('devtools.fonts.system')}
          </span>
        </div>
      ))}
    </div>
  );
}
