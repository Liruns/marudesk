import { useEffect, useState } from 'react';
import {
  ChevronDown,
  PanelRightClose,
  PanelRightOpen,
  Send,
  Square,
} from 'lucide-react';
import { Button } from '../../components/ui';
import { useElapsedTimer } from '../../hooks';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { findModel } from '../../../shared/providers';
import type { AgentChatState, AgentThreadEvent, AgentWorkspaceEvent } from '../../../shared/agent';
import { useProvidersStore } from '../providers/store';
import { useSettingsStore } from '../settings/store';
import { useWorkspaceStore } from '../workspace/store';
import { useAgentStore, useAgentThreadId, useAgentWorkspaceId, useThreadModelKey } from './store';
import { ContextPopover } from './ContextPopover';
import { buildReceipt, hasOrchestrationContent, isBusy } from './chat/format';
import {
  ComposerModelButton,
  ContextButton,
  EmptyState,
  ProviderKeyNudge,
  StatusPill,
  UsageMeter,
} from './chat/Controls';
import { MentionMenu, SlashInfoCard, SlashMenu } from './chat/Menus';
import { AttachmentPreview } from './chat/AttachmentPreview';
import { ComposerToggles } from './chat/ComposerToggles';
import { ComposerBanners } from './chat/ComposerBanners';
import { Transcript } from './chat/Transcript';
import { TranscriptSearch } from './chat/TranscriptSearch';
import {
  ApprovalCard,
  BackgroundTray,
  ErrorRecoveryCard,
  QuestionsCard,
  ReceiptCard,
  Taskboard,
} from './chat/Cards';
import { ApprovalQueueCard } from './chat/ApprovalQueueCard';
import { OrchestrationTree } from './chat/OrchestrationTree';
import { useStickyTranscriptScroll } from './chat/useStickyTranscriptScroll';
import { useComposer } from './useComposer';


/** Persisted open/closed state of the full surface's Mission Control panel. */
const MISSION_KEY = 'marudesk.agent.missionControl';

function loadMissionOpen(): boolean {
  try {
    return localStorage.getItem(MISSION_KEY) !== '0';
  } catch {
    return true;
  }
}

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
  const queuedPrompts = useAgentStore((s) => s.queuedPrompts);
  const enqueuePrompt = useAgentStore((s) => s.enqueuePrompt);
  const dequeuePrompt = useAgentStore((s) => s.dequeuePrompt);
  const verbosity = useAgentStore((s) => s.verbosity);
  const workspaceId = useAgentWorkspaceId();
  const boundThreadId = useAgentThreadId();

  const summary = useWorkspaceStore((s) => s.summary);
  // Reading-comfort scale for the transcript only (settings → Appearance). CSS
  // `zoom` so the rem-based type scale inside still renders proportionally.
  const chatZoom = useSettingsStore((s) => s.settings.appearance.chatZoom);
  const statusChecked = useProvidersStore((s) => s.statusChecked);
  const refreshStatus = useProvidersStore((s) => s.refreshProviderStatus);
  // Reasoning-effort control is shown only for models the catalog flags
  // `reasoning` — resolved against the ACTIVE THREAD's model, not the global pick.
  const models = useProvidersStore((s) => s.models);
  const threadModelKey = useThreadModelKey();
  const isReasoningModel = !!findModel(models, threadModelKey)?.reasoning;

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
    // Canvas card: bound to one thread → ingest only THAT thread's live stream,
    // so many chats run independently at once. Classic/drawer: no bound thread →
    // follow the workspace's active thread (or the global one with no workspace).
    if (boundThreadId) {
      return window.marudesk.on('agent:thread-event', (event: AgentThreadEvent) => {
        if (event.threadId === boundThreadId) ingest(event.state);
      });
    }
    if (workspaceId) {
      return window.marudesk.on('agent:workspace-event', (event: AgentWorkspaceEvent) => {
        if (event.workspaceId === workspaceId) ingest(event.state);
      });
    }
    const off = window.marudesk.on('agent:event', (s: AgentChatState) => ingest(s));
    return off;
  }, [hydrate, ingest, workspaceId, boundThreadId]);

  useEffect(() => {
    if (!statusChecked) void refreshStatus();
  }, [statusChecked, refreshStatus]);

  const busy = isBusy(chat.status);
  const elapsed = useElapsedTimer(busy);

  const empty = chat.messages.length === 0 && chat.edits.length === 0;
  // The full-surface `agent` tab centers the conversation in a readable column
  // (Claude/Codex Desktop parity, v3 §5-B); the drawer companion stays compact.
  // The same workspace-scoped state projects into both.
  const full = variant === 'full';
  // Transcript navigator (Ctrl/Cmd+F or the composer's search toggle).
  const [searchOpen, setSearchOpen] = useState(false);
  // Mission Control (the right-side plan/agents panel) can be collapsed to give
  // the transcript the full width; persisted so the choice survives restarts.
  const [missionOpen, setMissionOpen] = useState(loadMissionOpen);
  const toggleMission = (open: boolean) => {
    setMissionOpen(open);
    try {
      localStorage.setItem(MISSION_KEY, open ? '1' : '0');
    } catch {
      // ignore — the in-memory state still applies
    }
  };
  const hasMissionContent = !!(
    chat.plan?.steps.length || hasOrchestrationContent(chat.orchestration)
  );
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
    queuedPrompts,
    setDraft,
    enqueuePrompt,
    dequeuePrompt,
    send,
    resetChat,
    compact,
    addImages,
    addFiles,
    stickToBottom,
  });

  return (
    <div
      className="flex flex-col h-full min-h-0"
      onKeyDown={(e) => {
        // Find-in-transcript, scoped to focus within the chat surface so it
        // doesn't shadow a find on other panes.
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !empty) {
          e.preventDefault();
          e.stopPropagation();
          setSearchOpen(true);
        }
      }}
    >
      <div className="relative flex-1 min-h-0 flex">
       {/* min-w-0: this column flexes beside the Mission Control aside — without
           it a wide code block / table in the transcript would set the row's
           min-content width and push the pane wider than its container. */}
       <div className="relative flex-1 min-w-0 min-h-0">
       <div ref={scrollRef} onScroll={handleScroll} onWheel={handleWheel} className="h-full overflow-y-auto overflow-x-hidden">
        <div
          className={cn(
            'flex flex-col gap-5',
            full ? 'mx-auto w-full max-w-3xl px-2 @[25rem]:px-5 py-6' : 'px-3 py-4',
            empty && 'min-h-full justify-center',
          )}
          style={chatZoom !== 100 ? { zoom: chatZoom / 100 } : undefined}
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

          {receipt ? <ReceiptCard receipt={receipt} turnId={chat.turnId} /> : null}

          {/* Inline plan: always in the compact drawer; in the full surface only
              in a narrow CONTAINER (split pane / slim window), where the side
              panel is hidden — so the plan is never lost when narrow and never
              doubled. Container-query, not viewport: a half-width split pane on
              a big monitor must behave like a narrow window. */}
          {chat.plan && chat.plan.steps.length > 0 ? (
            <div className={full ? '@[64rem]:hidden' : undefined}>
              <Taskboard plan={chat.plan} />
            </div>
          ) : null}

          {hasOrchestrationContent(chat.orchestration) ? (
            <div className={full ? '@[64rem]:hidden' : undefined}>
              <OrchestrationTree nodes={chat.orchestration} />
            </div>
          ) : null}

          <BackgroundTray tasks={chat.background} />

          {chat.approvalQueue.length > 0 ? (
            <ApprovalQueueCard approvals={chat.approvalQueue} />
          ) : chat.pendingApproval ? (
            <ApprovalCard approval={chat.pendingApproval} />
          ) : null}
          {chat.pendingQuestions ? <QuestionsCard pending={chat.pendingQuestions} /> : null}

          {chat.endNote ? (
            <div className="flex items-center justify-center gap-1.5 py-1 text-caption text-fg-tertiary">
              <Square size={11} className="shrink-0" />
              <span>{chat.endNote}</span>
            </div>
          ) : null}

          {chat.error ? <ErrorRecoveryCard error={chat.error} /> : null}
        </div>
       </div>

        {searchOpen && !empty ? (
          <TranscriptSearch messages={chat.messages} onClose={() => setSearchOpen(false)} />
        ) : null}

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

        {/* In the full surface the plan rides in a right-side "Mission Control"
            panel so it stays visible while the transcript scrolls (v5 §G2). The
            compact drawer keeps it inline (collapsible) below. Container-gated
            (≥64rem of PANE width — a viewport query would keep it crushing the
            chat inside a split pane) and collapsible, so the transcript can take
            the full width; the chip below brings it back. */}
        {full && hasMissionContent && missionOpen ? (
          <aside className="hidden w-64 shrink-0 flex-col overflow-y-auto border-l border-subtle p-3 @[64rem]:flex">
            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={() => toggleMission(false)}
                aria-label={t('agent.mission.collapse')}
                title={t('agent.mission.collapse')}
                className="rounded p-1 text-fg-tertiary/60 transition-colors duration-fast hover:bg-surface-3 hover:text-fg-primary"
              >
                <PanelRightClose size={13} />
              </button>
            </div>
            <div className="flex flex-col gap-3">
              <Taskboard plan={chat.plan} />
              <OrchestrationTree nodes={chat.orchestration} />
            </div>
          </aside>
        ) : null}
        {full && hasMissionContent && !missionOpen ? (
          <button
            type="button"
            onClick={() => toggleMission(true)}
            aria-label={t('agent.mission.expand')}
            title={t('agent.mission.expand')}
            className="absolute right-2 top-2 z-10 hidden size-7 items-center justify-center rounded-md border border-subtle bg-surface-2 text-fg-tertiary shadow-card transition-colors duration-fast hover:bg-surface-3 hover:text-fg-primary @[64rem]:flex"
          >
            <PanelRightOpen size={14} />
          </button>
        ) : null}
      </div>

      <footer className="chrome-panel shrink-0 border-x-0 border-b-0">
        <div
          className={cn(
            'flex flex-col gap-2',
            full ? 'mx-auto w-full max-w-3xl px-2 @[25rem]:px-5 py-3' : 'px-3 py-2',
          )}
        >
          {/* Status row: left = pill + usage; right = toggle cluster. Wraps the
              toggle pill to its own line on a narrow drawer instead of overflowing. */}
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 min-w-0">
            {/* Left: status + usage */}
            <div className="flex items-center gap-2.5 min-w-0">
              <StatusPill status={chat.status} elapsed={elapsed} />
              <UsageMeter />
            </div>

            {/* Right: toggles grouped in a single pill-shaped container */}
            <ComposerToggles
              empty={empty}
              busy={busy}
              isReasoningModel={isReasoningModel}
              onToggleSearch={() => setSearchOpen((v) => !v)}
            />
          </div>

          <ComposerBanners />
          <ProviderKeyNudge />

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

            {/* Composer well — softer, near-borderless at rest so the input,
                attachments, and action row read as one continuous surface rather
                than hard-divided sections; the boundary firms up only on focus. */}
            <div className="flex flex-col rounded-xl border border-default/50 bg-surface-2/60 shadow-card transition-[border-color,background-color,box-shadow] duration-fast focus-within:border-accent/60 focus-within:bg-surface-2 focus-within:shadow-focus-accent">
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

              {/* Action bar: attach + model selector on the left, send/stop on
                  the right. The model selector lives here (not pinned at the top)
                  so it's clean and close to the input. */}
              <div className="flex items-center justify-between gap-2 px-1.5 pb-1.5">
                <div className="flex min-w-0 items-center gap-0.5">
                  <ContextButton
                    buttonRef={plusButtonRef}
                    open={contextOpen}
                    onToggle={() => setContextOpen((v) => !v)}
                  />
                  <ComposerModelButton />
                </div>
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

