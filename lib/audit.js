/**
 * Minimal JSONL audit trail. Audit failures must never change a safety
 * decision, so every write is contained and only logged.
 */
import fs from 'node:fs'
import path from 'node:path'

const SECRET_PATTERNS = [
  /(?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*["']?[^\s"'`,;]+/gi,
  /Authorization:\s*Bearer\s+\S+/gi,
]

function redact(value) {
  if (typeof value !== 'string') return value
  let text = value
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]')
  return text
}

function deepRedact(value) {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(deepRedact)
  if (value !== null && typeof value === 'object') {
    const result = {}
    for (const [key, item] of Object.entries(value)) result[key] = deepRedact(item)
    return result
  }
  return value
}

/**
 * Create the audit sink.
 * @param {{config: object, homeDir: string, logger?: object}} options
 * @returns {{record: (event: object) => void, root: string}}
 */
export function createAudit({ config, homeDir, logger }) {
  const enabled = config.audit?.enabled !== false
  const root = path.resolve(config.audit?.root ?? path.join(homeDir, 'cmd-guard'))
  let ready = false

  function ensure() {
    if (ready) return
    fs.mkdirSync(root, { recursive: true })
    ready = true
  }

  function record(event) {
    if (!enabled) return
    try {
      ensure()
      const day = new Date().toISOString().slice(0, 10)
      const line = JSON.stringify(deepRedact({ time: new Date().toISOString(), ...event }))
      fs.appendFileSync(path.join(root, `audit-${day}.jsonl`), `${line}\n`, 'utf8')
    } catch (error) {
      logger?.warn?.(`cmd-guard: audit write failed: ${String(error?.message ?? error)}`)
    }
  }

  return { record, root }
}
