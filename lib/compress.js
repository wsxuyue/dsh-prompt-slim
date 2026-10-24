/**
 * Prompt-slim schema compressor.
 *
 * Pure functions only: the same input always yields the same output, so the
 * model-facing tool block stays byte-stable between steps (a changing tool
 * block would invalidate the upstream prompt cache every round).
 *
 * What is preserved: tool names, parameter names, types, enums, consts,
 * required lists, items, and composition keywords. What shrinks: prose
 * (`description`), which the model does not need spelled out twice.
 *
 * @module @deepseek-harness/dsh-prompt-slim/compress
 */

/** Sentence terminators, including CJK full stops and semicolons. */
const TERMINATOR = /[。！？；;!?]|\.(?=\s|$)/g;

/** Keys that can change how a model fills arguments, so they must survive. */
const STRUCTURAL_KEYS = new Set([
  'type',
  'enum',
  'const',
  'required',
  'items',
  'properties',
  'oneOf',
  'anyOf',
  'allOf',
  'additionalProperties',
  '$ref',
  'default',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
]);

/**
 * Collapse every whitespace run to one space.
 *
 * Pretty-printed schemas spend tokens on indentation the model never reads;
 * whitespace is also the cheapest thing to normalise without losing meaning.
 * @param text - raw text.
 * @returns the text with single spaces.
 */
export function squeeze(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Keep the leading sentences that fit in `max` characters.
 *
 * Cutting on a sentence boundary keeps the first sentence - the one that says
 * what the tool does - intact, and only drops trailing caveats and examples.
 * When not even one sentence fits, fall back to a clause boundary mark so the
 * result never ends mid-word.
 * @param text - the description to shorten.
 * @param max - target maximum length in characters.
 * @returns the shortened description.
 */
export function firstSentences(text, max) {
  const t = squeeze(text);
  if (t.length <= max) return t;
  let cut = -1;
  TERMINATOR.lastIndex = 0;
  for (;;) {
    const match = TERMINATOR.exec(t);
    if (match === null) break;
    const end = match.index + match[0].length;
    if (end > max) break;
    cut = end;
  }
  if (cut > max * 0.4) return t.slice(0, cut).trim();
  const window = t.slice(0, max);
  const clause = Math.max(
    window.lastIndexOf('，'),
    window.lastIndexOf('、'),
    window.lastIndexOf('；'),
    window.lastIndexOf(', '),
    window.lastIndexOf('; '),
    window.lastIndexOf(' '),
  );
  return `${(clause > max * 0.5 ? window.slice(0, clause) : window).trim()}…`;
}

/**
 * Shorten one `description` node according to its depth in the schema tree.
 * @param text - the description.
 * @param opts - resolved compression options.
 * @param depth - 0 for a definition root, 1 for a parameter, 2+ for nested.
 * @returns the shortened description.
 */
function capDescription(text, opts, depth) {
  const cap = depth <= 1
    ? opts.parameterDescriptionMax
    : Math.max(24, Math.round(opts.parameterDescriptionMax * 0.6));
  return firstSentences(text, cap);
}

/**
 * Rebuild a JSON Schema tree keeping only keys that change model behaviour.
 *
 * Unknown/annotation-only keys (`title`, `examples`, `$comment`, `deprecated`,
 * vendor extensions) are dropped; `description` is kept but shortened, because
 * a model reads it while filling arguments and losing it entirely changes
 * behaviour.
 * @param node - the schema node to rebuild.
 * @param opts - resolved compression options.
 * @param depth - current depth in the tree.
 * @returns a new schema node.
 */
export function slimSchema(node, opts, depth = 0) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((entry) => slimSchema(entry, opts, depth));
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description') continue;
    if (!STRUCTURAL_KEYS.has(key)) continue;
    if (key === 'properties') {
      const properties = {};
      for (const [name, sub] of Object.entries(value ?? {})) {
        properties[name] = slimSchema(sub, opts, depth + 1);
      }
      out.properties = properties;
      continue;
    }
    if (key === 'items' || key === 'additionalProperties') {
      out[key] = value !== null && typeof value === 'object' ? slimSchema(value, opts, depth + 1) : value;
      continue;
    }
    if (key === 'oneOf' || key === 'anyOf' || key === 'allOf') {
      out[key] = (Array.isArray(value) ? value : []).map((sub) => slimSchema(sub, opts, depth + 1));
      continue;
    }
    out[key] = value;
  }
  if (typeof node.description === 'string' && node.description.length > 0) {
    out.description = capDescription(node.description, opts, depth);
  }
  return out;
}

/**
 * Compress one tool schema.
 * @param tool - the model-facing schema.
 * @param opts - resolved compression options.
 * @param preserved - tool names that must pass through untouched.
 * @param overrides - per-tool description caps.
 * @returns the compressed schema.
 */
export function slimTool(tool, opts, preserved = new Set(), overrides = {}) {
  if (preserved.has(tool.name)) return tool;
  const cap = overrides[tool.name] ?? opts.toolDescriptionMax;
  const description = typeof tool.description === 'string' && tool.description.length > 0
    ? firstSentences(tool.description, cap)
    : '';
  const slim = {
    name: tool.name,
    description,
    parameters: slimSchema(tool.parameters ?? { type: 'object', properties: {} }, opts),
  };
  if (tool.deferLoading === true) slim.deferLoading = true;
  return slim;
}

/**
 * Compress a whole tool list.
 * @param tools - the assembled tool schemas.
 * @param opts - resolved compression options.
 * @param preserved - tool names that must pass through untouched.
 * @param overrides - per-tool description caps.
 * @returns the compressed schemas, in the original order.
 */
export function slimAll(tools, opts, preserved = new Set(), overrides = {}) {
  return tools.map((tool) => slimTool(tool, opts, preserved, overrides));
}

/** Byte length of the wire form, which is what the provider actually bills. */
export function wireBytes(tools) {
  return JSON.stringify(tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))).length;
}

/**
 * Rough token estimate for mixed Chinese/English text.
 *
 * CJK characters cost about one token each and Latin text about one token per
 * 3.6 characters, so this stays useful for both vocabularies without pulling in
 * a tokenizer.
 * @param text - the text to estimate.
 * @returns the estimated token count.
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0;
  for (const ch of s) if (ch.charCodeAt(0) > 0x2e80) cjk += 1;
  return Math.round(cjk / 1.6 + (s.length - cjk) / 3.6);
}
