import { Code2, FolderOpen, Globe, MonitorSmartphone, Sparkles, SquareTerminal, Terminal } from 'lucide-react';
import { useState } from 'react';
import type { TabKind } from '../../../shared/browser';
import logoUrl from '../../assets/logo-mark.png';
import { useI18n } from '../../i18n/useI18n';
import { openCliChatTab } from '../agent/store';
import { useGridStore } from '../tabs/grid';
import { useTabsStore } from '../tabs/store';
import { useWorkspaceDeckStore } from '../workspaces/store';
import { HomeAddressSearch } from './HomeAddressSearch';
import { HomeGuide, type HomeScenario } from './HomeGuide';
import { HomeLauncherCard } from './HomeLauncherCard';
import { HomeRecents } from './HomeRecents';
import { hasSeenGuide, markGuideSeen } from './onboarding';

export function HomeView({ tabId }: { readonly tabId?: string }) {
  const { t } = useI18n();
  const replaceTab = useTabsStore((s) => s.replaceTab);
  const newTab = useTabsStore((s) => s.newTab);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const createWorkspace = useWorkspaceDeckStore((s) => s.createWorkspace);
  const workspaceCount = useWorkspaceDeckStore((s) => s.workspaces.length);
  const [showGuide, setShowGuide] = useState(() => !hasSeenGuide());

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

  const dismissGuide = () => {
    markGuideSeen();
    setShowGuide(false);
  };

  // Representative first-run scenarios; each runs the real action so the guide
  // doubles as a launcher. "Open a workspace" pops the folder picker via the deck.
  const scenarios: readonly HomeScenario[] = [
    { key: 'ask', icon: <Sparkles size={18} />, label: 'home.guide.card.ask.label', desc: 'home.guide.card.ask.desc', onOpen: () => open('agent') },
    { key: 'browse', icon: <Globe size={18} />, label: 'home.guide.card.browse.label', desc: 'home.guide.card.browse.desc', onOpen: () => open('web') },
    { key: 'workspace', icon: <FolderOpen size={18} />, label: 'home.guide.card.workspace.label', desc: 'home.guide.card.workspace.desc', onOpen: () => void createWorkspace('', []) },
    { key: 'terminal', icon: <SquareTerminal size={18} />, label: 'home.guide.card.terminal.label', desc: 'home.guide.card.terminal.desc', onOpen: () => open('terminal') },
    { key: 'edit', icon: <Code2 size={18} />, label: 'home.guide.card.edit.label', desc: 'home.guide.card.edit.desc', onOpen: () => open('editor') },
    { key: 'remote', icon: <MonitorSmartphone size={18} />, label: 'home.guide.card.remote.label', desc: 'home.guide.card.remote.desc', onOpen: () => open('settings') },
  ];

  return (
    <div className="@container flex-1 min-w-0 overflow-y-auto bg-surface-page bg-vignette">
      <div className="min-h-full flex flex-col items-center justify-start px-8 py-12 gap-7">
        <div className="flex flex-col items-center gap-3 animate-fade-rise">
          <div className="relative">
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-6 -z-10 bg-accent-glow"
            />
            <img src={logoUrl} alt="" aria-hidden draggable={false} className="size-12 select-none" />
          </div>
          <div className="flex flex-col items-center gap-1">
            <h1 className="text-title font-display text-fg-primary">Maru</h1>
            <p className="text-body-sm text-fg-tertiary">{t('home.subtitle')}</p>
          </div>
        </div>

        <HomeAddressSearch onOpen={(url) => open('web', url)} />

        {workspaceCount === 0 ? (
          <p className="w-full max-w-2xl text-caption text-fg-tertiary text-center animate-fade-rise">
            {t('home.guide.noWorkspace')}
          </p>
        ) : null}

        {showGuide ? (
          // The guide already surfaces these actions (and more), so hide the
          // compact launcher grid while it's open to avoid duplicate cards.
          <HomeGuide scenarios={scenarios} onDismiss={dismissGuide} />
        ) : (
          <div className="w-full max-w-2xl grid grid-cols-1 @lg:grid-cols-2 gap-2.5 animate-fade-rise [animation-delay:120ms]">
            <HomeLauncherCard
              label={t('home.launcher.agent.label')}
              hint={t('home.launcher.agent.hint')}
              icon={<Sparkles size={18} />}
              onOpen={() => open('agent')}
            />
            <HomeLauncherCard
              label={t('home.launcher.cli.label')}
              hint={t('home.launcher.cli.hint')}
              icon={<Terminal size={18} />}
              onOpen={() => void openCliChatTab()}
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
        )}

        <HomeRecents />

        {!showGuide ? (
          <button
            type="button"
            onClick={() => setShowGuide(true)}
            className="text-caption text-fg-tertiary underline-offset-2 hover:text-fg-secondary hover:underline transition-colors duration-fast"
          >
            {t('home.guide.reopen')}
          </button>
        ) : null}

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
