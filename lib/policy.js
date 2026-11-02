/**
 * Deterministic command policy for the Cmd Guard.
 *
 * Design goal: catch destructive command *families* before any tool body runs.
 * This module never executes a command; it only tokenizes and classifies the
 * text that is about to be passed to a shell tool.
 */

const DELETE_COMMANDS = new Set([
  'rm', 'rmdir', 'unlink', 'del', 'erase', 'rd', 'remove-item', 'ri', 'shred',
])

const WINDOWS_DELETE_API = [
  /\[System\.IO\.(?:File|Directory)\]::Delete\s*\(/i,
  /\bRemove-Item\b/i,
  /\bremove-item\b/i,
]

const SCRIPT_DELETE_PATTERNS = [
  /\brm\s+(?:-[A-Za-z-]+\s+)*/,
  /\brmdir\b/i,
  /\bRemove-Item\b/i,
  /\bdel\s+/i,
  /\berase\s+/i,
  /\bshutil\.rmtree\s*\(/i,
  /\bos\.remove\s*\(/i,
  /\bos\.unlink\s*\(/i,
  /\b(?:fs\.)?(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\s*\(/i,
  /\brimraf\s*\(/i,
  /\bfind\b[^\n]*\s-delete\b/i,
  /\bgit\s+clean\b/i,
  /\bdocker\s+(?:rm|rmi|volume\s+rm|system\s+prune|container\s+prune|image\s+prune)\b/i,
]

const SAFE_PREFIXES = new Set([
  'echo', 'write-output', 'write-host', 'printf', 'cat', 'type', 'get-content',
  'git', 'npm', 'pnpm', 'yarn', 'node', 'python', 'pwsh', 'powershell', 'bash',
  'sh', 'zsh', 'cmd', 'docker', 'ssh', 'scp', 'rsync', 'sftp', 'make',
])

const SAFE_ECHO = new Set(['echo', 'write-output', 'write-host', 'printf'])

function asString(value) {
  return typeof value === 'string' ? value : ''
}

function commandBase(token) {
  const raw = token.replace(/^["'`]+|["'`]+$/g, '')
  const base = raw.includes('\\') || raw.includes('/')
    ? raw.slice(Math.max(raw.lastIndexOf('\\'), raw.lastIndexOf('/')) + 1)
    : raw
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/i, '')
}

/**
 * Split a shell command into top-level segments on `;`, `&&`, `||`, `|` and
 * newlines outside quotes. This is deliberately conservative; unsupported
 * quoting falls back to the whole string as one segment.
 */
export function splitCommandSegments(command) {
  const text = asString(command)
  const segments = []
  let current = ''
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      current += ch
      if (ch === quote && text[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '\r') {
      if (current.trim() !== '') segments.push(current)
      current = ''
      continue
    }
    if (ch === '&' && text[i + 1] === '&') {
      if (current.trim() !== '') segments.push(current)
      current = ''
      i += 1
      continue
    }
    if (ch === '|' && text[i + 1] === '|') {
      if (current.trim() !== '') segments.push(current)
      current = ''
      i += 1
      continue
    }
    if (ch === '|') {
      if (current.trim() !== '') segments.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim() !== '') segments.push(current)
  return segments
}

/**
 * Tokenize one segment while preserving quoted arguments as one token.
 * This is a classifier input, not a shell parser; unsupported syntax should
 * end up as a conservative review decision.
 */
export function tokenizeCommand(segment) {
  const text = asString(segment)
  const tokens = []
  let current = ''
  let quote = null
  for (const ch of text) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current !== '') tokens.push(current)
  return tokens
}

function hasDeleteToken(tokens) {
  return tokens.some((token) => DELETE_COMMANDS.has(commandBase(token)))
}

function skipGenericDeleteCheck(base, tokens) {
  if (['docker', 'ssh', 'scp', 'sftp', 'rsync'].includes(base)) return true
  return false
}

function isOpaqueExpression(text) {
  const value = asString(text).trim()
  return value === ''
    || /^\$/.test(value)
    || /^%[^%]+%$/.test(value)
    || /^`/.test(value)
    || /\$\(|`[^`]*`/.test(value)
}

function hasWindowsDeleteApi(text) {
  return WINDOWS_DELETE_API.some((pattern) => pattern.test(text))
}

function looksLikeScriptInvocation(tokens) {
  if (tokens.length === 0) return false
  const base = commandBase(tokens[0])
  if (['python', 'python3', 'py', 'node', 'deno', 'ruby', 'perl', 'php'].includes(base)) {
    return tokens.some((token) => /^-{1,2}(?:c|e|m)$/i.test(token)) || tokens.length > 1
  }
  if (['pwsh', 'powershell'].includes(base)) {
    return tokens.some((token) => /^-(?:f|file)$/i.test(token)) || tokens.length > 1
  }
  if (['bash', 'sh', 'zsh'].includes(base)) {
    return tokens.length > 1 || tokens.some((token) => /^-[A-Za-z]*c[A-Za-z]*$/i.test(token))
  }
  if (base === 'cmd') {
    return tokens.some((token) => /^\/[ck]/i.test(token))
  }
  if (['npm', 'pnpm', 'yarn'].includes(base)) {
    return tokens.some((token) => /^(?:run|run-script)$/i.test(token))
  }
  if (base === 'make') return true
  return false
}

function findScriptPath(tokens, cwd) {
  const base = commandBase(tokens[0] ?? '')
  const rest = tokens.slice(1)
  let candidate
  if (['python', 'python3', 'py', 'node', 'deno', 'ruby', 'perl', 'php'].includes(base)) {
    const inlineFlag = rest.findIndex((token) => /^-{1,2}(?:c|e|m)$/i.test(token))
    if (inlineFlag >= 0) {
      const inline = rest[inlineFlag + 1]
      return inline === undefined ? undefined : { inline: true, text: inline }
    }
    candidate = rest.find((token) => !token.startsWith('-'))
  } else if (['pwsh', 'powershell'].includes(base)) {
    const fileFlag = rest.findIndex((token) => /^-(?:f|file)$/i.test(token))
    if (fileFlag >= 0) candidate = rest[fileFlag + 1]
    else {
      const commandFlag = rest.findIndex((token) => /^-(?:c|command)$/i.test(token))
      if (commandFlag >= 0) return { inline: true, text: rest.slice(commandFlag + 1).join(' ') }
    }
  } else if (['bash', 'sh', 'zsh'].includes(base)) {
    const cFlag = rest.findIndex((token) => /^-[A-Za-z]*c[A-Za-z]*$/i.test(token))
    if (cFlag >= 0) return { inline: true, text: rest.slice(cFlag + 1).join(' ') }
    candidate = rest.find((token) => !token.startsWith('-'))
  } else if (base === 'cmd') {
    const cIndex = rest.findIndex((token) => /^\/c$/i.test(token))
    if (cIndex >= 0) {
      const tail = rest.slice(cIndex + 1)
      if (tail.length === 1 && /\.(?:bat|cmd)$/i.test(tail[0])) return { path: tail[0] }
      return { inline: true, text: tail.join(' ') }
    }
  }
  if (candidate === undefined) return undefined
  return { path: candidate, cwd }
}

function readScriptIfAvailable(script, readScript) {
  if (script?.inline === true) return script.text
  if (script?.path === undefined || typeof readScript !== 'function') return undefined
  try {
    const text = readScript(script.path, script.cwd)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

function classifySsh(tokens) {
  const rest = tokens.slice(1)
  const facts = { host: undefined, remoteCommand: undefined, interactive: false, opaque: false }
  let i = 0
  const takesValue = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w'])
  while (i < rest.length) {
    const token = rest[i]
    if (token === '--') { i += 1; break }
    if (!token.startsWith('-')) break
    if (takesValue.has(token)) i += 2
    else i += 1
  }
  facts.host = rest[i]
  if (typeof facts.host === 'string') {
    const at = facts.host.lastIndexOf('@')
    if (at > 0) {
      facts.user = facts.host.slice(0, at)
      facts.host = facts.host.slice(at + 1)
    }
  }
  const remote = rest.slice(i + 1).join(' ').trim()
  if (remote === '') {
    facts.interactive = true
  } else {
    facts.remoteCommand = remote
    facts.opaque = /(?:^|\s)(?:bash|sh|zsh)\s+-s(?:\s|$)|(?:^|\s)-\s*(?:$|\|)|\b(?:base64|EncodedCommand)\b/i.test(remote)
  }
  return facts
}

function classifyDocker(tokens) {
  const rest = tokens.slice(1).map((token) => token.toLowerCase())
  const dynamic = tokens.some((token) => /\$\(|`/.test(token))
  const merged = rest.join(' ')
  const broad = /\b(?:system\s+prune|container\s+prune|image\s+prune|volume\s+prune|network\s+prune)\b/.test(merged)
  const destructive = /\b(?:rm|rmi|volume\s+rm)\b/.test(merged)
  if (!broad && !destructive) return undefined
  return {
    subcommand: merged,
    dynamic,
    broad,
    destructive,
    targets: rest.filter((token) => !token.startsWith('-') && !['rm', 'rmi', 'volume', 'system', 'prune', 'container', 'image', 'network'].includes(token)),
  }
}

/**
 * Classify a pending tool call.
 *
 * @param {object} input
 * @param {string} input.toolName
 * @param {object} input.arguments
 * @param {string} [input.cwd]
 * @param {(path: string, cwd?: string) => string|undefined} [input.readScript]
 * @returns {{decision: 'allow'|'deny'|'review', code: string, reason: string, facts: object}}
 */
export function classifyAction(input) {
  const toolName = asString(input.toolName)
  const args = input.arguments ?? {}
  const cwd = asString(input.cwd) || process.cwd()
  const facts = { tool: toolName, cwd, command: undefined }

  if (toolName === 'trash_move' || toolName === 'trash_restore') {
    return { decision: 'allow', code: 'TRASH_TOOL', reason: 'Trash tool is validated by its host implementation.', facts }
  }

  const text = toolName === 'terminal_send'
    ? asString(args.text)
    : asString(args.command)
  facts.command = text

  if (text.trim() === '') {
    return { decision: 'allow', code: 'EMPTY_COMMAND', reason: 'Empty command.', facts }
  }

  const segments = splitCommandSegments(text)
  const allTokens = segments.map((segment) => tokenizeCommand(segment))
  facts.segments = allTokens

  // Nested interpreters: inspect the inner literal command recursively.
  for (const tokens of allTokens) {
    if (tokens.length === 0) continue
    const base = commandBase(tokens[0])
    const nested = findScriptPath(tokens, cwd)
    if (nested?.inline === true) {
      if (isOpaqueExpression(nested.text)) {
        return { decision: 'deny', code: 'OPAQUE_NESTED_SHELL', reason: 'Nested shell command is not a literal string.', facts }
      }
      const inner = classifyAction({ toolName: 'bash', arguments: { command: nested.text }, cwd, readScript: input.readScript })
      if (inner.decision === 'deny') {
        return { ...inner, code: 'NESTED_DELETE', reason: inner.reason, facts: { ...facts, nested: inner.facts } }
      }
      if (inner.decision === 'review') {
        return { ...inner, code: 'NESTED_REVIEW', reason: inner.reason, facts: { ...facts, nested: inner.facts } }
      }
    }
    if (['pwsh', 'powershell', 'bash', 'sh', 'zsh', 'cmd'].includes(base) && nested?.inline !== true && nested?.path === undefined) {
      // A shell with no resolvable inline command (`-c` variable) is opaque.
      if (tokens.length > 1 && tokens.some((token) => /^-[A-Za-z]*c[A-Za-z]*$/i.test(token) || /^\/[ck]$/i.test(token))) {
        return { decision: 'deny', code: 'OPAQUE_NESTED_SHELL', reason: 'Nested shell command is not a literal string.', facts }
      }
    }
  }

  // Delete command detection. Check every segment's first command and, for
  // wrappers such as sudo/xargs/ForEach-Object, tokens inside the segment.
  for (const tokens of allTokens) {
    if (tokens.length === 0) continue
    const base = commandBase(tokens[0])
    if (SEE_ECHO_SAFE.has(base)) continue
    if (skipGenericDeleteCheck(base, tokens)) continue
    if (DELETE_COMMANDS.has(base) || hasDeleteToken(tokens) || hasWindowsDeleteApi(tokens.join(' '))) {
      return { decision: 'deny', code: 'SHELL_DELETE', reason: 'Shell deletion is disabled; use trash_move.', facts }
    }
    if (base === 'find' && tokens.some((token) => token === '-delete')) {
      return { decision: 'deny', code: 'FIND_DELETE', reason: 'find -delete is disabled; use trash_move.', facts }
    }
    if (base === 'git' && tokens.some((token) => token.toLowerCase() === 'clean')) {
      const dryRun = tokens.some((token) => token === '--dry-run' || (/^-[^-]/.test(token) && token.includes('n')))
      if (!dryRun) return { decision: 'review', code: 'GIT_CLEAN', reason: 'git clean deletes untracked files.', facts: { ...facts, gitClean: tokens } }
    }
  }

  // SSH / remote deletion: review with explicit host and remote command facts.
  for (const tokens of allTokens) {
    if (tokens.length === 0) continue
    const base = commandBase(tokens[0])
    if (base === 'ssh') {
      const ssh = classifySsh(tokens)
      facts.ssh = ssh
      if (ssh.opaque) {
        return { decision: 'deny', code: 'SSH_OPAQUE', reason: 'Opaque remote command is not allowed.', facts }
      }
      if (ssh.interactive) {
        return { decision: 'review', code: 'SSH_INTERACTIVE', reason: 'Interactive SSH requires review.', facts }
      }
      if (hasDestructiveText(ssh.remoteCommand ?? '')) {
        return { decision: 'review', code: 'SSH_REMOTE_DELETE', reason: 'Remote destructive command requires review.', facts }
      }
      return { decision: 'review', code: 'SSH_COMMAND', reason: 'SSH command requires review/audit.', facts }
    }
    if (base === 'rsync' && tokens.some((token) => token === '--delete' || token === '--delete-after')) {
      return { decision: 'review', code: 'RSYNC_DELETE', reason: 'rsync --delete requires review.', facts }
    }
    if (base === 'scp' || base === 'sftp') {
      return { decision: 'review', code: 'REMOTE_TRANSFER', reason: 'Remote transfer command requires review.', facts }
    }
  }

  // Docker deletions.
  for (const tokens of allTokens) {
    if (tokens.length === 0) continue
    if (commandBase(tokens[0]) !== 'docker') continue
    const docker = classifyDocker(tokens)
    if (docker === undefined) continue
    facts.docker = docker
    if (docker.broad || docker.dynamic || docker.targets.length === 0) {
      return { decision: 'deny', code: 'DOCKER_BROAD_DELETE', reason: 'Broad or dynamic docker deletion is disabled.', facts }
    }
    return { decision: 'review', code: 'DOCKER_DELETE', reason: 'Docker deletion requires review.', facts }
  }

  // Script execution: inspect literal script/inline code when available.
  for (const tokens of allTokens) {
    if (tokens.length === 0) continue
    if (!looksLikeScriptInvocation(tokens)) continue
    const script = findScriptPath(tokens, cwd)
    if (script === undefined) continue
    facts.script = script
    const content = readScriptIfAvailable(script, input.readScript)
    if (content === undefined) {
      return { decision: 'review', code: 'SCRIPT_UNREADABLE', reason: 'Script content is not available for inspection.', facts }
    }
    if (script.inline === true && isOpaqueExpression(content)) {
      return { decision: 'deny', code: 'SCRIPT_OPAQUE', reason: 'Opaque inline script is not allowed.', facts }
    }
    if (hasDestructiveText(content)) {
      return { decision: 'review', code: 'SCRIPT_DELETE', reason: 'Script contains deletion patterns and requires review.', facts }
    }
    return { decision: 'allow', code: 'SCRIPT_SCANNED', reason: 'Script contains no deletion patterns.', facts }
  }

  // Invoke-expression / dynamic invocation is opaque.
  for (const tokens of allTokens) {
    if (tokens.length === 0) continue
    const base = commandBase(tokens[0])
    if (['invoke-expression', 'iex', 'start-process'].includes(base) || base === '&') {
      return { decision: 'deny', code: 'DYNAMIC_INVOCATION', reason: 'Dynamic invocation is not allowed.', facts }
    }
  }

  return { decision: 'allow', code: 'SAFE_COMMAND', reason: 'No destructive command family detected.', facts }
}

function hasDestructiveText(text) {
  return SCRIPT_DELETE_PATTERNS.some((pattern) => pattern.test(text))
}

const SEE_ECHO_SAFE = SAFE_ECHO

export const __internal = {
  DELETE_COMMANDS,
  SCRIPT_DELETE_PATTERNS,
  hasDestructiveText,
  classifySsh,
  classifyDocker,
  commandBase,
}
