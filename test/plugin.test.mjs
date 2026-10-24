/**
 * Smoke test for the prompt-slim plugin wiring.
 *
 * Runs `apply()` against a stub context so registration, the assembly rewrite
 * and the expansion tool are exercised without a live host.
 *
 * Usage: node test/plugin.test.mjs [tools.json]
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply, Config } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const file = process.argv[2] ?? join(here, 'tools-captured.json')
const tools = JSON.parse(readFileSync(file, 'utf8'))

const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}

/** Stub config whose fields behave like the loader's accessors. */
const config = {
  mode: { get: () => 'terse' },
  toolDescriptionMax: { get: () => 160 },
  parameterDescriptionMax: { get: () => 40 },
  keepTools: { get: () => [] },
  overrides: { get: () => ({ workflow: 1200 }) },
  minTools: { get: () => 6 },
  helpTool: { get: () => true },
  logSavings: { get: () => false },
}

const logs = []
let handler
let definition
const ctx = {
  tools: {
    register(def) {
      definition = def
      return () => {}
    },
    schemas() {
      return tools
    },
  },
  on(event, callback) {
    check(event === 'system-prompt/assemble', `unexpected event ${event}`)
    handler = callback
    return () => {}
  },
  logger: {
    info: (...args) => logs.push(args.join(' ')),
    warn: (...args) => logs.push(args.join(' ')),
  },
}

apply(ctx, config)

check(typeof handler === 'function', 'no assemble listener registered')
check(definition?.name === 'prompt_slim_help', `help tool name is ${definition?.name}`)
check(definition?.parameters?.type === 'object', 'help tool parameters are not an object schema')

const assembly = { sections: [], contexts: [], tools: [...tools], variables: {} }
const result = await handler(assembly, { agent: {} }, async () => assembly)

check(result === assembly, 'listener did not return the same assembly object')
check(result.tools.length === tools.length, 'tool count changed')
check(JSON.stringify(result.tools) !== JSON.stringify(tools), 'tools were not compressed')

const bytesBefore = JSON.stringify(tools).length
const bytesAfter = JSON.stringify(result.tools).length
check(bytesAfter < bytesBefore, `no byte saving: ${bytesBefore} -> ${bytesAfter}`)

// Running the rewrite again over its own output must be a fixed point.
const second = await handler(result, { agent: {} }, async () => result)
check(
  JSON.stringify(second.tools) === JSON.stringify(result.tools),
  'compression is not idempotent (a second pass changed the schemas)',
)

// The expansion tool must return full text from the registry.
const expanded = await definition.execute({ names: ['workflow'] }, { agent: {} })
check(typeof expanded?.text === 'string' && expanded.text.includes('## workflow'), 'expansion returned no definition')
check(
  expanded.text.length > 500,
  `expansion looks truncated: ${expanded.text.length} chars`,
)

const report = await definition.execute({}, { agent: {} })
check(typeof report?.text === 'string' && report.text.includes('prompt-slim:'), 'report text missing')

const unknown = await definition.execute({ names: ['no_such_tool'] }, { agent: {} })
check(unknown.text.includes('no tool by this name'), 'unknown tool name not reported')

const schema = Config.toJSON?.()
check(schema !== undefined, 'Config has no toJSON')

if (failures.length > 0) {
  console.error('FAILED:\n  ' + failures.join('\n  '))
  process.exit(1)
}
console.log(`OK: ${tools.length} tools, ${bytesBefore} -> ${bytesAfter} bytes, expansion + report work.`)
