import { check, passedCount } from '../harness-kit.ts';
import { normalizeModelId, resolveModelEntry } from '../../shared/model-normalize.ts';
import { MODELS } from '../../shared/provider-catalog.ts';
import { maxTokensForTurn, AGENT_MAX_TOKENS } from './reasoning-config.ts';

/**
 * Harness for SECOND-PASS items 1 (per-model max-output-tokens) + 2 (model-id
 * dotted-version normalization). PURE: model-normalize + reasoning-config import
 * only types at runtime, and provider-catalog is plain data, so this runs under a
 * bare `node --experimental-strip-types` harness.
 */

/* ── item 2: normalizeModelId ───────────────────────────────────────────── */

check('dotted version → dashed', normalizeModelId('claude-opus-4.8') === 'claude-opus-4-8');
check('dotted sonnet → dashed', normalizeModelId('claude-sonnet-4.6') === 'claude-sonnet-4-6');
check('drops vendor prefix', normalizeModelId('anthropic/claude-sonnet-4.6') === 'claude-sonnet-4-6');
check('drops openai vendor prefix', normalizeModelId('openai/gpt-5.5') === 'gpt-5-5');
check('drops trailing date suffix', normalizeModelId('claude-haiku-4-5-20251001') === 'claude-haiku-4-5');
check('already-canonical id is unchanged', normalizeModelId('claude-opus-4-8') === 'claude-opus-4-8');
check('non-vendor first path segment kept', normalizeModelId('accounts/fireworks/models/deepseek-v3') === 'accounts/fireworks/models/deepseek-v3');
check('empty string passes through', normalizeModelId('') === '');
check('trims surrounding whitespace', normalizeModelId('  gpt-5  ') === 'gpt-5');

/* ── item 2: resolveModelEntry tolerates varied ids ─────────────────────── */

{
  const exact = resolveModelEntry(MODELS, 'anthropic', 'claude-opus-4-8');
  check('exact match resolves', exact?.id === 'claude-opus-4-8');
}
{
  // The catalog id is dashed; a live-fetched dotted id must still resolve.
  const dotted = resolveModelEntry(MODELS, 'anthropic', 'claude-opus-4.8');
  check('dotted id resolves to dashed catalog entry', dotted?.id === 'claude-opus-4-8');
  check('dotted id carries the catalog reasoning flag', dotted?.reasoning === true);
}
{
  // Haiku's catalog id has a date suffix; the bare id must resolve to it.
  const bare = resolveModelEntry(MODELS, 'anthropic', 'claude-haiku-4-5');
  check('date-suffixed catalog entry resolves from a bare id', bare?.id === 'claude-haiku-4-5-20251001');
}
{
  const miss = resolveModelEntry(MODELS, 'anthropic', 'totally-made-up-model');
  check('an unknown id resolves to undefined (caller keeps its default)', miss === undefined);
}

/* ── item 1: maxOutputTokens in the catalog ─────────────────────────────── */

{
  const opus = resolveModelEntry(MODELS, 'anthropic', 'claude-opus-4-8');
  check('opus catalog carries maxOutputTokens 64000', opus?.maxOutputTokens === 64_000);
  const gpt5 = resolveModelEntry(MODELS, 'openai', 'gpt-5');
  check('gpt-5 catalog carries maxOutputTokens 128000', gpt5?.maxOutputTokens === 128_000);
}

/* ── item 1: maxTokensForTurn uses the catalog value, 4096 only as floor ─── */

{
  // No catalog value → flat floor (back-compat).
  check('no catalogMax falls back to the 4096 floor', maxTokensForTurn() === AGENT_MAX_TOKENS);
  // A sub-floor catalog value never drops BELOW the floor.
  check('catalogMax below the floor is clamped up to the floor', maxTokensForTurn(1000) === AGENT_MAX_TOKENS);
  // A real catalog value lifts the cap (gpt-5 128K). Reasoning needs no special
  // headroom now — every dialect is adaptive (Claude output_config.effort etc.).
  check('a catalog value lifts the cap to its ceiling', maxTokensForTurn(128_000) === 128_000);
}

console.log(`\n${passedCount()} checks passed`);
