import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { AgentChatState } from '../../../shared/agent';
import type { WorkspaceSummary } from '../../../shared/workspace';
import {
  filterSlash,
  pluginSlashCommand,
  resolveSlash,
  slashQuery,
  type SlashActionId,
  type SlashCommand,
} from '../../../shared/slash-commands';
import { toast } from '../../lib/toast';
import { toMessage } from '../../lib/toMessage';
import { useI18n } from '../../i18n/useI18n';
import { matchFiles, mentionContext, textOf } from './chat/format';
import { fileAttachmentsFromFiles, readImageFiles } from './chat/attachments';

/**
 * All composer-local state, derived menu data, side effects (plugin-command
 * load, textarea auto-grow, queued-prompt auto-send), and the input handlers for
 * AgentChat — extracted from the component so AgentChat keeps the store wiring +
 * render only. The store/scroll values the handlers need are passed in; the hook
 * reads i18n itself. Behavior is identical to the inline version (verified by
 * AgentChat.test.tsx).
 */
export type ComposerDeps = {
  draft: string;
  chat: AgentChatState;
  busy: boolean;
  summary: WorkspaceSummary | null;
  promptHistory: string[];
  queuedPrompt: string | null;
  setDraft: (v: string) => void;
  setQueuedPrompt: (v: string | null) => void;
  send: () => Promise<void>;
  resetChat: () => Promise<void>;
  compact: (focus?: string) => Promise<{ ok: boolean; reason?: string }>;
  addImages: (images: Awaited<ReturnType<typeof readImageFiles>>) => void;
  addFiles: (files: Awaited<ReturnType<typeof fileAttachmentsFromFiles>>) => void;
  stickToBottom: () => void;
};

export function useComposer({
  draft,
  chat,
  busy,
  summary,
  promptHistory,
  queuedPrompt,
  setDraft,
  setQueuedPrompt,
  send,
  resetChat,
  compact,
  addImages,
  addFiles,
  stickToBottom,
}: ComposerDeps) {
  const { t } = useI18n();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const plusButtonRef = useRef<HTMLButtonElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const changesRef = useRef<HTMLDivElement>(null);
  const [contextOpen, setContextOpen] = useState(false);
  // Slash-command menu (`/` in the composer). `slashIndex` is the highlighted
  // row; `slashDismissed` lets Escape hide the menu without clearing the draft;
  // `slashInfo` shows the local `/help` or `/context` readout above the composer.
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashInfo, setSlashInfo] = useState<'help' | 'context' | null>(null);
  // Slash commands contributed by active plugins, merged into the `/` menu.
  const [pluginSlash, setPluginSlash] = useState<SlashCommand[]>([]);
  useEffect(() => {
    let alive = true;
    void window.marudesk
      .invoke('plugins:commands')
      .then((cmds) => {
        if (alive) setPluginSlash(cmds.map((c) => pluginSlashCommand(c.pluginId, c)));
      })
      .catch(() => {
        // No plugins / handler unavailable — the built-in commands still work.
      });
    return () => {
      alive = false;
    };
  }, []);
  // Prompt-history recall: -1 means "not navigating"; otherwise the index into
  // promptHistory currently shown in the composer (ArrowUp/ArrowDown step it).
  const [histIndex, setHistIndex] = useState(-1);
  // `@file` mention picker: the caret position drives which `@token` (if any) is
  // active; `mentionIndex` is the highlighted file row.
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);

  // Auto-grow the composer to fit its content, up to the max height (max-h-40 =
  // 160px); taller drafts then scroll.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  // Slash menu: visible while the draft is a bare `/token` (no argument yet) and
  // not dismissed.
  const slashQ = slashQuery(draft);
  const slashItems = useMemo(
    () => (slashQ !== null && !slashDismissed ? filterSlash(slashQ, pluginSlash) : []),
    [slashQ, slashDismissed, pluginSlash],
  );
  const slashOpen = slashItems.length > 0;

  // `@file` mention: active only when the caret sits in an `@token`, a workspace
  // is open, and the slash menu isn't already showing.
  const mention = !slashOpen ? mentionContext(draft, caret) : null;
  const mentionQuery = mention?.query ?? null;
  const mentionItems = useMemo(
    () => (mentionQuery !== null && summary ? matchFiles(summary.files, mentionQuery) : []),
    [mentionQuery, summary],
  );
  const mentionOpen = mentionItems.length > 0;

  // Replace the active `@token` with the picked file path + a trailing space.
  const pickMention = (path: string) => {
    const ctx = mentionContext(draft, caret);
    if (!ctx) return;
    const before = draft.slice(0, ctx.start);
    const after = draft.slice(caret);
    const inserted = `@${path} `;
    const next = `${before}${inserted}${after}`;
    setDraft(next);
    const pos = before.length + inserted.length;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const syncCaret = () => {
    const el = textareaRef.current;
    if (el) setCaret(el.selectionStart ?? 0);
  };

  const setDraftAndTrackSlash = (v: string, nextCaret?: number) => {
    setDraft(v);
    setSlashDismissed(false);
    setSlashIndex(0);
    setMentionIndex(0);
    setHistIndex(-1);
    if (typeof nextCaret === 'number') setCaret(nextCaret);
    if (slashInfo) setSlashInfo(null);
  };

  // Recall a previous prompt. `dir` is -1 for older (ArrowUp), +1 for newer.
  const recallHistory = (dir: -1 | 1) => {
    if (promptHistory.length === 0) return;
    const from = histIndex === -1 ? promptHistory.length : histIndex;
    const next = from + dir;
    if (next >= promptHistory.length) {
      setHistIndex(-1);
      setDraft('');
      return;
    }
    const idx = Math.max(0, next);
    const value = promptHistory[idx];
    setHistIndex(idx);
    setDraft(value);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(value.length, value.length);
    });
  };

  const runSlashAction = (action: SlashActionId, arg?: string) => {
    switch (action) {
      case 'new':
        void resetChat();
        break;
      case 'diff':
        if (chat.edits.length > 0) {
          changesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
          toast({
            title: t('agent.chat.toast.noChanges.title'),
            description: t('agent.chat.toast.noChanges.description'),
          });
        }
        break;
      case 'context':
        setSlashInfo('context');
        break;
      case 'compact':
        if (busy) {
          toast({
            title: t('agent.chat.toast.busy.title'),
            description: t('agent.chat.toast.busy.description'),
          });
          break;
        }
        toast({
          title: t('agent.chat.toast.compacting.title'),
          description: t('agent.chat.toast.compacting.description'),
        });
        void compact(arg).then((res) => {
          if (res.ok) {
            toast({
              title: t('agent.chat.toast.compacted.title'),
              description: t('agent.chat.toast.compacted.description'),
            });
          } else {
            toast({
              title: t('agent.chat.toast.compactFailed.title'),
              description: res.reason ?? t('agent.chat.toast.unknownError'),
              variant: 'error',
            });
          }
        });
        break;
      case 'help':
        setSlashInfo('help');
        break;
      case 'copy': {
        if (chat.messages.length === 0) {
          toast({
            title: t('agent.chat.toast.nothingToCopy.title'),
            description: t('agent.chat.toast.nothingToCopy.description'),
          });
          break;
        }
        const md = chat.messages
          .map((m) => `**${m.role === 'user' ? t('agent.chat.role.user') : t('agent.chat.role.assistant')}:**\n\n${textOf(m)}`)
          .join('\n\n---\n\n');
        void navigator.clipboard
          .writeText(md)
          .then(() =>
            toast({
              title: t('agent.chat.toast.copied.title'),
              description: t('agent.chat.toast.copied.description'),
            }),
          )
          .catch((err) => toast({ title: t('common.copyFailed'), description: toMessage(err), variant: 'error' }));
        break;
      }
      case 'model':
        window.dispatchEvent(new CustomEvent('marudesk:open-model-palette'));
        break;
    }
  };

  // Complete a picked menu command into the composer.
  const pickSlash = (cmd: SlashCommand) => {
    if (cmd.kind === 'action') {
      runSlashAction(cmd.action);
      setDraft('');
      setSlashDismissed(true);
      return;
    }
    const filled = `/${cmd.name} `;
    setDraft(filled);
    setSlashDismissed(true);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(filled.length, filled.length);
    });
  };

  // Send a concrete prompt string: resolve slash commands first, then dispatch.
  function submitText(raw: string) {
    const text = raw.trim();
    if (text.length === 0) return;
    stickToBottom();
    const resolved = resolveSlash(text, pluginSlash);
    if (resolved) {
      if (resolved.command.kind === 'action') {
        runSlashAction(resolved.command.action, resolved.arg);
        setDraft('');
        return;
      }
      setDraft(resolved.command.expand(resolved.arg));
      void send();
      return;
    }
    setDraft(text);
    void send();
  }

  const handleSend = () => {
    const text = draft.trim();
    if (text.length === 0) return;
    if (busy) {
      setQueuedPrompt(queuedPrompt ? `${queuedPrompt}\n${text}` : text);
      setDraft('');
      return;
    }
    submitText(text);
  };

  // Auto-send a queued prompt once the running turn finishes (busy goes false).
  // The dispatch is deferred to a microtask so it runs after this effect commits
  // rather than cascading another synchronous render inside the effect body.
  useEffect(() => {
    if (busy || !queuedPrompt) return;
    const text = queuedPrompt;
    setQueuedPrompt(null);
    queueMicrotask(() => submitText(text));
    // submitText closes over stable store actions; rerun only on these two.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queuedPrompt]);

  const handlePickSuggestion = (text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  };

  const ingestAttachmentFiles = async (files: readonly File[]) => {
    const images = await readImageFiles(files);
    if (images.length > 0) addImages(images);
    const attachedFiles = await fileAttachmentsFromFiles(files);
    if (attachedFiles.length > 0) addFiles(attachedFiles);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      void ingestAttachmentFiles(files);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      e.preventDefault();
      void ingestAttachmentFiles(files);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLTextAreaElement>) => {
    if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
  };

  const handlePickedFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.currentTarget.files ?? []);
    e.currentTarget.value = '';
    if (files.length > 0) void ingestAttachmentFiles(files);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // While the slash menu is open it owns the arrow/Tab/Enter keys.
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashItems.length) % slashItems.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const cmd = slashItems[Math.min(slashIndex, slashItems.length - 1)];
        if (cmd) pickSlash(cmd);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }
    // While the `@file` menu is open it owns the arrow/Tab/Enter/Escape keys.
    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const path = mentionItems[Math.min(mentionIndex, mentionItems.length - 1)];
        if (path) pickMention(path);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // Collapse the menu by nudging the caret past the token's end.
        setCaret(-1);
        return;
      }
    }
    // Prompt-history recall (slash menu closed).
    const el = textareaRef.current;
    const atStart = el ? el.selectionStart === 0 && el.selectionEnd === 0 : true;
    if (e.key === 'ArrowUp' && (histIndex !== -1 || atStart) && promptHistory.length > 0) {
      e.preventDefault();
      recallHistory(-1);
      return;
    }
    if (e.key === 'ArrowDown' && histIndex !== -1) {
      e.preventDefault();
      recallHistory(1);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  /**
   * Insert an @-mention at the current cursor position in the textarea. Falls
   * back to appending at the end if the element is not focused.
   */
  const handleInsertMention = (mention: string) => {
    const el = textareaRef.current;
    if (!el) {
      setDraft(draft ? `${draft} ${mention} ` : `${mention} `);
      return;
    }
    const start = el.selectionStart ?? draft.length;
    const end = el.selectionEnd ?? draft.length;
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    const spaceBefore = start > 0 && !/\s$/.test(before) ? ' ' : '';
    const newDraft = `${before}${spaceBefore}${mention} ${after}`;
    setDraft(newDraft);
    requestAnimationFrame(() => {
      el.focus();
      const cursor = start + spaceBefore.length + mention.length + 1;
      el.setSelectionRange(cursor, cursor);
      setCaret(cursor);
    });
  };

  return {
    textareaRef,
    plusButtonRef,
    imageInputRef,
    fileInputRef,
    changesRef,
    contextOpen,
    setContextOpen,
    slashInfo,
    setSlashInfo,
    slashItems,
    slashIndex,
    setSlashIndex,
    slashOpen,
    mentionItems,
    mentionIndex,
    setMentionIndex,
    mentionOpen,
    pickMention,
    pickSlash,
    syncCaret,
    setDraftAndTrackSlash,
    handleSend,
    handlePickSuggestion,
    handlePaste,
    handleDrop,
    handleDragOver,
    handlePickedFiles,
    onKeyDown,
    handleInsertMention,
  };
}
