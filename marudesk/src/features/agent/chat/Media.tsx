import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Film, Image as ImageIcon, Loader2, X } from 'lucide-react';
import { useI18n } from '../../../i18n/useI18n';
import { toMessage } from '../../../lib/toMessage';
import type { ToolMediaArtifact } from '../../../../shared/agent';

/**
 * Full-window image viewer for chat thumbnails. Click anywhere (or Escape) to
 * close. Mirrors ModelPalette's overlay contract: the embedded web view is a
 * native layer composited OVER the React DOM, so it's hidden while the viewer
 * is open or the overlay would render behind an active browser pane.
 */
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const { t } = useI18n();
  useEffect(() => {
    void window.marudesk.invoke('browser:set-visible', false);
    return () => {
      void window.marudesk.invoke('browser:set-visible', true);
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
      className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70 p-6"
    >
      <img
        src={src}
        alt={alt}
        className="max-h-full max-w-full rounded-lg object-contain shadow-lifted animate-scale-in"
      />
      <button
        type="button"
        onClick={onClose}
        aria-label={t('agent.chat.media.close')}
        title={t('agent.chat.media.close')}
        className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-pill border border-default bg-surface-2 text-fg-secondary shadow-lifted transition-colors duration-fast hover:bg-surface-3 hover:text-fg-primary"
      >
        <X size={15} />
      </button>
    </div>,
    document.body,
  );
}

/** A bounded image thumbnail (composer attachment strip + transcript); click to enlarge. */
export function ChatImage({ mediaType, data }: { mediaType: string; data: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const src = `data:${mediaType};base64,${data}`;
  const alt = t('agent.chat.attachedAlt');
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t('agent.chat.media.zoom')}
        className="block cursor-zoom-in"
      >
        <img
          src={src}
          alt={alt}
          className="block max-h-40 max-w-full rounded border border-subtle object-contain"
        />
      </button>
      {open ? <Lightbox src={src} alt={alt} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * Inline gallery for media a tool produced (generate_image / generate_video).
 * The chat state carries only workspace-relative paths (see ToolMediaArtifact);
 * each tile lazily loads the bytes via the `workspace:read-media` channel so
 * large videos never bloat the persisted transcript.
 */
export function MediaGallery({ media }: { media: ToolMediaArtifact[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {media.map((m, i) => (
        <GeneratedMedia key={`${m.path}-${i}`} artifact={m} />
      ))}
    </div>
  );
}

type MediaLoad =
  | { status: 'loading' }
  | { status: 'ready'; dataUrl: string }
  | { status: 'error'; reason: string };

function GeneratedMedia({ artifact }: { artifact: ToolMediaArtifact }) {
  const { t } = useI18n();
  const [load, setLoad] = useState<MediaLoad>({ status: 'loading' });
  const [zoomed, setZoomed] = useState(false);
  // Reset to loading when the artifact changes WITHOUT a remount. Done during
  // render (React's "adjust state on prop change" pattern) rather than in the
  // effect below — a synchronous setState in an effect body triggers a wasted
  // cascading render. The effect owns only the async fetch.
  const [loadedPath, setLoadedPath] = useState(artifact.path);
  if (loadedPath !== artifact.path) {
    setLoadedPath(artifact.path);
    setLoad({ status: 'loading' });
  }
  useEffect(() => {
    let alive = true;
    void window.marudesk
      .invoke('workspace:read-media', artifact.path)
      .then((res) => {
        if (!alive) return;
        setLoad(
          res.ok
            ? { status: 'ready', dataUrl: res.dataUrl }
            : { status: 'error', reason: res.reason },
        );
      })
      .catch((err: unknown) => {
        if (alive) setLoad({ status: 'error', reason: toMessage(err) });
      });
    return () => {
      alive = false;
    };
  }, [artifact.path]);

  const Icon = artifact.kind === 'video' ? Film : ImageIcon;
  const name = artifact.path.split('/').pop() ?? artifact.path;

  return (
    <figure className="flex flex-col gap-1">
      <div className="rounded-lg border border-subtle bg-surface-1 overflow-hidden">
        {load.status === 'ready' ? (
          artifact.kind === 'video' ? (
            <video
              src={load.dataUrl}
              controls
              className="max-h-72 max-w-full block"
            />
          ) : (
            <button
              type="button"
              onClick={() => setZoomed(true)}
              title={t('agent.chat.media.zoom')}
              className="block cursor-zoom-in"
            >
              <img
                src={load.dataUrl}
                alt={name}
                className="max-h-72 max-w-full object-contain block"
              />
            </button>
          )
        ) : (
          <div className="flex items-center gap-2 px-3 py-6 text-caption text-fg-tertiary">
            {load.status === 'loading' ? (
              <Loader2 size={14} className="animate-spin shrink-0" />
            ) : (
              <AlertCircle size={14} className="text-danger shrink-0" />
            )}
            <span className="truncate">
              {load.status === 'loading'
                ? t('agent.chat.media.loading')
                : t('agent.chat.media.error')}
            </span>
          </div>
        )}
      </div>
      {zoomed && load.status === 'ready' ? (
        <Lightbox src={load.dataUrl} alt={name} onClose={() => setZoomed(false)} />
      ) : null}
      <figcaption className="flex items-center gap-1 text-micro text-fg-quaternary">
        <Icon size={10} className="shrink-0" />
        <span className="truncate" title={artifact.path}>
          {name}
        </span>
      </figcaption>
    </figure>
  );
}
