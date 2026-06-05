import { FileText, X } from 'lucide-react';
import { useI18n } from '../../../i18n/useI18n';
import { useAgentStore } from '../store';

/**
 * The composer's pending-attachment preview: image thumbnails + dropped/added
 * file chips, each with a hover-revealed remove button. Reads the pending lists
 * straight from the agent store (same store-connected pattern as the menus), so
 * the parent just renders it. Returns null when nothing is attached.
 */
export function AttachmentPreview() {
  const { t } = useI18n();
  const pendingImages = useAgentStore((s) => s.pendingImages);
  const pendingFiles = useAgentStore((s) => s.pendingFiles);
  const removeImage = useAgentStore((s) => s.removeImage);
  const removeFile = useAgentStore((s) => s.removeFile);

  if (pendingImages.length === 0 && pendingFiles.length === 0) return null;

  return (
    <>
      {pendingImages.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-2.5 pt-2.5">
          {pendingImages.map((img, i) => (
            <div key={i} className="relative group/img">
              <img
                src={`data:${img.mediaType};base64,${img.data}`}
                alt={t('agent.chat.attachmentAlt')}
                className="h-14 w-14 rounded border border-default object-cover"
              />
              <button
                type="button"
                onClick={() => removeImage(i)}
                aria-label={t('agent.chat.removeImage')}
                className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-pill bg-surface-3 border border-default text-fg-secondary hover:text-fg-primary opacity-0 group-hover/img:opacity-100 transition-opacity duration-fast"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {pendingFiles.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
          {pendingFiles.map((file, i) => (
            <span
              key={`${file.name}:${file.size}:${file.text.length}`}
              title={file.name}
              className="group/file flex min-w-0 max-w-full items-center gap-1.5 rounded border border-default bg-surface-2 px-2 py-1 text-caption text-fg-secondary"
            >
              <FileText size={12} className="shrink-0 text-fg-tertiary" />
              <span className="truncate">{file.name}</span>
              <button
                type="button"
                onClick={() => removeFile(i)}
                aria-label={`${t('agent.chat.removeFile')} ${file.name}`}
                className="shrink-0 text-fg-tertiary hover:text-fg-secondary transition-colors duration-fast"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}
