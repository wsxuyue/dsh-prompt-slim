/**
 * Offline check for the prompt-slim compressor.
 *
 * Compresses a captured tool list and asserts that nothing that changes a
 * model's arguments was lost, then prints the achieved saving.
 *
 * Usage: node test/measure.mjs <tools.json>
 * The input file is either `{ "tools": [...] }` or a raw array of schemas.
 */

import { readFileSync } from 'node:fs'
import { slimAll, wireBytes, estimateTokens, firstSentences } from '../lib/compress.js'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node test/measure.mjs <tools.json>')
  process.exit(2)
}

const raw = JSON.parse(readFileSync(file, 'utf8'))
const tools = Array.isArray(raw) ? raw : raw.tools
if (!Array.isArray(tools) || tools.length === 0) {
  console.error('no tools found in input')
  process.exit(2)
}

const options = {
  toolDescriptionMax: 160,
  parameterDescriptionMax: 40,
  preserved: new Set(['prompt_slim_help']),
  overrides: { workflow: 1200 },
  minTools: 6,
}

const slim = slimAll(tools, options, options.preserved, options.overrides)
const before = wireBytes(tools)
const after = wireBytes(slim)

/** Collect every schema path that carries a `type`, for structural comparison. */
function shapeOf(schemas) {
  const out = []
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`))
      return
    }
    if (typeof node.type === 'string') out.push(`${path}:${node.type}`)
    if (Array.isArray(node.enum)) out.push(`${path}:enum(${node.enum.join('|')})`)
    if (Array.isArray(node.required)) out.push(`${path}:required(${[...node.required].sort().join(',')})`)
    for (const [key, value] of Object.entries(node.properties ?? {})) walk(value, `${path}.${key}`)
    if (node.items !== undefined) walk(node.items, `${path}[]`)
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      ;(node[key] ?? []).forEach((entry, index) => walk(entry, `${path}.${key}[${index}]`))
    }
  }
  for (const schema of schemas) walk(schema.parameters, schema.name)
  return out.sort()
}

const beforeShape = shapeOf(tools)
const afterShape = shapeOf(slim)
const shapeLost = beforeShape.filter((entry, index) => entry !== afterShape[index])

const problems = []
if (tools.length !== slim.length) problems.push(`tool count ${tools.length} -> ${slim.length}`)
for (const [index, tool] of tools.entries()) {
  if (tool.name !== slim[index].name) problems.push(`tool ${index}: ${tool.name} -> ${slim[index].name}`)
}
if (shapeLost.length > 0) problems.push(`lost ${shapeLost.length} structural facts, e.g. ${shapeLost.slice(0, 5).join(' ')}`)
const again = JSON.stringify(slimAll(tools, options, options.preserved, options.overrides))
if (again !== JSON.stringify(slim)) problems.push('compression is not deterministic')

for (const tool of slim) {
  if (tool.description.length > options.toolDescriptionMax) problems.push(`${tool.name}: description over cap`)
}

const percent = ((1 - after / before) * 100).toFixed(1)
console.log(`tools            ${tools.length}`)
console.log(`bytes            ${before} -> ${after}  (-${percent}%)`)
console.log(`tokens (approx)  ${estimateTokens('x'.repeat(before))} -> ${estimateTokens('x'.repeat(after))}`)
const widest = [...tools]
  .map((tool) => ({ name: tool.name, size: wireBytes([tool]), slim: wireBytes([slim.find((s) => s.name === tool.name)]) }))
  .sort((a, b) => b.size - a.size)
  .slice(0, 5)
console.log('largest tools    ' + widest.map((w) => `${w.name} ${w.size}->${w.slim}`).join(', '))
console.log('sample           ' + firstSentences(slim[0].description, 160))
if (problems.length > 0) {
  console.error('\nFAILED:\n  ' + problems.join('\n  '))
  process.exit(1)
}
console.log('\nOK: names, types, enums and required lists all survive.')
