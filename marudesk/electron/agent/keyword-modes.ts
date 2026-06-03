/**
 * Keyword modes (absorbed from oh-my-openagent's `ulw`/ultrawork trigger): a
 * shorthand the user can drop into a request to switch the agent into a tuned
 * working mode. When a keyword is present we prepend a short preamble to the
 * MODEL-facing user text (the chat still shows the user's original message), so
 * it's a cheap, opt-in steer with no model/loop changes.
 *
 * Detection ignores code (fenced ``` blocks + `inline`) so a literal "ulw" in a
 * snippet doesn't trigger it. Only the first matching mode's banner is added.
 */

type KeywordMode = {
  /** Word-boundary pattern tested against the user's prose (code stripped). */
  pattern: RegExp;
  /** Instruction block prepended to the model-facing user text. */
  preamble: string;
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

const MODES: KeywordMode[] = [
  { pattern: /\b(ulw|ultrawork)\b/i, preamble: ULTRAWORK_PREAMBLE },
];

/** Remove fenced and inline code so keywords inside snippets don't trigger. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}

/**
 * The preamble for the first keyword mode present in `prompt`, or null when none
 * matches. Prepend it to the model-facing user text.
 */
export function keywordModePreamble(prompt: string): string | null {
  const prose = stripCode(prompt);
  for (const mode of MODES) {
    if (mode.pattern.test(prose)) return mode.preamble;
  }
  return null;
}
