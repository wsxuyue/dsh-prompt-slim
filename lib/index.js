/**
 * Prompt-slim: shrink the tool-definition block that is re-sent with every
 * model request.
 *
 * The harness assembles every visible tool schema (name, description, full
 * JSON Schema) before each step and ships it to the provider verbatim. Long,
 * prose-heavy descriptions dominate that block while contributing little at
 * call time, so this plugin rewrites the assembled schemas once per step:
 * structure stays byte-identical, prose is cut to its leading sentences.
 *
 * The original text is never lost: `prompt_slim_help` reads the live registry
 * and returns a tool's full definition on demand.
 *
 * @module @deepseek-harness/dsh-prompt-slim
 */

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { firstSentences, slimAll, wireBytes } from './compress.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'prompt-slim'

/** Registers into the tool registry and rewrites the assembled prompt. */
export const inject = ['tools', 'systemPrompt']

/** Name of the on-demand expansion tool. */
const HELP_TOOL = 'prompt_slim_help'

/** Largest number of tool definitions one help call may expand. */
const MAX_HELP_NAMES = 6

/** Largest help payload in characters, so one call cannot flood the context. */
const MAX_HELP_CHARS = 12_000

/** Reversible switch plus the two length caps that drive the compression. */
export const Config = Schema.object({
  mode: Schema.string().default('terse').description('terse compresses the assembled tool block; off disables the plugin.'),
  toolDescriptionMax: Schema.number().step(1).min(0).max(4000).default(160)
    .description('Character cap for each tool description; 0 drops descriptions entirely.'),
  parameterDescriptionMax: Schema.number().step(1).min(0).max(2000).default(40)
    .description('Character cap for each parameter description.'),
  keepTools: Schema.array(Schema.string()).default([])
    .description('Tool names that must be sent verbatim.'),
  overrides: Schema.dict(Schema.number().step(1).min(0).max(4000)).default({ workflow: 1200 })
    .description('Per-tool description caps, overriding toolDescriptionMax.'),
  minTools: Schema.number().step(1).min(1).max(500).default(6)
    .description('Skip assemblies with fewer visible tools than this.'),
  helpTool: Schema.boolean().default(true)
    .description('Register prompt_slim_help for on-demand full definitions.'),
  logSavings: Schema.boolean().default(true)
    .description('Log the achieved saving to the host log whenever it changes.'),
})

/**
 * Read one config field whether the loader hands out a live accessor or a
 * plain value.
 * @param value - accessor, plain value, or undefined.
 * @param fallback - value to use when the field is absent.
 * @returns the resolved value.
 */
function read(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value.get === 'function') {
    const live = value.get()
    return live === undefined || live === null ? fallback : live
  }
  return value
}

/**
 * Clamp a numeric config field into a usable range.
 * @param value - candidate number.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the clamped integer.
 */
function clampInt(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * Resolve the raw config into the shape the compressor consumes.
 * @param config - the loader-supplied config section.
 * @returns resolved options.
 */
function resolveOptions(config) {
  const overrides = {}
  const rawOverrides = read(config.overrides, {}) ?? {}
  for (const [tool, cap] of Object.entries(rawOverrides)) {
    const n = Number(cap)
    if (Number.isFinite(n) && n >= 0) overrides[tool] = Math.round(n)
  }
  const keep = read(config.keepTools, []) ?? []
  return {
    mode: String(read(config.mode, 'terse')),
    toolDescriptionMax: clampInt(read(config.toolDescriptionMax, 160), 0, 4000),
    parameterDescriptionMax: clampInt(read(config.parameterDescriptionMax, 40), 0, 2000),
    preserved: new Set([...keep, HELP_TOOL]),
    overrides,
    minTools: clampInt(read(config.minTools, 6), 1, 500),
    helpTool: read(config.helpTool, true) === true,
    logSavings: read(config.logSavings, true) === true,
  }
}

/**
 * Compress one `description` for the report line.
 * @param tools - compressed tool schemas.
 * @returns a short sample of what the model now sees.
 */
function sampleOneLine(tools) {
  const first = tools[0]
  if (first === undefined) return ''
  return `${first.name}: ${firstSentences(first.description, 60)}`
}

/**
 * Install the assembly rewrite and the expansion tool.
 * @param ctx - the plugin context.
 * @param config - the resolved config section.
 */
export function apply(ctx, config) {
  /** Latest assembly measurement, used by the report. */
  const stats = { tools: 0, before: 0, after: 0, at: 0, assemblies: 0 }
  /** Last logged saving percentage, so the log does not repeat per step. */
  let loggedPercent = null

  const report = () => {
    if (stats.assemblies === 0) {
      return `prompt-slim: no assembly measured yet (mode=${resolveOptions(config).mode}).`
    }
    const before = Math.round(stats.before / 3.2)
    const after = Math.round(stats.after / 3.2)
    const percent = stats.before === 0 ? 0 : Math.round((1 - stats.after / stats.before) * 1000) / 10
    return [
      `prompt-slim: ${stats.tools} tools, ${stats.assemblies} assemblies.`,
      `tool block ${stats.before} -> ${stats.after} bytes (~${before} -> ~${after} tokens, ${percent}% smaller).`,
      `The schemas above are shortened; call ${HELP_TOOL} with names to get any full definition.`,
    ].join('\n')
  }

  if (resolveOptions(config).helpTool) {
    ctx.tools.register(defineTool({
      name: HELP_TOOL,
      description: 'Full definition of tools whose prompt-slim descriptions were shortened: pass names, or no arguments for the token report.',
      parameters: {
        names: {
          type: 'array',
          description: 'Tool names to expand, up to 6. Omit to read the compression report.',
          items: { type: 'string' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args, exec) => {
        const names = Array.isArray(args?.names) ? args.names.filter((n) => typeof n === 'string') : []
        if (names.length === 0) return { text: report() }
        const requested = names.slice(0, MAX_HELP_NAMES)
        const known = new Map(
          (typeof ctx.tools.schemas === 'function' ? ctx.tools.schemas(exec.agent) : [])
            .map((schema) => [schema.name, schema]),
        )
        const blocks = []
        let used = 0
        for (const requestedName of requested) {
          const schema = known.get(requestedName)
          if (schema === undefined) {
            blocks.push(`## ${requestedName}\n(no tool by this name; names are exact and case-sensitive)`)
            continue
          }
          const block = `## ${schema.name}\n${schema.description}\nparameters: ${JSON.stringify(schema.parameters)}`
          if (used + block.length > MAX_HELP_CHARS) break
          used += block.length
          blocks.push(block)
        }
        const overflow = requested.length > blocks.length
        return {
          text: blocks.join('\n\n') + (overflow ? '\n\n(truncated: ask for fewer names)' : ''),
        }
      },
    }))
  }

  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const result = await next()
    // A prompt rewrite must never be the reason a step fails: any internal
    // error falls back to the untouched assembly.
    try {
      return compressAssembly(result)
    } catch (error) {
      ctx.logger.warn('prompt-slim: left the assembly untouched after an error: %o', error)
      return result
    }
  })

  /**
   * Rewrite the assembled tool block in place.
   * @param result - the assembled prompt.
   * @returns the same prompt with compressed tools, or the input unchanged.
   */
  function compressAssembly(result) {
    const options = resolveOptions(config)
    if (options.mode !== 'terse') return result
    const tools = Array.isArray(result?.tools) ? result.tools : []
    if (tools.length < options.minTools) return result
    const before = wireBytes(tools)
    const compressed = slimAll(tools, options, options.preserved, options.overrides)
    const after = wireBytes(compressed)
    if (before === 0 || after >= before) return result
    result.tools = compressed
    stats.tools = tools.length
    stats.before = before
    stats.after = after
    stats.at = Date.now()
    stats.assemblies += 1
    if (options.logSavings) {
      const percent = Math.round((1 - after / before) * 1000) / 10
      if (loggedPercent === null || Math.abs(percent - loggedPercent) >= 0.5) {
        loggedPercent = percent
        ctx.logger.info(
          'prompt-slim: %d tools, tool block %d -> %d bytes (%s%% smaller); %s',
          tools.length,
          before,
          after,
          String(percent),
          sampleOneLine(compressed),
        )
      }
    }
    return result
  }
}
