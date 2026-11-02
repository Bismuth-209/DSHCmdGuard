/**
 * Cmd Guard host plugin.
 *
 * A deterministic pre-execute layer for destructive command families, plus a
 * compact LLM review for ambiguous cases. It never adds a permission preset,
 * never changes sandbox/approval, and skips its own LLM under the `auto` preset
 * (where the shipped auto-review owns the LLM decision).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAudit } from './audit.js'
import { createTrashTool, createTrashRestoreTool } from './trash.js'
import { createReviewer } from './review.js'
import { createInvestigator } from './investigator.js'
import { createRemoteInspector } from './remote.js'
import { classifyAction } from './policy.js'
import { isInsideOrEqual } from './path-guard.js'

export const name = 'cmd-guard'
export const inject = ['tools', 'systemPrompt']

const SYSTEM_SECTION = `Destructive operations are protected by a safety guard. If a tool call is denied by the guard, do not retry it through another tool, script, or alternate syntax; explain the intended operation to the user and ask for explicit confirmation. Use trash_move for cleanup and trash_restore to recover moved items; do not permanently delete files with shell commands.`

const DEFAULT_COMMAND_TOOLS = ['bash', 'pwsh', 'terminal_send']

function dshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return configured.length > 0 ? configured : path.join(os.homedir(), '.dsh')
}

function asPositiveInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min) return fallback
  return Math.min(number, max)
}

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeTrashRelativeRoot(value) {
  const raw = typeof value === 'string' && value.trim() !== '' ? value.trim() : 'tmp/.cmd-guard-trash'
  if (path.isAbsolute(raw)) {
    throw new Error('cmd-guard: trash.relativeRoot must be relative to the session workspace')
  }
  const normalized = path.normalize(raw)
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) {
    throw new Error('cmd-guard: trash.relativeRoot must stay inside the session workspace')
  }
  return normalized
}

/**
 * Normalize a user-supplied plugin config. Exported for tests.
 * @param {object} [raw]
 * @returns {object}
 */
export function normalizeConfig(raw = {}) {
  const home = dshHome()
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const trash = source.trash !== null && typeof source.trash === 'object' ? source.trash : {}
  const reviewer = source.reviewer !== null && typeof source.reviewer === 'object' ? source.reviewer : {}
  const audit = source.audit !== null && typeof source.audit === 'object' ? source.audit : {}
  const investigator = source.investigator !== null && typeof source.investigator === 'object' ? source.investigator : {}
  const remote = source.remote !== null && typeof source.remote === 'object' ? source.remote : {}

  const extraAllowedRoots = (Array.isArray(trash.extraAllowedRoots) ? trash.extraAllowedRoots : [])
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => path.resolve(item))
  const extraProtected = (Array.isArray(trash.extraProtected) ? trash.extraProtected : [])
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => path.resolve(item))

  const commandTools = (Array.isArray(source.commandTools) ? source.commandTools : DEFAULT_COMMAND_TOOLS)
    .filter((item) => typeof item === 'string' && item.trim() !== '')

  return {
    enabled: asBoolean(source.enabled, true),
    commandTools,
    trash: {
      enabled: asBoolean(trash.enabled, true),
      relativeRoot: normalizeTrashRelativeRoot(trash.relativeRoot ?? trash.root),
      maxPaths: asPositiveInteger(trash.maxPaths, 20, 1, 100),
      extraAllowedRoots,
      extraProtected,
    },
    reviewer: {
      enabled: asBoolean(reviewer.enabled, true),
      timeoutMs: asPositiveInteger(reviewer.timeoutMs, 20000, 1000, 120000),
      maxHistoryItems: asPositiveInteger(reviewer.maxHistoryItems, 12, 1, 50),
    },
    investigator: {
      enabled: asBoolean(investigator.enabled, false),
      timeoutMs: asPositiveInteger(investigator.timeoutMs, 15000, 1000, 120000),
      maxFiles: asPositiveInteger(investigator.maxFiles, 5, 1, 20),
      provider: typeof investigator.provider === 'string' && investigator.provider !== '' ? investigator.provider : 'spawn',
      agentPreset: typeof investigator.agentPreset === 'string' && investigator.agentPreset !== '' ? investigator.agentPreset : 'cmd-review-investigator',
    },
    remote: {
      enabled: asBoolean(remote.enabled, false),
      allowedHosts: (Array.isArray(remote.allowedHosts) ? remote.allowedHosts : []).filter((item) => typeof item === 'string' && item.trim() !== ''),
      user: typeof remote.user === 'string' && remote.user !== '' ? remote.user : undefined,
      port: asPositiveInteger(remote.port, 22, 1, 65535),
      identityFile: typeof remote.identityFile === 'string' && remote.identityFile !== '' ? remote.identityFile : undefined,
      knownHostsFile: typeof remote.knownHostsFile === 'string' && remote.knownHostsFile !== '' ? remote.knownHostsFile : undefined,
      sshBinary: typeof remote.sshBinary === 'string' && remote.sshBinary !== '' ? remote.sshBinary : 'ssh',
      strictHostKeyChecking: ['yes', 'accept-new', 'no'].includes(remote.strictHostKeyChecking) ? remote.strictHostKeyChecking : 'yes',
      probeTimeoutMs: asPositiveInteger(remote.probeTimeoutMs, 5000, 500, 60000),
      maxProbes: asPositiveInteger(remote.maxProbes, 3, 1, 5),
      maxBytes: asPositiveInteger(remote.maxBytes, 8192, 256, 65536),
      failClosed: asBoolean(remote.failClosed, true),
    },
    audit: {
      enabled: asBoolean(audit.enabled, true),
      root: path.resolve(typeof audit.root === 'string' && audit.root !== '' ? audit.root : path.join(home, 'cmd-guard')),
    },
  }
}

function deny(code, reason, facts) {
  return {
    kind: 'deny',
    reason,
    info: {
      name: 'CmdGuardBlockedError',
      code,
      ...facts === undefined ? {} : { facts },
    },
  }
}

function readScriptWithin(workspaceRoot, filePath, cwd) {
  try {
    const resolved = path.resolve(cwd ?? workspaceRoot, filePath)
    if (!isInsideOrEqual(workspaceRoot, resolved)) return undefined
    const stat = fs.statSync(resolved)
    if (!stat.isFile() || stat.size > 64 * 1024) return undefined
    return fs.readFileSync(resolved, 'utf8')
  } catch {
    return undefined
  }
}

function sandboxOf(ctx, agent) {
  const service = ctx.get?.('sandboxPolicy')
  try {
    const resolved = service?.resolve?.({ session: agent?.session })
    if (resolved !== undefined) {
      return {
        mode: resolved.mode,
        workspaceRoot: resolved.workspaceRoot,
        cwd: resolved.workspaceRoot,
      }
    }
  } catch {
    // fall through to the session header
  }
  const cwd = agent?.session?.header?.cwd ?? process.cwd()
  return { mode: 'unknown', workspaceRoot: cwd, cwd }
}

function presetOf(ctx, agent) {
  const service = ctx.get?.('permissionPresets')
  try {
    return service?.current?.(agent?.session)
  } catch {
    return undefined
  }
}

/**
 * Install the plugin.
 * @param {object} ctx cordis context
 * @param {object} [rawConfig]
 * @returns {() => void} disposer
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return () => {}

  const homeDir = dshHome()
  const audit = createAudit({ config, homeDir, logger: ctx.logger })
  const reviewer = createReviewer({ config, logger: ctx.logger })
  const investigator = createInvestigator({ config, logger: ctx.logger })
  const remoteInspector = createRemoteInspector({ config, logger: ctx.logger, audit: audit.record })
  const disposers = []

  if (config.trash.enabled) {
    const tool = createTrashTool({ config, homeDir, userHome: os.homedir(), audit: audit.record })
    disposers.push(ctx.tools.register(tool))
    const restoreTool = createTrashRestoreTool({ config, homeDir, userHome: os.homedir(), audit: audit.record })
    disposers.push(ctx.tools.register(restoreTool))
  }

  const sectionDispose = ctx.systemPrompt?.section?.({
    name: 'cmd-guard:policy',
    order: 1500,
    text: SYSTEM_SECTION,
    interpolate: false,
  })
  if (typeof sectionDispose === 'function') disposers.push(sectionDispose)

  const commandTools = new Set(config.commandTools)

  const listener = async (exec, next) => {
    const toolName = typeof exec?.name === 'string' ? exec.name : ''
    if (toolName !== 'trash_move' && toolName !== 'trash_restore' && !commandTools.has(toolName)) return next()

    const agent = exec?.agent
    if (agent === undefined) return next()

    const sandbox = sandboxOf(ctx, agent)
    const cwd = sandbox.workspaceRoot ?? agent?.session?.header?.cwd ?? process.cwd()
    const policy = classifyAction({
      toolName,
      arguments: exec.arguments,
      cwd,
      readScript: (filePath, scriptCwd) => readScriptWithin(cwd, filePath, scriptCwd),
    })

    audit.record({
      type: 'preflight',
      sessionId: agent?.session?.id,
      agentId: agent?.id,
      tool: toolName,
      decision: policy.decision,
      code: policy.code,
      reason: policy.reason,
      facts: policy.facts,
    })

    if (policy.decision === 'allow') return next()
    if (policy.decision === 'deny') {
      return deny(policy.code, policy.reason, policy.facts)
    }

    // policy.decision === 'review'
    const preset = presetOf(ctx, agent)
    if (preset === 'auto') {
      // The shipped Auto review owns the LLM decision under `auto`.
      return next()
    }

    if (config.remote.enabled === true && typeof policy.facts?.ssh?.host === 'string') {
      let remote
      try {
        remote = await remoteInspector.inspectForCommand({
          host: policy.facts.ssh.host,
          user: policy.facts.ssh.user,
          remoteCommand: policy.facts.ssh.remoteCommand,
          code: policy.code,
          signal: exec.signal,
        })
      } catch (error) {
        remote = { ok: false, code: 'REMOTE_INSPECT_FAILED', probes: [], error: String(error?.message ?? error) }
      }
      policy.facts.remote = remote
      audit.record({
        type: 'remote_inspect_summary',
        sessionId: agent?.session?.id,
        agentId: agent?.id,
        tool: toolName,
        host: policy.facts.ssh.host,
        remoteCommand: policy.facts.ssh.remoteCommand,
        ok: remote.ok,
        code: remote.code,
        probes: Array.isArray(remote.probes) ? remote.probes.map((probe) => ({ probe: probe.probe, target: probe.target, ok: probe.ok, code: probe.code })) : [],
      })
      if (remote.ok !== true && policy.code === 'SSH_REMOTE_DELETE' && config.remote.failClosed === true) {
        return deny('REMOTE_UNVERIFIED', 'Blocked by cmd guard: remote state could not be verified.', policy.facts)
      }
    }

    const reviewed = await reviewer.review(ctx, {
      agent,
      exec,
      policy,
      sandbox,
      signal: exec.signal,
    })
    audit.record({
      type: 'review',
      sessionId: agent?.session?.id,
      agentId: agent?.id,
      tool: toolName,
      code: reviewed.code,
      decision: reviewed.decision,
      reason: reviewed.reason,
      investigate: reviewed.investigate,
    })

    if (reviewed.decision === 'investigate') {
      if (config.investigator.enabled !== true) {
        return deny('REVIEW_INVESTIGATE', 'Blocked by cmd guard: facts are insufficient; ask the user before proceeding.', policy.facts)
      }
      const investigated = await investigator.investigate(ctx, {
        agent,
        exec,
        policy,
        sandbox,
        signal: exec.signal,
        questions: reviewed.investigate?.questions,
      })
      audit.record({
        type: 'investigator',
        sessionId: agent?.session?.id,
        agentId: agent?.id,
        tool: toolName,
        code: investigated.code,
        decision: investigated.decision,
        reason: investigated.reason,
      })
      if (investigated.decision === 'allow') return next()
      return deny(investigated.code, investigated.reason, policy.facts)
    }

    if (reviewed.decision === 'allow') return next()
    return deny(reviewed.code, reviewed.reason, policy.facts)
  }

  disposers.push(ctx.on('tools/pre-execute', listener, { prepend: true }))

  ctx.logger?.info?.(`cmd-guard: ready (trash: <workspace>/${config.trash.relativeRoot})`)
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.()
      } catch {
        // best effort
      }
    }
  }
}

export const __internal = { SYSTEM_SECTION, readScriptWithin, sandboxOf, presetOf }
