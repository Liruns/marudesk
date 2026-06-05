import { useEffect, useRef, useState } from 'react';
import type { AgentChatState } from '../../../../shared/agent';

const BOTTOM_THRESHOLD_PX = 80;

type StickyTranscriptScrollInput = {
  readonly messages: AgentChatState['messages'];
  readonly status: AgentChatState['status'];
  readonly edits: AgentChatState['edits'];
  readonly pendingApproval: AgentChatState['pendingApproval'];
  readonly pendingQuestions: AgentChatState['pendingQuestions'];
  readonly endNote: AgentChatState['endNote'];
};

export function useStickyTranscriptScroll({
  messages,
  status,
  edits,
  pendingApproval,
  pendingQuestions,
  endNote,
}: StickyTranscriptScrollInput) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;
  }, [messages, status, edits, pendingApproval, pendingQuestions, endNote]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;

    const currentTop = el.scrollTop;
    const scrolledUp = currentTop < lastScrollTopRef.current;
    lastScrollTopRef.current = currentTop;

    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
    const nextStick = scrolledUp ? false : nearBottom || stickToBottomRef.current;
    stickToBottomRef.current = nextStick;
    setAtBottom(nextStick);
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (e.deltaY >= 0 || !el || el.scrollHeight <= el.clientHeight) return;
    stickToBottomRef.current = false;
    setAtBottom(false);
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const stickToBottom = () => {
    stickToBottomRef.current = true;
  };

  return { scrollRef, atBottom, handleScroll, handleWheel, scrollToBottom, stickToBottom };
}
