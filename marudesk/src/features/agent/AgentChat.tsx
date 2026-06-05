import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Send, Square } from 'lucide-react';
import { Button } from '../../components/ui';
import { useElapsedTimer } from '../../hooks';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { toast } from '../../lib/toast';
import { toMessage } from '../../lib/toMessage';
import { findModel } from '../../../shared/providers';
import type { AgentChatState } from '../../../shared/agent';
import {
  filterSlash,
  pluginSlashCommand,
  resolveSlash,
  slashQuery,
  type SlashActionId,
  type SlashCommand,
} from '../../../shared/slash-commands';
import { useProvidersStore } from '../providers/store';
import { useWorkspaceStore } from '../workspace/store';
import { useAgentStore } from './store';
import { ContextPopover } from './ContextPopover';
import { buildReceipt, isBusy, matchFiles, mentionContext, textOf } from './chat/format';
import {
  ContextButton,
  EmptyState,
  ProviderModelBar,
  StatusPill,
  UsageMeter,
} from './chat/Controls';
import { MentionMenu, SlashInfoCard, SlashMenu } from './chat/Menus';
import { AttachmentPreview } from './chat/AttachmentPreview';
import { ComposerToggles } from './chat/ComposerToggles';
import { ComposerBanners } from './chat/ComposerBanners';
import { Transcript } from './chat/Transcript';
import { ApprovalCard, QuestionsCard, ReceiptCard } from './chat/Cards';
import { useStickyTranscriptScroll } from './chat/useStickyTranscriptScroll';
import { fileAttachmentsFromFiles, readImageFiles } from './chat/attachments';


export function AgentChat({ variant = 'drawer' }: { variant?: 'drawer' | 'full' } = {}) {
  const { t } = useI18n();
  const chat = useAgentStore((s) => s.chat);
  const draft = useAgentStore((s) => s.draft);
  const setDraft = useAgentStore((s) => s.setDraft);
  const ingest = useAgentStore((s) => s.ingest);
  const hydrate = useAgentStore((s) => s.hydrate);
  const send = useAgentStore((s) => s.send);
  const abort = useAgentStore((s) => s.abort);
  const resetChat = useAgentStore((s) => s.resetChat);
  const compact = useAgentStore((s) => s.compact);
  const addImages = useAgentStore((s) => s.addImages);
  const addFiles = useAgentStore((s) => s.addFiles);
  const promptHistory = useAgentStore((s) => s.promptHistory);
  const queuedPrompt = useAgentStore((s) => s.queuedPrompt);
  const setQueuedPrompt = useAgentStore((s) => s.setQueuedPrompt);
  const verbosity = useAgentStore((s) => s.verbosity);

  const summary = useWorkspaceStore((s) => s.summary);
  const statusChecked = useProvidersStore((s) => s.statusChecked);
  const refreshStatus = useProvidersStore((s) => s.refreshProviderStatus);
  // Reasoning-effort control is shown only for models the catalog flags `reasoning`.
  const models = useProvidersStore((s) => s.models);
  const selectedModelKey = useProvidersStore((s) => s.selectedModelKey);
  const isReasoningModel = !!findModel(models, selectedModelKey)?.reasoning;

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
  // Slash commands contributed by active plugins, merged into the `/` menu. Pulled
  // once on mount as a transport-safe snapshot, then rebuilt into prompt commands
  // whose `expand` substitutes `$ARGUMENTS` (plugin runtime design §5).
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
  const { scrollRef, atBottom, handleScroll, handleWheel, scrollToBottom, stickToBottom } =
    useStickyTranscriptScroll({
      messages: chat.messages,
      status: chat.status,
      edits: chat.edits,
      pendingApproval: chat.pendingApproval,
      pendingQuestions: chat.pendingQuestions,
      endNote: chat.endNote,
    });

  // Subscribe to the server-owned snapshot stream while mounted; hydrate once so
  // we catch up on whatever happened while the panel was on another tab.
  useEffect(() => {
    void hydrate();
    const off = window.marudesk.on('agent:event', (s: AgentChatState) => ingest(s));
    return off;
  }, [hydrate, ingest]);

  useEffect(() => {
    if (!statusChecked) void refreshStatus();
  }, [statusChecked, refreshStatus]);

  // Auto-grow the composer to fit its content, up to the max height (max-h-40 =
  // 160px); taller drafts then scroll. Resetting to `auto` first re-derives the
  // baseline from the `rows` attribute, so the floor (2 rows drawer / 3 rows
  // full) is preserved and the box shrinks back when text is deleted. Runs on
  // every draft change so a multi-line paste expands instead of overflowing.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const busy = isBusy(chat.status);
  const elapsed = useElapsedTimer(busy);

  // Auto-send a queued prompt once the running turn finishes (busy goes false).
  useEffect(() => {
    if (busy || !queuedPrompt) return;
    const text = queuedPrompt;
    setQueuedPrompt(null);
    submitText(text);
    // submitText closes over stable store actions; rerun only on these two.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queuedPrompt]);

  const empty = chat.messages.length === 0 && chat.edits.length === 0;
  // The full-surface `agent` tab centers the conversation in a readable column
  // (Claude/Codex Desktop parity, v3 §5-B); the drawer companion stays compact.
  // Same single server-owned state projects into both.
  const full = variant === 'full';
  // Completion receipt (Antigravity "Walkthrough" parity): a one-line outcome
  // shown when a finished turn actually probed the live app over CDP or ran a
  // verify pass — surfacing the runtime-evidence wedge + the verify verdict.
  const receipt =
    chat.status === 'completed' ? buildReceipt(chat.messages) : null;

  // Slash menu: visible while the draft is a bare `/token` (no argument yet) and
  // not dismissed. Once the user types a space (an argument), the menu hides and
  // the command runs on Enter via the resolver in handleSend.
  const slashQ = slashQuery(draft);
  const slashItems = useMemo(
    () => (slashQ !== null && !slashDismissed ? filterSlash(slashQ, pluginSlash) : []),
    [slashQ, slashDismissed, pluginSlash],
  );
  const slashOpen = slashItems.length > 0;

  // `@file` mention: active only when the caret sits in an `@token`, a workspace
  // is open, and the slash menu isn't already showing.
  const mention = !slashOpen ? mentionContext(draft, caret) : null;
  // `matchFiles` scores the whole workspace index, so keep it off the hot path
  // of unrelated re-renders (composer focus, streaming ticks) — only the query
  // and the file set move it.
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

  // Recall a previous prompt. `dir` is -1 for older (ArrowUp), +1 for newer
  // (ArrowDown). Stepping past the newest entry clears back to an empty draft.
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

  // Complete a picked menu command into the composer. Action commands run
  // immediately; prompt commands fill the line (`/review `) so the user can add
  // an argument, then Enter sends (handleSend expands it).
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

  // Send a concrete prompt string: resolve slash commands first (action → run
  // locally; prompt → expand into a templated instruction), then dispatch. Used
  // by both the composer Send and the queued-prompt auto-send below.
  function submitText(raw: string) {
    const text = raw.trim();
    if (text.length === 0) return;
    // A fresh prompt should snap back to the bottom even if the user scrolled up.
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
    // A turn is running: queue this prompt instead of dropping it (claude-code
    // parity). It auto-sends when the turn finishes via the effect below.
    if (busy) {
      setQueuedPrompt(queuedPrompt ? `${queuedPrompt}\n${text}` : text);
      setDraft('');
      return;
    }
    submitText(text);
  };

  // Picking an empty-state suggestion drops it into the composer and lands the
  // cursor there, so the user can tweak or just hit Enter without a second click.
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
    // Prompt-history recall (slash menu closed). ArrowUp only triggers from the
    // start of the field so multi-line editing keeps normal caret movement;
    // ArrowDown only while already navigating history.
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
   * back to appending at the end if the element is not focused. After insertion
   * the textarea re-focuses so the user can keep typing.
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
    // Add a leading space if we're not at the beginning and the char before isn't whitespace.
    const spaceBefore = start > 0 && !/\s$/.test(before) ? ' ' : '';
    const newDraft = `${before}${spaceBefore}${mention} ${after}`;
    setDraft(newDraft);
    // Restore focus and position cursor after the mention.
    requestAnimationFrame(() => {
      el.focus();
      const cursor = start + spaceBefore.length + mention.length + 1;
      el.setSelectionRange(cursor, cursor);
      setCaret(cursor);
    });
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <ProviderModelBar full={full} />

      <div className="relative flex-1 min-h-0">
       <div ref={scrollRef} onScroll={handleScroll} onWheel={handleWheel} className="h-full overflow-y-auto">
        <div
          className={cn(
            'flex flex-col gap-4',
            full ? 'mx-auto w-full max-w-3xl px-5 py-6' : 'px-3 py-4',
            empty && 'min-h-full justify-center',
          )}
        >
          {empty ? (
            <EmptyState hasWorkspace={!!summary} onPick={handlePickSuggestion} />
          ) : (
            <Transcript
              messages={chat.messages}
              edits={chat.edits}
              status={chat.status}
              verbosity={verbosity}
              changesRef={changesRef}
            />
          )}

          {receipt ? <ReceiptCard receipt={receipt} /> : null}

          {chat.pendingApproval ? <ApprovalCard approval={chat.pendingApproval} /> : null}
          {chat.pendingQuestions ? <QuestionsCard pending={chat.pendingQuestions} /> : null}

          {chat.endNote ? (
            <div className="flex items-center justify-center gap-1.5 py-1 text-caption text-fg-tertiary">
              <Square size={11} className="shrink-0" />
              <span>{chat.endNote}</span>
            </div>
          ) : null}

          {chat.error ? (
            <div className="rounded border border-subtle bg-error-subtle/40 px-3 py-2 text-body-sm text-fg-secondary break-words">
              {chat.error}
            </div>
          ) : null}
        </div>
       </div>

        {/* Jump to latest — appears only when the user has scrolled up off the
            live edge, so a streaming turn never traps them mid-transcript. */}
        {!empty && !atBottom ? (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label={t('agent.chat.jumpToLatest')}
            title={t('agent.chat.jumpToLatest')}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex size-8 items-center justify-center rounded-pill border border-default bg-surface-2 text-fg-secondary shadow-lifted hover:bg-surface-3 hover:text-fg-primary transition-colors duration-fast"
          >
            <ChevronDown size={16} />
          </button>
        ) : null}
      </div>

      <footer className="chrome-panel shrink-0 border-x-0 border-b-0">
        <div
          className={cn(
            'flex flex-col gap-2',
            full ? 'mx-auto w-full max-w-3xl px-5 py-3' : 'px-3 py-2',
          )}
        >
          {/* Status row: left = pill + usage; right = toggle cluster. Wraps the
              toggle pill to its own line on a narrow drawer instead of overflowing. */}
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 min-w-0">
            {/* Left: status + usage */}
            <div className="flex items-center gap-2.5 min-w-0 shrink-0">
              <StatusPill status={chat.status} elapsed={elapsed} />
              <UsageMeter />
            </div>

            {/* Right: toggles grouped in a single pill-shaped container */}
            <ComposerToggles empty={empty} busy={busy} isReasoningModel={isReasoningModel} />
          </div>

          <ComposerBanners />

          {slashInfo ? (
            <SlashInfoCard kind={slashInfo} onClose={() => setSlashInfo(null)} />
          ) : null}

          {/* Composer well — attachments, prompt, and actions read as one box
              (Claude/Cursor parity): the border lifts to the accent on focus, so
              the whole control reacts as a unit rather than just the textarea. */}
          <div className="relative">
            {slashOpen ? (
              <SlashMenu
                items={slashItems}
                activeIndex={Math.min(slashIndex, slashItems.length - 1)}
                onPick={pickSlash}
                onHover={setSlashIndex}
              />
            ) : null}
            {mentionOpen ? (
              <MentionMenu
                items={mentionItems}
                activeIndex={Math.min(mentionIndex, mentionItems.length - 1)}
                onPick={pickMention}
                onHover={setMentionIndex}
              />
            ) : null}

            <div className="chrome-panel-strong flex flex-col rounded-lg transition-[border-color,box-shadow] duration-fast focus-within:border-accent focus-within:shadow-focus-accent">
              <AttachmentPreview />

              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraftAndTrackSlash(e.target.value, e.target.selectionStart ?? undefined)}
                onKeyDown={onKeyDown}
                onKeyUp={syncCaret}
                onClick={syncCaret}
                onSelect={syncCaret}
                onPaste={handlePaste}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                rows={full ? 3 : 2}
                placeholder={t('agent.chat.promptPlaceholder')}
                spellCheck={false}
                className={cn(
                  'w-full min-h-[40px] max-h-40 resize-none bg-transparent px-3 pt-2.5 pb-1',
                  'text-body-sm text-fg-primary placeholder:text-fg-tertiary leading-relaxed',
                  'focus:outline-none',
                )}
                aria-label={t('agent.chat.promptAria')}
              />

              {/* Action bar: attach on the left, send/stop on the right. */}
              <div className="flex items-center justify-between gap-2 px-1.5 pb-1.5">
                <ContextButton
                  buttonRef={plusButtonRef}
                  open={contextOpen}
                  onToggle={() => setContextOpen((v) => !v)}
                />
                {busy ? (
                  <Button variant="secondary" size="sm" leadingIcon={<Square size={13} />} onClick={() => void abort()}>
                    {t('agent.chat.stop')}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    leadingIcon={<Send size={13} />}
                    onClick={handleSend}
                    disabled={draft.trim().length === 0}
                  >
                    {t('agent.chat.send')}
                  </Button>
                )}
              </div>
            </div>

            {contextOpen ? (
              <ContextPopover
                anchorRef={plusButtonRef}
                onClose={() => setContextOpen(false)}
                onInsertMention={handleInsertMention}
                onAddPhoto={() => {
                  imageInputRef.current?.click();
                  setContextOpen(false);
                }}
                onAddFile={() => {
                  fileInputRef.current?.click();
                  setContextOpen(false);
                }}
              />
            ) : null}
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              multiple
              aria-label={t('agent.chat.attachPhotos')}
              className="hidden"
              onChange={handlePickedFiles}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              aria-label={t('agent.chat.attachFiles')}
              className="hidden"
              onChange={handlePickedFiles}
            />
          </div>
        </div>
      </footer>
    </div>
  );
}

