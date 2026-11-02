/**
 * Host-side, read-only SSH probe service.
 *
 * The service only runs fixed probe verbs over SSH; it never accepts a raw
 * remote command string from the model. Targets are extracted from the pending
 * command and re-validated here.
 */
import { spawn } from 'node:child_process'

const PROBE_VERBS = new Set(['stat', 'list', 'read', 'docker_inspect', 'systemctl_status', 'git_status'])

function asString(value) {
  return typeof value === 'string' ? value : ''
}

function truncate(value, max) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (typeof text !== 'string') return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function safeTarget(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && !/[\0\r\n]/.test(value)
}

function extractPaths(remoteCommand) {
  const raw = asString(remoteCommand)
  const tokens = raw.split(/\s+/).map((token) => token.replace(/^["']+|["']+$/g, ''))
  const paths = []
  for (const token of tokens) {
    if (!token.startsWith('/')) continue
    if (/[;|&`$<>]/.test(token)) continue
    const normalized = token.length > 1 ? token.replace(/\/+$/, '') : token
    if (normalized === '/' || normalized.length > 512) continue
    if (!paths.includes(normalized)) paths.push(normalized)
    if (paths.length >= 3) break
  }
  return paths
}

function extractDockerResources(remoteCommand) {
  const tokens = asString(remoteCommand).split(/\s+/).map((token) => token.replace(/^["']+|["']+$/g, ''))
  const index = tokens.findIndex((token) => token === 'docker')
  if (index < 0) return []
  const tail = tokens.slice(index + 1)
  const rmIndex = tail.findIndex((token) => token === 'rm')
  const rmiIndex = tail.findIndex((token) => token === 'rmi')
  const volumeIndex = tail.findIndex((token, i) => token === 'volume' && tail[i + 1] === 'rm')
  let start = -1
  let resourceType = 'container'
  if (rmIndex >= 0) {
    start = rmIndex + 1
  } else if (rmiIndex >= 0) {
    start = rmiIndex + 1
    resourceType = 'image'
  } else if (volumeIndex >= 0) {
    start = volumeIndex + 2
    resourceType = 'volume'
  }
  if (start < 0) return []
  const resources = []
  for (const token of tail.slice(start)) {
    if (token.startsWith('-')) continue
    if (!safeTarget(token)) continue
    if (token === '|' || /[;|&`$<>]/.test(token)) continue
    if (!resources.some((item) => item.target === token)) resources.push({ target: token, resourceType })
    if (resources.length >= 3) break
  }
  return resources
}

function extractSystemdUnit(remoteCommand) {
  const tokens = asString(remoteCommand).split(/\s+/).map((token) => token.replace(/^["']+|["']+$/g, ''))
  const index = tokens.findIndex((token) => token === 'systemctl')
  if (index < 0) return undefined
  const tail = tokens.slice(index + 1)
  const statusIndex = tail.findIndex((token) => token === 'status')
  if (statusIndex < 0) return undefined
  return tail.slice(statusIndex + 1).find((token) => !token.startsWith('-'))
}

function probeArgv(probe) {
  switch (probe.verb) {
    case 'stat': return ['stat', '-c', '%F|%s|%Y|%n', '--', probe.target]
    case 'list': return ['ls', '-la', '--', probe.target]
    case 'read': return ['head', '-c', String(probe.maxBytes), '--', probe.target]
    case 'docker_inspect': return ['docker', 'inspect', '--type', probe.resourceType ?? 'container', probe.target]
    case 'systemctl_status': return ['systemctl', 'status', '--no-pager', probe.target]
    case 'git_status': return ['git', '-C', probe.target, 'status', '--porcelain']
    default: throw new Error(`unsupported probe verb: ${probe.verb}`)
  }
}

function buildProbePlan({ remoteCommand, code, config }) {
  const probes = []
  const maxProbes = config.remote?.maxProbes ?? 3
  const maxBytes = config.remote?.maxBytes ?? 8192
  const wantsContent = /(?:^|[;&|]\s*)(?:cat|head|tail|type)\s+/i.test(asString(remoteCommand))
  const paths = extractPaths(remoteCommand)
  for (const target of paths) {
    probes.push({ verb: wantsContent ? 'read' : 'stat', target })
    if (!wantsContent && probes.length < maxProbes) probes.push({ verb: 'list', target })
    if (probes.length >= maxProbes) break
  }

  const dockerResources = extractDockerResources(remoteCommand)
  for (const resource of dockerResources) {
    if (probes.length >= maxProbes) break
    probes.push({ verb: 'docker_inspect', target: resource.target, resourceType: resource.resourceType })
  }

  const unit = extractSystemdUnit(remoteCommand)
  if (unit !== undefined && probes.length < maxProbes) probes.push({ verb: 'systemctl_status', target: unit })

  if (code === 'SSH_REMOTE_DELETE' && probes.length === 0) {
    // No explicit target: let the reviewer see that the remote state is unverified.
    return probes
  }
  return probes.map((probe) => ({ ...probe, maxBytes }))
}

function runSsh({ config, host, user, probe, signal }) {
  const remote = config.remote ?? {}
  const effectiveUser = typeof user === 'string' && user !== ''
    ? user
    : (typeof remote.user === 'string' && remote.user !== '' ? remote.user : undefined)
  const userPart = effectiveUser === undefined ? '' : `${effectiveUser}@`
  const timeoutMs = remote.probeTimeoutMs ?? 5000
  const sshBinary = remote.sshBinary ?? 'ssh'
  const args = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${Math.max(1, Math.floor(timeoutMs / 1000))}`, '-o', 'LogLevel=ERROR']
  const strict = remote.strictHostKeyChecking ?? 'yes'
  args.push('-o', `StrictHostKeyChecking=${strict}`)
  if (typeof remote.knownHostsFile === 'string' && remote.knownHostsFile !== '') args.push('-o', `UserKnownHostsFile=${remote.knownHostsFile}`)
  if (typeof remote.identityFile === 'string' && remote.identityFile !== '') args.push('-i', remote.identityFile)
  if (typeof remote.port === 'number' && remote.port > 0) args.push('-p', String(remote.port))
  args.push(`${userPart}${host}`, '--', probeArgv(probe).map(shellQuote).join(' '))

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let child
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child?.kill('SIGKILL')
      } catch {
        // best effort
      }
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, code: 'REMOTE_PROBE_TIMEOUT', error: 'probe timed out' }), timeoutMs)
    try {
      child = spawn(sshBinary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: process.env })
    } catch (error) {
      finish({ ok: false, code: 'REMOTE_PROBE_SPAWN_FAILED', error: String(error?.message ?? error) })
      return
    }
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 32768) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => finish({ ok: false, code: 'REMOTE_PROBE_SPAWN_FAILED', error: String(error?.message ?? error) }))
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, code: 'REMOTE_PROBE_OK', stdout: truncate(stdout, remote.maxBytes ?? 8192) })
      else finish({ ok: false, code: 'REMOTE_PROBE_FAILED', exitCode: code, error: truncate(stderr, 1000) })
    })
    if (signal !== undefined) {
      if (signal.aborted) finish({ ok: false, code: 'REMOTE_PROBE_ABORTED', error: 'aborted' })
      else signal.addEventListener('abort', () => finish({ ok: false, code: 'REMOTE_PROBE_ABORTED', error: 'aborted' }), { once: true })
    }
  })
}

/**
 * Create the remote inspector.
 * @param {{config: object, logger?: object, audit?: Function, runner?: Function}} options
 */
export function createRemoteInspector({ config, logger, audit, runner }) {
  async function inspectForCommand({ host, user, remoteCommand, code, signal }) {
    if (config.remote?.enabled !== true) {
      return { ok: false, code: 'REMOTE_DISABLED', host, remoteCommand, probes: [] }
    }
    const allowed = Array.isArray(config.remote.allowedHosts) ? config.remote.allowedHosts : []
    if (!allowed.includes(host)) {
      return { ok: false, code: 'REMOTE_HOST_NOT_ALLOWED', host, remoteCommand, probes: [] }
    }
    const probes = buildProbePlan({ remoteCommand, code, config })
    if (probes.length === 0) {
      return { ok: false, code: 'REMOTE_NO_PROBE_TARGETS', host, remoteCommand, probes: [] }
    }

    const results = []
    let succeeded = 0
    for (const probe of probes) {
      if (signal?.aborted) {
        results.push({ probe: probe.verb, target: probe.target, ok: false, code: 'REMOTE_PROBE_ABORTED' })
        break
      }
      const result = runner === undefined
        ? await runSsh({ config, host, user, probe, signal })
        : await runner({ config, host, user, probe, signal })
      const entry = { probe: probe.verb, target: probe.target, ...result }
      results.push(entry)
      if (result.ok) succeeded += 1
      audit?.({ type: 'remote_probe', host, probe: probe.verb, target: probe.target, ok: result.ok, code: result.code })
    }

    return {
      ok: succeeded > 0,
      code: succeeded > 0 ? 'REMOTE_INSPECTED' : 'REMOTE_INSPECT_FAILED',
      host,
      remoteCommand,
      probes: results,
    }
  }

  return { inspectForCommand, buildProbePlan }
}

export const __internal = {
  PROBE_VERBS,
  shellQuote,
  extractPaths,
  extractDockerResources,
  extractSystemdUnit,
  buildProbePlan,
  runSsh,
}
