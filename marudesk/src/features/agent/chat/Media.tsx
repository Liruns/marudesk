import { useEffect, useState } from 'react';
import { AlertCircle, Film, Image as ImageIcon, Loader2 } from 'lucide-react';
import { useI18n } from '../../../i18n/useI18n';
import { toMessage } from '../../../lib/toMessage';
import type { ToolMediaArtifact } from '../../../../shared/agent';

/** A bounded image thumbnail (composer attachment strip + transcript). */
export function ChatImage({ mediaType, data }: { mediaType: string; data: string }) {
  const { t } = useI18n();
  return (
    <img
      src={`data:${mediaType};base64,${data}`}
      alt={t('agent.chat.attachedAlt')}
      className="max-h-40 max-w-full rounded border border-subtle object-contain"
    />
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
            <img
              src={load.dataUrl}
              alt={name}
              className="max-h-72 max-w-full object-contain block"
            />
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
      <figcaption className="flex items-center gap-1 text-[10px] text-fg-tertiary/80">
        <Icon size={10} className="shrink-0" />
        <span className="truncate" title={artifact.path}>
          {name}
        </span>
      </figcaption>
    </figure>
  );
}
