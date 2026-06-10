/**
 * Public entry for the chat card components. Each card lives in its own module
 * under ./cards/ (one concern per file); this barrel keeps the import surface
 * AgentChat.tsx and Transcript.tsx use stable, so the split has no blast radius.
 */
export { ChangesSection } from './cards/ChangesSection';
export { ReceiptCard } from './cards/ReceiptCard';
export { ApprovalCard } from './cards/ApprovalCard';
export { QuestionsCard } from './cards/QuestionsCard';
export { ErrorRecoveryCard } from './cards/ErrorRecoveryCard';
export { Taskboard } from './cards/Taskboard';
export { BackgroundTray } from './cards/BackgroundTray';
