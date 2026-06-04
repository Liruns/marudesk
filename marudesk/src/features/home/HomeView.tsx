import { Code2, Globe, Sparkles, SquareTerminal } from 'lucide-react';
import type { TabKind } from '../../../shared/browser';
import logoUrl from '../../assets/logo-mark.png';
import { useI18n } from '../../i18n/useI18n';
import { useGridStore } from '../tabs/grid';
import { useTabsStore } from '../tabs/store';
import { HomeAddressSearch } from './HomeAddressSearch';
import { HomeLauncherCard } from './HomeLauncherCard';
import { HomeRecents } from './HomeRecents';

export function HomeView({ tabId }: { readonly tabId?: string }) {
  const { t } = useI18n();
  const replaceTab = useTabsStore((s) => s.replaceTab);
  const newTab = useTabsStore((s) => s.newTab);
  const activeTabId = useTabsStore((s) => s.activeTabId);

  const open = (kind: TabKind, url?: string) => {
    const target = tabId ?? activeTabId;
    if (!target) {
      void newTab(kind, url);
      return;
    }
    void replaceTab(target, kind, url).then((newId) => {
      if (newId) useGridStore.getState().remap(target, newId);
    });
  };

  return (
    <div className="flex-1 min-w-0 overflow-y-auto bg-surface-page bg-vignette">
      <div className="min-h-full flex flex-col items-center justify-center px-8 py-16 gap-10">
        <div className="flex flex-col items-center gap-4 animate-fade-rise">
          <div className="relative">
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-6 -z-10 bg-accent-glow"
            />
            <img src={logoUrl} alt="" aria-hidden draggable={false} className="size-16 select-none" />
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <h1 className="text-hero font-display text-fg-primary">marudesk</h1>
            <p className="text-body-sm text-fg-tertiary">{t('home.subtitle')}</p>
          </div>
        </div>

        <HomeAddressSearch onOpen={(url) => open('web', url)} />

        <div className="w-full max-w-xl grid grid-cols-1 sm:grid-cols-2 gap-3 animate-fade-rise [animation-delay:120ms]">
          <HomeLauncherCard
            label={t('home.launcher.agent.label')}
            hint={t('home.launcher.agent.hint')}
            icon={<Sparkles size={18} />}
            onOpen={() => open('agent')}
          />
          <HomeLauncherCard
            label={t('home.launcher.browser.label')}
            hint={t('home.launcher.browser.hint')}
            icon={<Globe size={18} />}
            onOpen={() => open('web')}
          />
          <HomeLauncherCard
            label={t('home.launcher.terminal.label')}
            hint={t('home.launcher.terminal.hint')}
            icon={<SquareTerminal size={18} />}
            onOpen={() => open('terminal')}
          />
          <HomeLauncherCard
            label={t('home.launcher.editor.label')}
            hint={t('home.launcher.editor.hint')}
            icon={<Code2 size={18} />}
            onOpen={() => open('editor')}
          />
        </div>

        <HomeRecents />

        <p className="text-caption text-fg-tertiary flex items-center gap-1.5 animate-fade-rise [animation-delay:240ms]">
          <kbd className="px-1.5 py-0.5 rounded bg-surface-2 border border-subtle text-fg-secondary">
            Ctrl
          </kbd>
          <span aria-hidden>+</span>
          <kbd className="px-1.5 py-0.5 rounded bg-surface-2 border border-subtle text-fg-secondary">
            T
          </kbd>
          <span>{t('home.shortcut.newTab')}</span>
        </p>
      </div>
    </div>
  );
}
