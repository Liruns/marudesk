import { useMemo, useState } from 'react';
import { FolderTree, Search, Server, X } from 'lucide-react';
import type { WorkspaceRecord } from '../../../shared/workspace';
import { useEditorStore } from '../editor/store';
import { useWorkspaceDeckStore } from './store';

export function PeekExplorer({
  record,
  onClose,
}: {
  record: WorkspaceRecord;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const openFile = useEditorStore((s) => s.openFile);
  const removeRoot = useWorkspaceDeckStore((s) => s.removeRoot);
  const canRemoveRoot = record.roots.length > 1;
  const lower = query.trim().toLowerCase();
  const roots = useMemo(
    () =>
      record.roots.map((root) => ({
        root,
        files: root.files
          .filter((file) => !lower || file.path.toLowerCase().includes(lower))
          .slice(0, 48),
      })),
    [record.roots, lower],
  );

  return (
    <div className="chrome-popover absolute right-3 top-12 z-40 w-[360px] max-h-[70%] flex flex-col rounded-lg overflow-hidden">
      <div className="chrome-header h-10 shrink-0 flex items-center gap-2 px-3">
        <Search size={15} className="text-fg-tertiary" />
        <input
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          autoFocus
          placeholder="Filter files"
          className="min-w-0 flex-1 bg-transparent text-body-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
        />
        <button
          type="button"
          aria-label="Close Peek Explorer"
          onClick={onClose}
          className="chrome-icon-button size-6"
        >
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 overflow-y-auto py-2">
        {roots.map(({ root, files }) => (
          <div key={root.id} className="pb-2">
            <div className="group px-3 h-6 flex items-center gap-2 text-caption font-medium text-fg-tertiary uppercase">
              {root.connection?.kind === 'ssh' ? (
                <Server size={13} className="text-accent" />
              ) : (
                <FolderTree size={13} />
              )}
              <span
                className="truncate"
                title={
                  root.connection?.kind === 'ssh'
                    ? `${root.connection.username}@${root.connection.host}:${root.connection.remotePath}`
                    : undefined
                }
              >
                {root.name}
              </span>
              <span className="ml-auto tabular-nums">{files.length}</span>
              {canRemoveRoot ? (
                <button
                  type="button"
                  aria-label={`Remove root ${root.name}`}
                  title="Remove folder from workspace"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove folder "${root.name}" from "${record.name}"?`,
                      )
                    ) {
                      void removeRoot(record.id, root.id);
                    }
                  }}
                  className="opacity-0 group-hover:opacity-100 size-4 rounded flex items-center justify-center text-fg-tertiary hover:text-error transition-opacity duration-fast"
                >
                  <X size={12} />
                </button>
              ) : null}
            </div>
            {files.map((file) => (
              <button
                key={`${root.id}:${file.path}`}
                type="button"
                onClick={() => {
                  void openFile({
                    workspaceId: record.id,
                    rootId: root.id,
                    path: file.path,
                  });
                  onClose();
                }}
                className="chrome-list-row w-full h-7 gap-2 px-5 text-left text-body-sm"
                title={`${root.name} / ${file.path}`}
              >
                <span className="truncate">{file.path}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
