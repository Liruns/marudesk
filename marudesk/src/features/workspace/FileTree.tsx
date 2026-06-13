import {
  Fragment,
  useEffect,
  useRef,
  type ComponentType,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Image,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
import { FILE_DND_MIME } from './fileDrag';
import type { FlatNode } from './tree';
import type { Clipboard, PendingEdit } from './store';

/** A right-clicked tree target (file/dir), or the empty body (workspace root). */
export type MenuTarget =
  | { kind: 'dir' | 'file'; path: string; name: string }
  | { kind: 'empty' };

type Props = {
  rows: FlatNode[];
  expanded: Set<string>;
  selectedPath: string | null;
  pendingEdit: PendingEdit | null;
  clipboard: Clipboard | null;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onOpenFile: (path: string) => void;
  /** Drag payload for a file row (serialized file ref) — enables drag-to-panel. */
  getDragData?: (path: string) => string;
  onContextMenu: (e: ReactMouseEvent, target: MenuTarget) => void;
  onCommitRename: (path: string, newName: string) => Promise<boolean>;
  onCommitCreate: (
    parentDir: string,
    name: string,
    kind: 'file' | 'dir',
  ) => Promise<boolean>;
  onCancelEdit: () => void;
};

const INDENT = 12;
const BASE_PAD = 8;

/**
 * Presentational file tree over a pre-flattened row list. Handles inline rename
 * and new-file/new-folder inputs (driven by `pendingEdit`), cut dimming, and
 * right-click targeting; all mutations are delegated to the parent.
 */
export function FileTree({
  rows,
  expanded,
  selectedPath,
  pendingEdit,
  clipboard,
  onToggleDir,
  onSelectFile,
  onOpenFile,
  getDragData,
  onContextMenu,
  onCommitRename,
  onCommitCreate,
  onCancelEdit,
}: Props) {
  const { t } = useI18n();
  const newInput =
    pendingEdit && pendingEdit.kind !== 'rename'
      ? {
          parentDir: pendingEdit.path,
          kind: (pendingEdit.kind === 'new-folder' ? 'dir' : 'file') as
            | 'dir'
            | 'file',
        }
      : null;
  const parentDepth =
    newInput && newInput.parentDir
      ? (rows.find((r) => r.path === newInput.parentDir)?.depth ?? -1)
      : -1;
  const newInputDepth = newInput ? (newInput.parentDir ? parentDepth + 1 : 0) : 0;

  return (
    <ul role="tree" aria-label={t('workspace.tree.aria')} className="py-1">
      {newInput && newInput.parentDir === '' ? (
        <li>
          <NameInput
            depth={0}
            initialValue=""
            icon={newInput.kind === 'dir' ? <Folder size={15} /> : <File size={15} />}
            onCommit={(v) => onCommitCreate('', v, newInput.kind)}
            onCancel={onCancelEdit}
          />
        </li>
      ) : null}

      {rows.map((node) => {
        const renaming =
          pendingEdit?.kind === 'rename' && pendingEdit.path === node.path;
        return (
          <Fragment key={node.path}>
            {renaming ? (
              <li role="treeitem" aria-level={node.depth + 1}>
                <NameInput
                  depth={node.depth}
                  initialValue={node.name}
                  selectStem={node.kind === 'file'}
                  icon={glyphFor(node, expanded.has(node.path))}
                  onCommit={(v) => onCommitRename(node.path, v)}
                  onCancel={onCancelEdit}
                />
              </li>
            ) : (
              <TreeRow
                node={node}
                open={node.kind === 'dir' && expanded.has(node.path)}
                selected={node.path === selectedPath}
                cut={clipboard?.mode === 'cut' && clipboard.path === node.path}
                onToggleDir={onToggleDir}
                onSelectFile={onSelectFile}
                onOpenFile={onOpenFile}
                getDragData={getDragData}
                onContextMenu={onContextMenu}
              />
            )}
            {newInput && newInput.parentDir === node.path ? (
              <li>
                <NameInput
                  depth={newInputDepth}
                  initialValue=""
                  icon={
                    newInput.kind === 'dir' ? (
                      <Folder size={15} />
                    ) : (
                      <File size={15} />
                    )
                  }
                  onCommit={(v) =>
                    onCommitCreate(newInput.parentDir, v, newInput.kind)
                  }
                  onCancel={onCancelEdit}
                />
              </li>
            ) : null}
          </Fragment>
        );
      })}
    </ul>
  );
}

function TreeRow({
  node,
  open,
  selected,
  cut,
  onToggleDir,
  onSelectFile,
  onOpenFile,
  getDragData,
  onContextMenu,
}: {
  node: FlatNode;
  open: boolean;
  selected: boolean;
  cut: boolean;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onOpenFile: (path: string) => void;
  getDragData?: (path: string) => string;
  onContextMenu: (e: ReactMouseEvent, target: MenuTarget) => void;
}) {
  const isDir = node.kind === 'dir';
  return (
    <li role="treeitem" aria-level={node.depth + 1} aria-expanded={isDir ? open : undefined} aria-selected={selected}>
      <button
        type="button"
        // Files are draggable onto the canvas / a grid pane to open as an editor.
        draggable={!isDir && !!getDragData}
        onDragStart={
          !isDir && getDragData
            ? (e) => {
                e.dataTransfer.setData(FILE_DND_MIME, getDragData(node.path));
                e.dataTransfer.effectAllowed = 'copy';
              }
            : undefined
        }
        onClick={() => {
          if (isDir) {
            onToggleDir(node.path);
            return;
          }
          onSelectFile(node.path);
          onOpenFile(node.path);
        }}
        onContextMenu={(e) =>
          onContextMenu(e, { kind: node.kind, path: node.path, name: node.name })
        }
        title={node.path}
        style={{ paddingLeft: node.depth * INDENT + BASE_PAD }}
        className={cn(
          'group w-full h-7 flex items-center gap-1.5 pr-2 text-body-sm text-left',
          'transition-colors duration-fast',
          cut ? 'opacity-50' : '',
          selected
            ? 'bg-accent-subtle/40 text-fg-primary'
            : 'text-fg-secondary hover:bg-surface-2',
        )}
      >
        <span className="size-4 shrink-0 flex items-center justify-center text-fg-tertiary">
          {isDir ? (
            open ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )
          ) : null}
        </span>
        <span
          className={cn(
            'shrink-0 flex items-center justify-center',
            selected ? 'text-accent' : 'text-fg-tertiary',
          )}
        >
          {glyphFor(node, open)}
        </span>
        <span className="truncate">{node.name}</span>
      </button>
    </li>
  );
}

function NameInput({
  depth,
  initialValue,
  selectStem = false,
  icon,
  onCommit,
  onCancel,
}: {
  depth: number;
  initialValue: string;
  selectStem?: boolean;
  icon: ReactNode;
  onCommit: (value: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (initialValue) {
      const dot = selectStem ? initialValue.lastIndexOf('.') : -1;
      if (dot > 0) el.setSelectionRange(0, dot);
      else el.select();
    }
  }, [initialValue, selectStem]);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    const value = ref.current?.value.trim() ?? '';
    if (!value) {
      onCancel();
      return;
    }
    void onCommit(value).then((ok) => {
      // On failure the edit stays open so the user can fix the name.
      if (!ok) done.current = false;
    });
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  return (
    <div
      style={{ paddingLeft: depth * INDENT + BASE_PAD }}
      className="h-7 flex items-center gap-1.5 pr-2"
    >
      <span className="size-4 shrink-0" aria-hidden />
      <span className="shrink-0 flex items-center justify-center text-fg-tertiary">
        {icon}
      </span>
      <input
        ref={ref}
        defaultValue={initialValue}
        spellCheck={false}
        autoComplete="off"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={commit}
        className={cn(
          'flex-1 min-w-0 h-5 bg-surface-3 rounded px-1 text-body-sm text-fg-primary',
          'border border-accent focus:outline-none',
        )}
      />
    </div>
  );
}

function glyphFor(node: FlatNode, open: boolean): ReactNode {
  if (node.kind === 'dir') {
    return open ? <FolderOpen size={15} /> : <Folder size={15} />;
  }
  const Glyph = iconForFile(node.name);
  return <Glyph size={15} />;
}

const CODE_EXTS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'vue',
  'svelte',
  'astro',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
]);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'avif']);
const TEXT_EXTS = new Set(['md', 'mdx', 'txt', 'log']);

// Icon depends only on extension, so memoize across rows and renders.
const iconCache = new Map<string, ComponentType<{ size?: number }>>();

function iconForFile(name: string): ComponentType<{ size?: number }> {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  const cached = iconCache.get(ext);
  if (cached) return cached;
  const icon = resolveIcon(ext);
  iconCache.set(ext, icon);
  return icon;
}

function resolveIcon(ext: string): ComponentType<{ size?: number }> {
  if (ext === 'json') return FileJson;
  if (CODE_EXTS.has(ext)) return FileCode;
  if (IMAGE_EXTS.has(ext)) return Image;
  if (TEXT_EXTS.has(ext)) return FileText;
  return File;
}
