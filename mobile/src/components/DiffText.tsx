/**
 * Colored, scrollable monospace rendering of a unified diff: `+` lines green,
 * `-` lines red, `@@` hunk headers faint. Pure presentation — the diff text is
 * PC-computed (a bounded `RemoteEditDiff.diff`) or assembled locally from an
 * approval's proposed before/after snippet.
 */
export function DiffText({ text }: { text: string }) {
  return (
    <pre className="diff-view">
      {text.split('\n').map((line, i) => (
        <span key={i} className={`diff-view__line ${classOf(line)}`}>
          {line.length > 0 ? line : ' '}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

function classOf(line: string): string {
  if (line.startsWith('@@')) return 'diff-view__line--hunk';
  if (line.startsWith('+')) return 'diff-view__line--add';
  if (line.startsWith('-')) return 'diff-view__line--remove';
  if (line.startsWith('…')) return 'diff-view__line--hunk';
  return '';
}

/**
 * Assemble a `-`/`+` prefixed pseudo-diff from an approval's proposed
 * before/after snippet (the host sends oldString/newString, not a full diff).
 */
export function proposedDiffText(before: string, after: string): string {
  const removed = before.length > 0 ? before.split('\n').map((l) => `-${l}`) : [];
  const added = after.length > 0 ? after.split('\n').map((l) => `+${l}`) : [];
  return [...removed, ...added].join('\n');
}
