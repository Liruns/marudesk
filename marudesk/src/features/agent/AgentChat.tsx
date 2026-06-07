import { useEffect } from 'react';
import { ChevronDown, Send, Square } from 'lucide-react';
import { Button } from '../../components/ui';
import { useElapsedTimer } from '../../hooks';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { findModel } from '../../../shared/providers';
import type { AgentChatState } from '../../../shared/agent';
import { useProvidersStore } from '../providers/store';
import { useWorkspaceStore } from '../workspace/store';
import { useAgentStore } from './store';
import { ContextPopover } from './ContextPopover';
import { buildReceipt, isBusy } from './chat/format';
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
import { ApprovalCard, BackgroundTray, QuestionsCard, ReceiptCard, Taskboard } from './chat/Cards';
import { useStickyTranscriptScroll } from './chat/useStickyTranscriptScroll';
import { useComposer } from './useComposer';


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

  const busy = isBusy(chat.status);
  const elapsed = useElapsedTimer(busy);

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

  // All composer-local state, derived menu data, effects, and input handlers.
  const {
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
  } = useComposer({
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
  });

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

          <Taskboard plan={chat.plan} />

          <BackgroundTray tasks={chat.background} />

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

