import type { ProviderId } from '../../../shared/providers';

/**
 * PROV-1 (docs/agent-port-plan.md → "PROV-1 — streamText 전 per-provider
 * tool-schema 정규화"): normalize a tool's JSON-Schema input for the target
 * provider just before the AI SDK wraps it (`jsonSchema()` in model.ts.aiTools).
 *
 * PURE + dependency-free: no Electron, no logger, no external imports beyond a
 * type-only `ProviderId` (erased at runtime), so this module loads under a bare
 * `node --experimental-strip-types` harness. `console.warn` is the only side
 * effect, on the fail-open path.
 *
 * ── Step-1 verification gate (installed SDK behavior — versions pinned so the
 * cited lines are reproducible) ───────────────────────────────────────────────
 *
 * `@ai-sdk/google` v3.0.80 — `convertJSONSchemaToOpenAPISchema`
 * (node_modules/@ai-sdk/google/dist/index.js:291-400) runs BEFORE the wire call
 * and ALREADY:
 *   • splits `type: [..., "null"]` arrays into `anyOf` + `nullable: true` (L328-343)
 *   • unwraps an `anyOf` that contains `{type:"null"}` into `nullable: true` (L364-391)
 *   • converts `const` → single-entry `enum` (L325-327)
 * So {@link normalizeSchemaForGoogle} must NOT re-do those — a double transform
 * produces wrong output. The SDK's destructure (L307-320) keeps only a fixed key
 * set, so it SILENTLY DROPS `pattern`, `minimum`/`maximum`, `minItems`/`maxItems`,
 * `examples`, `$ref`, `$defs`, `prefixItems`, `additionalProperties`, … with no
 * description lift, and it does NOT do snake_case→camelCase renames, does NOT add
 * `propertyOrdering`, and does NOT ensure an object node has `properties`. THOSE
 * are exactly what we normalize here (SDK-untouched fields only).
 *
 * `@ai-sdk/openai` v3.0.67 — passes `parameters: tool.inputSchema` VERBATIM
 * (node_modules/@ai-sdk/openai/dist/index.js:609 and :4490), no transform, so the
 * OpenAI-strict normalizer is the only thing shaping the schema (no double
 * transform to avoid). `tool.strict` is NOT set by aiTools, so the strict-shape
 * fields we add (`additionalProperties:false`, required-all) are backward
 * compatible — they tighten the documented shape without flipping strict mode on.
 */

/** A plain JSON object node in a JSON Schema (not an array, not a primitive). */
export type JsonObject = { [key: string]: unknown };

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fields the Google Generative AI Schema proto rejects. The SDK silently drops
 * these (they fall out of its destructure) WITHOUT preserving the human-meaning
 * — so we strip them ourselves and lift the documentation-bearing ones into the
 * node's `description`. Copied from the reference catalog (gajae
 * packages/ai/src/utils/schema/fields.ts UNSUPPORTED_SCHEMA_FIELDS) so this stays
 * dependency-free.
 *
 * NB: `additionalProperties` is unsupported by Google and stripped, but it is
 * NOT liftable (no human meaning to preserve).
 */
const GOOGLE_UNSUPPORTED_FIELDS: ReadonlySet<string> = new Set([
  '$schema',
  '$ref',
  '$defs',
  '$dynamicRef',
  '$dynamicAnchor',
  'examples',
  'prefixItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'patternProperties',
  'additionalProperties',
  'propertyNames',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'pattern',
  'format',
]);

/**
 * The subset of {@link GOOGLE_UNSUPPORTED_FIELDS} that carries human-meaningful
 * validation/decorative semantics worth preserving in a sibling `description`
 * when stripped (reference: LIFTABLE_TO_DESCRIPTION_FIELDS).
 */
const GOOGLE_LIFTABLE_FIELDS: ReadonlySet<string> = new Set([
  'pattern',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
]);

/**
 * snake_case keys some MCP servers emit that Google's Schema proto only accepts
 * camelCased. Renamed BEFORE recursion at non-`properties` levels (a property
 * literally NAMED `any_of` under `properties` is a real field name, not a
 * keyword, so it must not be touched). Reference: SNAKE_TO_CAMEL_RENAMES.
 */
const SNAKE_TO_CAMEL: ReadonlyMap<string, string> = new Map([
  ['additional_properties', 'additionalProperties'],
  ['any_of', 'anyOf'],
  ['one_of', 'oneOf'],
  ['all_of', 'allOf'],
  ['prefix_items', 'prefixItems'],
  ['property_ordering', 'propertyOrdering'],
]);

/** Non-structural keywords stripped during OpenAI-strict sanitization. */
const OPENAI_NON_STRUCTURAL_FIELDS: ReadonlySet<string> = new Set([
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'uniqueItems',
  'multipleOf',
  '$schema',
  'examples',
  'title',
  '$comment',
]);

/** Append a stripped keyword's value as a readable clause to `node.description`. */
function liftToDescription(node: JsonObject, lifted: Array<[string, unknown]>): void {
  if (lifted.length === 0) return;
  const clause = lifted
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ');
  const existing = typeof node.description === 'string' ? node.description : '';
  node.description = existing ? `${existing} (${clause})` : `(${clause})`;
}

/** Shallow snake_case→camelCase rename of a node's own keys (reference collision rule). */
function applySnakeCaseRenames(node: JsonObject): JsonObject {
  let needs = false;
  for (const key of Object.keys(node)) {
    if (SNAKE_TO_CAMEL.has(key)) {
      needs = true;
      break;
    }
  }
  if (!needs) return node;
  const out: JsonObject = {};
  for (const key of Object.keys(node)) {
    const renamed = SNAKE_TO_CAMEL.get(key);
    if (renamed !== undefined) {
      // snake_case wins over an existing camelCase entry (python-genai parity).
      out[renamed] = node[key];
    } else if (!Object.hasOwn(out, key)) {
      out[key] = node[key];
    }
  }
  return out;
}

/**
 * Google normalizer core — recurses through schema-valued positions. `insideProps`
 * is true when walking the VALUE map under `properties`/`$defs`/… so that real
 * field NAMES are never treated as keyword positions (renames/strips apply to
 * keyword levels only, matching the reference's `insideProperties` flag).
 *
 * Deliberately does NOT touch `type: [...]` arrays or `anyOf`-with-null — the
 * Google SDK already converts those (see the module header); re-doing them would
 * double-transform. The `onPath` Set is the cycle guard (a node already on the
 * active path returns `{}` rather than recursing forever — fail-safe, not a
 * thrown stack overflow).
 */
function normalizeGoogleNode(value: unknown, insideProps: boolean, onPath: Set<JsonObject>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeGoogleNode(entry, false, onPath));
  }
  if (!isJsonObject(value)) return value;
  if (onPath.has(value)) return {};
  onPath.add(value);

  const renamed = insideProps ? value : applySnakeCaseRenames(value);
  const result: JsonObject = {};
  const lifted: Array<[string, unknown]> = [];

  for (const key of Object.keys(renamed)) {
    const entry = renamed[key];
    if (!insideProps && GOOGLE_UNSUPPORTED_FIELDS.has(key)) {
      if (GOOGLE_LIFTABLE_FIELDS.has(key)) lifted.push([key, entry]);
      continue;
    }
    // `properties`/`$defs`/`definitions` hold a NAME→schema map: recurse into the
    // schemas but treat their keys as field names (insideProps for the map level).
    if (!insideProps && (key === 'properties' || key === '$defs' || key === 'definitions')) {
      result[key] = isJsonObject(entry)
        ? normalizeGooglePropertyMap(entry, onPath)
        : normalizeGoogleNode(entry, false, onPath);
      continue;
    }
    result[key] = normalizeGoogleNode(entry, false, onPath);
  }

  liftToDescription(result, lifted);

  // type:null → nullable (the SDK only collapses type ARRAYS containing null and
  // anyOf-with-null, not a bare scalar `type:"null"`), so this is SDK-untouched.
  if (result.type === 'null') {
    delete result.type;
    result.nullable = true;
  }

  // propertyOrdering for object nodes with 2+ props (Google honors declared order
  // only when this is present; the SDK never adds it).
  if (
    result.type === 'object' &&
    !Object.hasOwn(result, 'propertyOrdering') &&
    isJsonObject(result.properties)
  ) {
    const keys = Object.keys(result.properties);
    if (keys.length > 1) result.propertyOrdering = keys;
  }

  // ensure an object node has a `properties` member (Google rejects a bare
  // `type:"object"` without it; the SDK never backfills it).
  if (result.type === 'object' && !Object.hasOwn(result, 'properties')) {
    result.properties = {};
  }

  onPath.delete(value);
  return result;
}

/** Recurse into a NAME→schema map (the value under `properties`/`$defs`/…). */
function normalizeGooglePropertyMap(map: JsonObject, onPath: Set<JsonObject>): JsonObject {
  const out: JsonObject = {};
  for (const name of Object.keys(map)) {
    out[name] = normalizeGoogleNode(map[name], false, onPath);
  }
  return out;
}

/**
 * Normalize a tool schema for Google's Generative AI Schema proto — SDK-untouched
 * fields ONLY (see module header for the double-transform avoidance). Fail-open.
 */
export function normalizeSchemaForGoogle(schema: object): object {
  try {
    const out = normalizeGoogleNode(schema, false, new Set());
    return isJsonObject(out) ? out : schema;
  } catch (err) {
    console.warn(`[schema-normalize] google normalizer failed, using original schema: ${String(err)}`);
    return schema;
  }
}

/**
 * OpenAI-strict normalizer core. Closes every object node
 * (`additionalProperties:false`, all declared props `required`), wraps a
 * previously-optional prop as `anyOf:[T,{type:"null"}]` so the model can signal
 * omission, rewrites `oneOf`→`anyOf`, and strips non-structural keywords. The
 * WeakMap memoizes shared subgraphs; the Set is the cycle guard (a node already
 * on the active path returns `{}` rather than recursing forever).
 */
function normalizeOpenAINode(
  value: unknown,
  cache: WeakMap<JsonObject, JsonObject>,
  onPath: Set<JsonObject>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeOpenAINode(entry, cache, onPath));
  }
  if (!isJsonObject(value)) return value;

  const cached = cache.get(value);
  if (cached) return cached;
  if (onPath.has(value)) return {};
  onPath.add(value);

  const result: JsonObject = {};
  cache.set(value, result);

  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (OPENAI_NON_STRUCTURAL_FIELDS.has(key)) continue;
    // oneOf → anyOf (OpenAI rejects oneOf in tool schemas); merge into a sibling
    // anyOf if one exists so a single union survives on the wire.
    if (key === 'oneOf' && Array.isArray(entry)) {
      const rewritten = entry.map((v) => normalizeOpenAINode(v, cache, onPath));
      const existing = result.anyOf;
      result.anyOf = Array.isArray(existing) ? [...existing, ...rewritten] : rewritten;
      continue;
    }
    if (key === 'anyOf' && Array.isArray(entry)) {
      const rewritten = entry.map((v) => normalizeOpenAINode(v, cache, onPath));
      const existing = result.anyOf;
      result.anyOf = Array.isArray(existing) ? [...rewritten, ...existing] : rewritten;
      continue;
    }
    if (key === 'properties' && isJsonObject(entry)) {
      const props: JsonObject = {};
      for (const name of Object.keys(entry)) {
        props[name] = normalizeOpenAINode(entry[name], cache, onPath);
      }
      result.properties = props;
      continue;
    }
    result[key] = normalizeOpenAINode(entry, cache, onPath);
  }

  if (result.type === 'object') {
    result.additionalProperties = false;
    const props = isJsonObject(result.properties) ? result.properties : {};
    const originalRequired = new Set(
      Array.isArray(value.required)
        ? value.required.filter((r): r is string => typeof r === 'string')
        : [],
    );
    const closedProps: JsonObject = {};
    for (const name of Object.keys(props)) {
      const propSchema = props[name];
      if (originalRequired.has(name)) {
        closedProps[name] = propSchema;
        continue;
      }
      // Optional prop → nullable wrapper so strict mode accepts it. Don't
      // double-wrap an already-nullable union; hoist a description to the wrapper.
      if (
        isJsonObject(propSchema) &&
        Array.isArray(propSchema.anyOf) &&
        propSchema.anyOf.some((v) => isJsonObject(v) && v.type === 'null')
      ) {
        closedProps[name] = propSchema;
        continue;
      }
      if (isJsonObject(propSchema) && typeof propSchema.description === 'string') {
        const { description, ...withoutDescription } = propSchema;
        closedProps[name] = { anyOf: [withoutDescription, { type: 'null' }], description };
        continue;
      }
      closedProps[name] = { anyOf: [propSchema, { type: 'null' }] };
    }
    result.properties = closedProps;
    result.required = Object.keys(closedProps);
  }

  onPath.delete(value);
  return result;
}

/**
 * Normalize a tool schema for OpenAI strict-shape providers. Backward compatible
 * (does not set `tool.strict`); tightens the documented shape only. Fail-open.
 */
export function normalizeSchemaForOpenAIStrict(schema: object): object {
  try {
    const out = normalizeOpenAINode(schema, new WeakMap(), new Set());
    return isJsonObject(out) ? out : schema;
  } catch (err) {
    console.warn(`[schema-normalize] openai-strict normalizer failed, using original schema: ${String(err)}`);
    return schema;
  }
}

/**
 * Responses-API compat normalizer core (SECOND-PASS item 5). The xAI and
 * openai-codex providers route through the OpenAI **Responses** API, which 400s
 * on `oneOf` in a tool's JSON schema — but, unlike {@link normalizeOpenAINode},
 * does NOT require full strict mode. So this pass rewrites `oneOf`→`anyOf`
 * recursively and otherwise leaves the schema VERBATIM (no
 * `additionalProperties:false`, no required-all, no keyword stripping), tightening
 * nothing the model relies on. The Set is the cycle guard (a node already on the
 * active path returns `{}` rather than recursing forever — fail-safe).
 */
function rewriteOneOfNode(value: unknown, onPath: Set<JsonObject>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteOneOfNode(entry, onPath));
  }
  if (!isJsonObject(value)) return value;
  if (onPath.has(value)) return {};
  onPath.add(value);

  const result: JsonObject = {};
  for (const key of Object.keys(value)) {
    const entry = value[key];
    // oneOf → anyOf: merge into a sibling anyOf when one exists so a single union
    // survives on the wire (matches the OpenAI-strict normalizer's merge order).
    if (key === 'oneOf' && Array.isArray(entry)) {
      const rewritten = entry.map((v) => rewriteOneOfNode(v, onPath));
      const existing = result.anyOf;
      result.anyOf = Array.isArray(existing) ? [...existing, ...rewritten] : rewritten;
      continue;
    }
    if (key === 'anyOf' && Array.isArray(entry)) {
      const rewritten = entry.map((v) => rewriteOneOfNode(v, onPath));
      const existing = result.anyOf;
      result.anyOf = Array.isArray(existing) ? [...rewritten, ...existing] : rewritten;
      continue;
    }
    result[key] = rewriteOneOfNode(entry, onPath);
  }

  onPath.delete(value);
  return result;
}

/**
 * Normalize a tool schema for OpenAI Responses-API compat providers (xai /
 * openai-codex): rewrite `oneOf`→`anyOf` only, WITHOUT forcing strict mode.
 * Fail-open — a normalizer error returns the original schema.
 */
export function normalizeSchemaForResponsesCompat(schema: object): object {
  try {
    const out = rewriteOneOfNode(schema, new Set());
    return isJsonObject(out) ? out : schema;
  } catch (err) {
    console.warn(`[schema-normalize] responses-compat normalizer failed, using original schema: ${String(err)}`);
    return schema;
  }
}

/**
 * Top-level dispatch: pick the per-provider normalizer for a tool's input schema.
 *
 * CONSERVATIVE first slice (the doc's Step 4):
 *  - google / google-caa / google-vertex → Google (same SDK proto)
 *  - openai → OpenAI-strict shape
 *  - xai / openai-codex → Responses-API compat (oneOf→anyOf only, item 5)
 *  - everything else (anthropic, mistral, the openai-compatible API-key
 *    gateways groq/deepseek/together/fireworks/cerebras/moonshot/…, github-copilot,
 *    ollama, custom:* endpoints) → pass-through identity. The remaining
 *    openai-compatible compat providers are a deliberate FOLLOW-UP: they accept the
 *    verbatim schema today, and normalizing them needs per-vendor validation we
 *    haven't done.
 *
 * An `undefined` provider (subagent-runtime / harness call sites that don't thread
 * one through) is pass-through — never breaks an existing caller.
 */
export function normalizeToolSchema(provider: ProviderId | undefined, schema: object): object {
  switch (provider) {
    case 'google':
    case 'google-caa':
    case 'google-vertex':
      return normalizeSchemaForGoogle(schema);
    case 'openai':
      return normalizeSchemaForOpenAIStrict(schema);
    case 'xai':
    case 'openai-codex':
      return normalizeSchemaForResponsesCompat(schema);
    default:
      return schema;
  }
}
