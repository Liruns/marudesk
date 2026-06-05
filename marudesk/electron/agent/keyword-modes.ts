/**
 * Keyword modes (absorbed from oh-my-openagent's IntentGate, beyond both it and
 * Claude Code): shorthand a user drops into a request to switch the agent into a
 * tuned working mode. We prepend a short preamble to the MODEL-facing user text
 * (the chat still shows the user's original message), so it's a cheap, opt-in
 * steer with no model/loop changes.
 *
 * STICKY + user-controlled (the loop owns the active set): once a mode keyword
 * appears it persists across turns until the user clears it ("mode off") — unlike
 * oh-my-openagent, which re-injects a fixed mode's full prompt into EVERY message
 * with no off switch, and unlike Claude Code, which has no equivalent. Multiple
 * modes stack. A `think`-family mode also raises the turn's reasoning effort (see
 * {@link modeRaisesThinking}).
 *
 * This module is pure (no state): it detects which modes a message references and
 * renders preambles for an id set. Triggers are intentional shorthands / phrases
 * (not bare common words), and detection ignores code (fenced ``` + `inline`) so
 * a keyword inside a snippet never triggers.
 */

type KeywordMode = {
  /** Stable id — the loop tracks the active set by these. */
  id: string;
  /** Word-boundary pattern tested against the user's prose (code stripped). */
  pattern: RegExp;
  /** Instruction block prepended to the model-facing user text. */
  preamble: string;
  /**
   * Marks the model's extended-thinking effort to be raised this turn (the
   * think/ultrathink family). The loop only acts on this for reasoning models.
   */
  raisesThinking?: boolean;
};

const ULTRAWORK_PREAMBLE = [
  '[Ultrawork mode — the user wants maximum rigor and autonomy on this task.]',
  'Work thoroughly to completion:',
  '- Investigate before acting: read the relevant files and runtime state; do not guess.',
  '- Make a brief plan, then carry it out end-to-end without stopping early for confirmation.',
  '- After changes, verify them (build/tests/the real surface) and fix what you find.',
  '- Prefer the smallest correct change; respect existing structure and conventions.',
  '- State assumptions explicitly; only ask the user when genuinely blocked.',
].join('\n');

const SEARCH_PREAMBLE = [
  '[Search mode — locate the relevant code/context before answering.]',
  '- Cast a wide net first: grep/list across the workspace and read the runtime state that bears on the request.',
  '- Report WHERE things live (file:line) and how they connect before proposing any change.',
  '- Prefer evidence from the actual files over assumptions; cite what you found.',
].join('\n');

const ANALYZE_PREAMBLE = [
  '[Analyze mode — the user wants a careful analysis, not a quick edit.]',
  '- Read the relevant code and runtime evidence end-to-end before concluding.',
  '- Explain the mechanism: root cause, data flow, and trade-offs — with concrete references.',
  '- Lay out the options with their consequences; only edit if the user asked you to.',
].join('\n');

const THINK_PREAMBLE = [
  '[Deep-thinking mode — the user asked you to think carefully.]',
  '- Reason through the problem thoroughly before acting; weigh edge cases and alternatives.',
  '- Surface the key steps of your reasoning so the user can follow the decision.',
].join('\n');

const MODES: KeywordMode[] = [
  { id: 'ultrawork', pattern: /\b(ulw|ultrawork)\b/i, preamble: ULTRAWORK_PREAMBLE },
  { id: 'search', pattern: /\b(deep ?search|search mode)\b/i, preamble: SEARCH_PREAMBLE },
  { id: 'analyze', pattern: /\b(deep ?analy(?:ze|sis)|analyze mode)\b/i, preamble: ANALYZE_PREAMBLE },
  {
    id: 'think',
    pattern: /\b(ultrathink|think (?:hard|harder|deeply|carefully|step by step))\b/i,
    preamble: THINK_PREAMBLE,
    raisesThinking: true,
  },
];

/** Explicit "turn the modes off" control phrases (checked before additions). */
const OFF_RE = /\b(modes? off|clear modes?|reset modes?|stop (?:ultrawork|ulw|deep[- ]?think(?:ing)?|modes?))\b/i;

/** Remove fenced and inline code so keywords inside snippets don't trigger. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}

/** Whether the message is an explicit request to clear all active modes. */
export function isModeClear(prompt: string): boolean {
  return OFF_RE.test(stripCode(prompt));
}

/** The mode ids referenced in `prompt` (code stripped), in MODES order. */
export function modesInPrompt(prompt: string): string[] {
  const prose = stripCode(prompt);
  return MODES.filter((m) => m.pattern.test(prose)).map((m) => m.id);
}

/**
 * The combined preamble for an active mode-id set, or null when empty. Modes are
 * rendered in MODES order regardless of activation order, separated by a blank
 * line. Unknown ids are ignored.
 */
export function modePreamble(ids: readonly string[]): string | null {
  const set = new Set(ids);
  const blocks = MODES.filter((m) => set.has(m.id)).map((m) => m.preamble);
  return blocks.length > 0 ? blocks.join('\n\n') : null;
}

/** Whether any active mode raises the turn's reasoning effort (think family). */
export function modeRaisesThinking(ids: readonly string[]): boolean {
  const set = new Set(ids);
  return MODES.some((m) => set.has(m.id) && m.raisesThinking === true);
}
