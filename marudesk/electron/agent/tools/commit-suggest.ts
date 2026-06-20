import { generateText } from 'ai';
import { runGit } from '../../git';
import { resolveProviderAuth } from '../resolve-auth';
import { buildModel } from '../model';
import { firstJsonObject } from '../run-task';
import {
  splitDiffByFile,
  capMappedFiles,
  buildMapPrompt,
  buildReducePrompt,
  parseCommitSuggestion,
  formatSuggestionText,
  type FileSummary,
} from '../commit-suggest-core.ts';
import type { McpTool, ToolContext, ToolResult } from './types';

/**
 * `suggest_commit` (SECOND-PASS: gajae commit/map-reduce/*, commit/changelog/*) —
 * marudesk has no commit-message generation. This tool takes the workspace's
 * current git diff (staged or full working tree), MAP-reduces it (one terse
 * model summary per changed file → a single reduce call that folds them into a
 * structured Conventional Commits message + changelog entry), and returns the
 * suggestion. It NEVER commits: it only proposes text, so it's not a write tool
 * and not gated (read-only on the repo). Map-reduce is bounded (file + byte caps
 * in commit-suggest-core) so a huge diff can't blow the context window or the bill.
 */

const MAP_MAX_TOKENS = 120;
const REDUCE_MAX_TOKENS = 512;

async function suggestCommitTool(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.ws) {
    return { summary: 'suggest_commit failed', text: 'No workspace is open to read a git diff from.', isError: true };
  }
  if (!ctx.provider || !ctx.model) {
    return { summary: 'suggest_commit failed', text: 'No model is available to generate a commit message.', isError: true };
  }
  const staged = input.staged === true;
  // Read the diff with the SAME hardened git runner Source Control uses.
  let diff: string;
  try {
    const args = staged ? ['diff', '--cached'] : ['diff', 'HEAD'];
    diff = (await runGit(ctx.ws.root, args)).stdout;
  } catch {
    // No HEAD yet (unborn branch) — fall back to the index diff so a first commit
    // still gets a suggestion.
    try {
      diff = (await runGit(ctx.ws.root, ['diff', '--cached'])).stdout;
    } catch (err) {
      return { summary: 'suggest_commit failed', text: `git diff failed: ${(err as Error).message}`, isError: true };
    }
  }

  const files = splitDiffByFile(diff);
  if (files.length === 0) {
    return {
      summary: 'suggest_commit: no changes',
      text: staged
        ? 'No staged changes to summarize. Stage files or call without `staged` to use the full working tree.'
        : 'No uncommitted changes to summarize.',
    };
  }
  const { mapped, omitted } = capMappedFiles(files);

  // Build the model once and reuse it for every map call + the reduce call.
  const resolved = await resolveProviderAuth(ctx.provider);
  if (!resolved.ok) {
    return { summary: 'suggest_commit failed', text: resolved.reason, isError: true };
  }
  const model = buildModel(ctx.provider, ctx.model, resolved.auth, resolved.baseUrl);

  // MAP: one terse summary per changed file, in parallel (bounded by the file cap).
  const summaries: FileSummary[] = await Promise.all(
    mapped.map(async (file): Promise<FileSummary> => {
      try {
        const res = await generateText({
          model,
          prompt: buildMapPrompt(file),
          maxOutputTokens: MAP_MAX_TOKENS,
          abortSignal: ctx.signal,
        });
        const summary = res.text.trim();
        return { path: file.path, summary: summary || '(no summary)' };
      } catch {
        // A single failed map shouldn't sink the whole suggestion — note it and move on.
        return { path: file.path, summary: '(could not summarize this file)' };
      }
    }),
  );

  // REDUCE: fold the per-file summaries into one structured commit + changelog.
  let reduceText: string;
  try {
    const res = await generateText({
      model,
      prompt: buildReducePrompt(summaries, omitted),
      maxOutputTokens: REDUCE_MAX_TOKENS,
      abortSignal: ctx.signal,
    });
    reduceText = res.text;
  } catch (err) {
    return { summary: 'suggest_commit failed', text: `reduce step failed: ${(err as Error).message}`, isError: true };
  }

  const suggestion = parseCommitSuggestion(firstJsonObject(reduceText));
  if (!suggestion) {
    return {
      summary: 'suggest_commit failed',
      text: 'The model did not return a usable commit message. Raw output:\n\n' + reduceText.slice(0, 1000),
      isError: true,
    };
  }
  const omittedNote = omitted > 0 ? ` (+${omitted} more file${omitted === 1 ? '' : 's'} not individually summarized)` : '';
  return {
    summary: `commit: ${suggestion.type}${suggestion.scope ? `(${suggestion.scope})` : ''}: ${suggestion.subject}`,
    text: `${formatSuggestionText(suggestion)}\n\nAnalyzed ${mapped.length} file${mapped.length === 1 ? '' : 's'}${omittedNote}.`,
  };
}

export const SUGGEST_COMMIT_TOOL: McpTool = {
  name: 'suggest_commit',
  description:
    "Generate a Conventional Commits message and a changelog entry from the workspace's current git diff. It reads the diff (staged with `staged: true`, otherwise the full working tree vs. HEAD), summarizes each changed file, then folds those into a structured commit message — it does NOT commit anything, it only proposes the text for you to review. Use it when the user asks for a commit message, after finishing a set of edits, or to draft a changelog entry. Bounded: very large diffs analyze only the first files.",
  inputSchema: {
    type: 'object',
    properties: {
      staged: {
        type: 'boolean',
        description: 'Analyze only staged changes (git diff --cached). Default false: the full working tree vs. HEAD.',
      },
    },
    additionalProperties: false,
  },
  group: 'files',
  gated: false,
  write: false,
  requiresWorkspace: true,
  exec: suggestCommitTool,
};
