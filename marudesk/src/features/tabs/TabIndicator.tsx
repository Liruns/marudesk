import { useState } from 'react';
import { Globe, Lock } from 'lucide-react';
import type { TabState } from '../../../shared/browser';
import { isInternalUrl } from '../../../shared/internal-pages';
import { tabKinds } from './registry';

export function TabIndicator({ tab }: { readonly tab: TabState }) {
  if (tab.kind !== 'web') {
    const Icon = tabKinds[tab.kind].icon;
    return (
      <span className="text-accent shrink-0" aria-hidden>
        <Icon size={14} />
      </span>
    );
  }

  if (tab.isLoading) {
    return (
      <span
        aria-hidden
        className="size-4 shrink-0 rounded-full border-2 border-accent/25 border-t-accent animate-spin motion-reduce:animate-none"
      />
    );
  }

  if (tab.favicon) {
    return <FaviconImg key={tab.favicon} src={tab.favicon} />;
  }

  if (!tab.url || tab.url === 'about:blank' || isInternalUrl(tab.url)) {
    return (
      <span className="text-fg-tertiary shrink-0" aria-hidden>
        <Globe size={14} />
      </span>
    );
  }

  if (tab.isSecure) {
    return (
      <span className="text-fg-secondary shrink-0" aria-hidden>
        <Lock size={14} />
      </span>
    );
  }

  return (
    <span className="text-warning shrink-0" aria-hidden>
      <Globe size={14} />
    </span>
  );
}

function FaviconImg({ src }: { readonly src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="text-fg-tertiary shrink-0" aria-hidden>
        <Globe size={14} />
      </span>
    );
  }

  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      className="size-4 shrink-0 rounded-[3px] object-contain"
      onError={() => setFailed(true)}
    />
  );
}
