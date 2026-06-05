/**
 * Keyword modes (absorbed from oh-my-openagent's IntentGate, starting with the
 * `ulw`/ultrawork trigger): shorthand a user can drop into a request to switch
 * the agent into a tuned working mode. When a keyword is present we prepend a
 * short preamble to the MODEL-facing user text (the chat still shows the user's
 * original message), so it's a cheap, opt-in steer with no model/loop changes.
 *
 * Multiple modes accumulate: "ultrathink and ulw" applies both preambles. Order
 * is the MODES order, deduped. A `think`-family mode additionally asks the loop
 * to raise the model's reasoning effort this turn (see {@link wantsDeepThinking}).
 *
 * Triggers are intentional shorthands / phrases (not bare common words like
 * "search"), so per-message steering doesn't misfire on ordinary prose.
 * Detection ignores code (fenced ``` blocks + `inline`) so a literal keyword in
 * a snippet doesn't trigger it.
 */

type KeywordMode = {
  /** Stable id (dedupe + tests). */
  id: string;
  /** Word-boundary pattern tested against the user's prose (code stripped). */
  pattern: RegExp;
  /** Instruction block prepended to the model-facing user text. */
  preamble: string;
  /**
   * Marks the model's extended-thinking effort to be raised this turn (the
   * think/ultrathink family). The loop only acts on this for reasoning models;
   * otherwise it's a no-op beyond the preamble steer.
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

/** Remove fenced and inline code so keywords inside snippets don't trigger. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}

/** Every keyword mode present in `prompt` (code stripped), in MODES order. */
function detectModes(prompt: string): KeywordMode[] {
  const prose = stripCode(prompt);
  return MODES.filter((m) => m.pattern.test(prose));
}

/**
 * The combined preamble for every keyword mode present in `prompt`, or null when
 * none match. Prepend it to the model-facing user text. Multiple modes stack,
 * separated by a blank line.
 */
export function keywordModePreamble(prompt: string): string | null {
  const modes = detectModes(prompt);
  if (modes.length === 0) return null;
  return modes.map((m) => m.preamble).join('\n\n');
}

/**
 * Whether the prompt asks for deep thinking (think/ultrathink family), so the
 * loop can raise the turn's reasoning effort. Only meaningful for reasoning
 * models — the caller gates on that.
 */
export function wantsDeepThinking(prompt: string): boolean {
  return detectModes(prompt).some((m) => m.raisesThinking === true);
}
