import { check, passedCount } from '../../harness-kit.ts';
import {
  normalizeSchemaForGoogle,
  normalizeSchemaForOpenAIStrict,
  normalizeSchemaForResponsesCompat,
  normalizeToolSchema,
  isJsonObject,
} from './normalize-schema.ts';

/**
 * Harness for PROV-1 per-provider tool-schema normalization
 * (docs/agent-port-plan.md → "PROV-1 — streamText 전 per-provider tool-schema
 * 정규화").
 *
 * Pure + dependency-free (normalize-schema imports only a type-only ProviderId),
 * so it runs standalone via `npm run harness:normalize-schema` under bare
 * `node --experimental-strip-types`. Covers the doc's acceptance criteria:
 *  - Google: snake_case→camelCase rename, unsupported-field strip → description,
 *    type:null→nullable, propertyOrdering on 2+ props, AND that it does NOT re-do
 *    the type-array→nullable / anyOf-null unwrap the SDK already handles.
 *  - OpenAI strict: additionalProperties:false, required-all, oneOf→anyOf,
 *    optional→anyOf-with-null, nested.
 *  - xai/anthropic/mistral identity (pass-through).
 *  - fail-open on a circular ref (no throw, original returned).
 */

function obj(value: unknown): Record<string, unknown> {
  if (!isJsonObject(value)) throw new Error('expected a JSON object node');
  return value;
}

/* ── Google: snake_case rename ──────────────────────────────────────────── */

{
  const out = obj(
    normalizeSchemaForGoogle({
      type: 'object',
      properties: { a: { type: 'string' } },
      any_of: [{ type: 'string' }],
    }),
  );
  check('google renames any_of → anyOf', Object.hasOwn(out, 'anyOf') && !Object.hasOwn(out, 'any_of'));
}

/* ── Google: unsupported-field strip + liftable lift to description ──────── */

{
  const out = obj(
    normalizeSchemaForGoogle({
      type: 'string',
      pattern: '^[a-z]+$',
      format: 'email',
      $ref: '#/x',
      description: 'an id',
    }),
  );
  check('google strips unsupported pattern', !Object.hasOwn(out, 'pattern'));
  check('google strips unsupported format', !Object.hasOwn(out, 'format'));
  check('google strips unsupported $ref', !Object.hasOwn(out, '$ref'));
  check(
    'google lifts pattern + format into description',
    typeof out.description === 'string' &&
      out.description.includes('pattern: ^[a-z]+$') &&
      out.description.includes('format: email'),
  );
  check('google keeps the original description text', String(out.description).startsWith('an id'));
}

{
  // $ref is unsupported but NOT liftable — stripped without touching description.
  const out = obj(normalizeSchemaForGoogle({ type: 'string', $ref: '#/x' }));
  check('google strips a non-liftable $ref without adding a description', !Object.hasOwn(out, 'description'));
}

/* ── Google: type:null → nullable (SDK does NOT collapse a scalar type:null) ── */

{
  const out = obj(normalizeSchemaForGoogle({ type: 'null' }));
  check('google converts scalar type:null → nullable', out.nullable === true && !Object.hasOwn(out, 'type'));
}

/* ── Google: propertyOrdering on 2+ props, not on a single prop ──────────── */

{
  const out = obj(
    normalizeSchemaForGoogle({
      type: 'object',
      properties: { first: { type: 'string' }, second: { type: 'number' } },
    }),
  );
  check(
    'google adds propertyOrdering for 2+ props in declared order',
    Array.isArray(out.propertyOrdering) &&
      out.propertyOrdering.length === 2 &&
      out.propertyOrdering[0] === 'first' &&
      out.propertyOrdering[1] === 'second',
  );
}

{
  const out = obj(normalizeSchemaForGoogle({ type: 'object', properties: { only: { type: 'string' } } }));
  check('google adds NO propertyOrdering for a single prop', !Object.hasOwn(out, 'propertyOrdering'));
}

/* ── Google: ensure object has properties ───────────────────────────────── */

{
  const out = obj(normalizeSchemaForGoogle({ type: 'object' }));
  check('google backfills empty properties on a bare object', isJsonObject(out.properties));
}

/* ── Google: does NOT double-transform what the SDK already handles ──────── */

{
  // type:[...] array — the SDK splits this into anyOf+nullable, so we must leave
  // it untouched (NOT pre-split it ourselves → no double transform).
  const out = obj(normalizeSchemaForGoogle({ type: ['string', 'null'] }));
  check('google leaves a type-array intact (SDK handles it)', Array.isArray(out.type));
  check('google does NOT add nullable for a type-array', !Object.hasOwn(out, 'nullable'));
}

{
  // anyOf containing {type:'null'} — the SDK unwraps this to nullable, so we must
  // leave it intact (recursing in, but not unwrapping).
  const out = obj(
    normalizeSchemaForGoogle({ anyOf: [{ type: 'string' }, { type: 'null' }] }),
  );
  check('google leaves an anyOf-with-null intact (SDK unwraps it)', Array.isArray(out.anyOf));
  check('google does NOT unwrap anyOf-null to nullable', !Object.hasOwn(out, 'nullable'));
}

{
  // A property literally NAMED like a keyword (`format`, `pattern`) under
  // `properties` is a real field, not a schema keyword — must NOT be stripped.
  const out = obj(
    normalizeSchemaForGoogle({
      type: 'object',
      properties: { format: { type: 'string' }, pattern: { type: 'string' } },
    }),
  );
  const props = obj(out.properties);
  check('google keeps a property NAMED like a keyword', Object.hasOwn(props, 'format') && Object.hasOwn(props, 'pattern'));
}

/* ── OpenAI strict: additionalProperties:false + required-all ────────────── */

{
  const out = obj(
    normalizeSchemaForOpenAIStrict({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    }),
  );
  check('openai strict sets additionalProperties:false', out.additionalProperties === false);
  check(
    'openai strict makes every property required',
    Array.isArray(out.required) && out.required.length === 2 && out.required.includes('a') && out.required.includes('b'),
  );
}

/* ── OpenAI strict: optional prop → anyOf-with-null ─────────────────────── */

{
  const out = obj(
    normalizeSchemaForOpenAIStrict({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    }),
  );
  const props = obj(out.properties);
  const optional = obj(props.b);
  check(
    'openai strict wraps an optional prop as anyOf:[T,{type:null}]',
    Array.isArray(optional.anyOf) &&
      optional.anyOf.length === 2 &&
      isJsonObject(optional.anyOf[1]) &&
      (optional.anyOf[1] as Record<string, unknown>).type === 'null',
  );
  const required = obj(props.a);
  check('openai strict leaves a required prop unwrapped', required.type === 'string');
}

/* ── OpenAI strict: oneOf → anyOf ───────────────────────────────────────── */

{
  const out = obj(
    normalizeSchemaForOpenAIStrict({ oneOf: [{ type: 'string' }, { type: 'number' }] }),
  );
  check('openai strict rewrites oneOf → anyOf', Array.isArray(out.anyOf) && !Object.hasOwn(out, 'oneOf'));
  check('openai strict anyOf keeps both oneOf branches', Array.isArray(out.anyOf) && out.anyOf.length === 2);
}

/* ── OpenAI strict: nested object closed recursively ────────────────────── */

{
  const out = obj(
    normalizeSchemaForOpenAIStrict({
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: { x: { type: 'string' } },
          required: ['x'],
        },
      },
      required: ['nested'],
    }),
  );
  const nested = obj(obj(out.properties).nested);
  check('openai strict closes a nested object too', nested.additionalProperties === false);
}

/* ── OpenAI strict: non-structural keyword stripped ─────────────────────── */

{
  const out = obj(
    normalizeSchemaForOpenAIStrict({ type: 'string', pattern: '^x$', format: 'email' }),
  );
  check('openai strict strips non-structural pattern/format', !Object.hasOwn(out, 'pattern') && !Object.hasOwn(out, 'format'));
}

/* ── Responses-API compat (xai / openai-codex): oneOf→anyOf, no strict mode ── */

{
  const out = obj(
    normalizeSchemaForResponsesCompat({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
      oneOf: [{ type: 'string' }, { type: 'number' }],
    }),
  );
  check('responses-compat rewrites oneOf → anyOf', Array.isArray(out.anyOf) && !Object.hasOwn(out, 'oneOf'));
  check('responses-compat anyOf keeps both oneOf branches', Array.isArray(out.anyOf) && out.anyOf.length === 2);
  // NO strict-mode forcing: additionalProperties is left untouched and optional
  // props are NOT wrapped / required-all is NOT applied.
  check('responses-compat does NOT force additionalProperties:false', !Object.hasOwn(out, 'additionalProperties'));
  check(
    'responses-compat leaves required as authored (no required-all)',
    Array.isArray(out.required) && out.required.length === 1 && out.required[0] === 'a',
  );
  const props = obj(out.properties);
  check('responses-compat leaves an optional prop unwrapped (no anyOf-null)', obj(props.b).type === 'number');
}

{
  // Nested oneOf inside a property is rewritten too; a sibling anyOf is merged.
  const out = obj(
    normalizeSchemaForResponsesCompat({
      type: 'object',
      properties: {
        v: { oneOf: [{ type: 'string' }], anyOf: [{ type: 'boolean' }] },
      },
    }),
  );
  const v = obj(obj(out.properties).v);
  check('responses-compat merges a nested oneOf into a sibling anyOf', Array.isArray(v.anyOf) && v.anyOf.length === 2 && !Object.hasOwn(v, 'oneOf'));
}

{
  // Non-structural keywords are PRESERVED (unlike openai-strict, which strips them).
  const out = obj(normalizeSchemaForResponsesCompat({ type: 'string', format: 'email', pattern: '^x$' }));
  check('responses-compat preserves format/pattern (no strip)', out.format === 'email' && out.pattern === '^x$');
}

{
  // Dispatch: xai + openai-codex → responses-compat (oneOf rewritten, no strict).
  const schema = { type: 'object', properties: { a: { type: 'string' } }, oneOf: [{ type: 'string' }, { type: 'number' }] };
  for (const provider of ['xai', 'openai-codex'] as const) {
    const out = obj(normalizeToolSchema(provider, schema));
    check(`${provider} dispatches to responses-compat (oneOf→anyOf)`, Array.isArray(out.anyOf) && !Object.hasOwn(out, 'oneOf'));
    check(`${provider} responses-compat does not force strict mode`, !Object.hasOwn(out, 'additionalProperties'));
  }
}

{
  // Fail-open: a circular ref must not throw.
  const circular: Record<string, unknown> = { type: 'object', properties: {} };
  (circular.properties as Record<string, unknown>).self = circular;
  let threw = false;
  let res: object = {};
  try {
    res = normalizeSchemaForResponsesCompat(circular);
  } catch {
    threw = true;
  }
  check('responses-compat does not throw on a circular ref', !threw);
  check('responses-compat fail-open returns an object', isJsonObject(res));
}

/* ── Identity providers: anthropic / mistral pass-through ────────────────── */

{
  const schema = {
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'number' } },
    oneOf: [{ type: 'string' }],
    format: 'email',
  };
  for (const provider of ['anthropic', 'mistral'] as const) {
    const out = normalizeToolSchema(provider, schema);
    check(`${provider} is identity (same reference returned)`, out === schema);
  }
  const undefOut = normalizeToolSchema(undefined, schema);
  check('undefined provider is identity (same reference returned)', undefOut === schema);
}

/* ── Dispatch: google family → Google, openai → strict ──────────────────── */

{
  const schema = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } };
  for (const provider of ['google', 'google-caa', 'google-vertex'] as const) {
    const out = obj(normalizeToolSchema(provider, schema));
    check(`${provider} dispatches to the Google normalizer (propertyOrdering present)`, Array.isArray(out.propertyOrdering));
  }
  const openaiOut = obj(normalizeToolSchema('openai', schema));
  check('openai dispatches to the OpenAI-strict normalizer', openaiOut.additionalProperties === false);
}

/* ── Fail-open: circular ref returns the original, never throws ──────────── */

{
  const circular: Record<string, unknown> = { type: 'object', properties: {} };
  (circular.properties as Record<string, unknown>).self = circular;

  // Google: a self-referential schema must not throw the turn.
  let googleThrew = false;
  let googleOut: object = {};
  try {
    googleOut = normalizeSchemaForGoogle(circular);
  } catch {
    googleThrew = true;
  }
  check('google normalizer does not throw on a circular ref', !googleThrew);
  check('google fail-open is defined', isJsonObject(googleOut));

  // OpenAI strict has an explicit WeakMap+Set cycle guard — must terminate.
  let openaiThrew = false;
  let openaiOut: object = {};
  try {
    openaiOut = normalizeSchemaForOpenAIStrict(circular);
  } catch {
    openaiThrew = true;
  }
  check('openai-strict normalizer does not throw on a circular ref', !openaiThrew);
  check('openai-strict cycle guard terminates and returns an object', isJsonObject(openaiOut));
}

console.log(`\n${passedCount()} checks passed`);
