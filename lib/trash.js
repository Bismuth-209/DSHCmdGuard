/**
 * Host-side trash_move tool.
 *
 * The tool receives literal JSON paths, validates them against the session
 * workspace and protected roots, then moves them under the host-owned trash
 * root. It never permanently deletes a source path.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createPathGuard, isInsideOrEqual } from './path-guard.js'

function sessionSegment(sessionId) {
  return String(sessionId ?? 'unknown').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'unknown'
}

function sessionDirectory(trashRoot, sessionId) {
  return path.join(trashRoot, sessionSegment(sessionId))
}

function manifestFile(trashRoot, sessionId) {
  return path.join(sessionDirectory(trashRoot, sessionId), 'manifest.jsonl')
}

async function appendManifest(trashRoot, sessionId, entry) {
  const file = manifestFile(trashRoot, sessionId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, `${JSON.stringify({ ...entry, time: new Date().toISOString() })}\n`, 'utf8')
}

async function readManifest(trashRoot, sessionId) {
  const file = manifestFile(trashRoot, sessionId)
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const entries = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const value = JSON.parse(line)
      if (typeof value?.from === 'string' && typeof value?.to === 'string') entries.push(value)
    } catch {
      // ignore malformed manifest lines
    }
  }
  return entries
}

function samePath(left, right) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function resolveTrashRoot(workspaceRoot, trashConfig) {
  const relative = typeof trashConfig.relativeRoot === 'string' && trashConfig.relativeRoot !== ''
    ? trashConfig.relativeRoot
    : 'tmp/.cmd-guard-trash'
  if (path.isAbsolute(relative)) {
    throw new Error('trash.relativeRoot must be relative to the session workspace')
  }
  const root = path.resolve(workspaceRoot, relative)
  if (samePath(root, workspaceRoot) || !isInsideOrEqual(workspaceRoot, root)) {
    throw new Error('trash.relativeRoot must stay inside the session workspace')
  }
  return root
}

/**
 * Move one already-validated path.
 * @param {{source: string, canonical: string}} valid
 * @param {{trashRoot: string, sessionId: string}} options
 * @returns {Promise<{from: string, to: string}>}
 */
async function moveOne(valid, options) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const nonce = crypto.randomBytes(4).toString('hex')
  const base = path.basename(valid.canonical) || 'item'
  const destinationDir = path.join(options.trashRoot, sessionSegment(options.sessionId), `${stamp}-${nonce}`)
  await fs.mkdir(destinationDir, { recursive: true })
  const destination = path.join(destinationDir, base)
  await fs.rename(valid.source, destination)
  return { from: valid.canonical, to: destination }
}

/**
 * Create the `trash_move` tool definition.
 * @param {object} options
 * @param {object} options.config normalized plugin config
 * @param {string} options.homeDir
 * @param {(event: object) => void} [options.audit]
 * @returns {object}
 */
export function createTrashTool({ config, homeDir, userHome, audit }) {
  const trashConfig = config.trash
  const maxPaths = trashConfig.maxPaths

  return {
    name: 'trash_move',
    description:
      'Move files or directories to the session trash instead of deleting them. Paths must be absolute and inside the session workspace (or a configured allowed root).',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string', description: 'Absolute source path.' },
          description: `Absolute paths to move to trash (max ${maxPaths}).`,
        },
        reason: { type: 'string', description: 'Optional one-line cleanup reason.' },
      },
      required: ['paths'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const paths = Array.isArray(args?.paths) ? args.paths : []
      if (paths.length === 0) {
        return { ok: false, code: 'TRASH_EMPTY', message: 'no paths supplied' }
      }
      if (paths.length > maxPaths) {
        return { ok: false, code: 'TRASH_TOO_MANY', message: `at most ${maxPaths} paths are allowed` }
      }

      const agent = exec?.agent
      const workspaceRoot = agent?.session?.header?.cwd
      if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
        return { ok: false, code: 'TRASH_NO_WORKSPACE', message: 'session workspace is unavailable' }
      }

      let trashRoot
      try {
        trashRoot = resolveTrashRoot(workspaceRoot, trashConfig)
      } catch (error) {
        return { ok: false, code: 'TRASH_INVALID_ROOT', message: String(error?.message ?? error) }
      }

      const guard = createPathGuard({
        workspaceRoot,
        homeDir: userHome ?? homeDir,
        trashRoot,
        extraAllowedRoots: trashConfig.extraAllowedRoots,
        extraProtected: trashConfig.extraProtected,
      })

      const validated = []
      const validationErrors = []
      for (const source of paths) {
        const result = await guard.validate(source)
        if (result.ok) validated.push(result)
        else validationErrors.push({ path: source, code: result.code, message: result.message })
      }
      if (validationErrors.length > 0) {
        const record = {
          type: 'trash_move',
          decision: 'deny',
          code: 'TRASH_VALIDATION_FAILED',
          sessionId: agent?.session?.id,
          errors: validationErrors,
        }
        audit?.(record)
        return { ok: false, code: 'TRASH_VALIDATION_FAILED', errors: validationErrors }
      }

      const moved = []
      const moveErrors = []
      for (const valid of validated) {
        if (exec?.signal?.aborted) {
          moveErrors.push({ path: valid.canonical, code: 'TRASH_ABORTED', message: 'call aborted' })
          break
        }
        try {
          const entry = await moveOne(valid, { trashRoot, sessionId: agent?.session?.id })
          moved.push(entry)
          await appendManifest(trashRoot, agent?.session?.id, entry)
        } catch (error) {
          moveErrors.push({
            path: valid.canonical,
            code: error?.code === 'EXDEV' ? 'TRASH_CROSS_DEVICE' : 'TRASH_MOVE_FAILED',
            message: String(error?.message ?? error),
          })
        }
      }

      const record = {
        type: 'trash_move',
        decision: moveErrors.length === 0 ? 'allow' : 'partial',
        code: moveErrors.length === 0 ? 'TRASH_MOVED' : 'TRASH_MOVE_PARTIAL',
        sessionId: agent?.session?.id,
        reason: typeof args?.reason === 'string' ? args.reason.slice(0, 500) : undefined,
        moved,
        errors: moveErrors,
      }
      audit?.(record)
      if (moveErrors.length > 0) {
        return { ok: moved.length > 0, code: 'TRASH_MOVE_PARTIAL', moved, errors: moveErrors }
      }
      return { ok: true, code: 'TRASH_MOVED', moved }
    },
  }
}

/**
 * Create the `trash_restore` tool definition.
 * @param {object} options
 * @param {object} options.config normalized plugin config
 * @param {string} options.homeDir
 * @param {string} [options.userHome]
 * @param {(event: object) => void} [options.audit]
 * @returns {object}
 */
export function createTrashRestoreTool({ config, homeDir, userHome, audit }) {
  const trashConfig = config.trash
  const maxPaths = Math.min(trashConfig.maxPaths, 20)

  return {
    name: 'trash_restore',
    description:
      'Restore files or directories previously moved by trash_move. Pass the trash destination path(s) returned by trash_move.',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string', description: 'Absolute trash destination path.' },
          description: `Trash paths to restore (max ${maxPaths}).`,
        },
      },
      required: ['paths'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const paths = Array.isArray(args?.paths) ? args.paths : []
      if (paths.length === 0) return { ok: false, code: 'TRASH_RESTORE_EMPTY', message: 'no paths supplied' }
      if (paths.length > maxPaths) return { ok: false, code: 'TRASH_RESTORE_TOO_MANY', message: `at most ${maxPaths} paths are allowed` }

      const agent = exec?.agent
      const sessionId = agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { ok: false, code: 'TRASH_RESTORE_NO_SESSION', message: 'session is unavailable' }
      }
      const workspaceRoot = agent?.session?.header?.cwd
      if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
        return { ok: false, code: 'TRASH_RESTORE_NO_WORKSPACE', message: 'session workspace is unavailable' }
      }
      let trashRoot
      try {
        trashRoot = resolveTrashRoot(workspaceRoot, trashConfig)
      } catch (error) {
        return { ok: false, code: 'TRASH_RESTORE_INVALID_ROOT', message: String(error?.message ?? error) }
      }
      const sessionDir = sessionDirectory(trashRoot, sessionId)
      let manifest
      try {
        manifest = await readManifest(trashRoot, sessionId)
      } catch (error) {
        return { ok: false, code: 'TRASH_RESTORE_MANIFEST_FAILED', message: String(error?.message ?? error) }
      }

      const restored = []
      const errors = []
      for (const source of paths) {
        if (exec?.signal?.aborted) {
          errors.push({ path: source, code: 'TRASH_RESTORE_ABORTED', message: 'call aborted' })
          break
        }
        if (typeof source !== 'string' || !path.isAbsolute(source)) {
          errors.push({ path: source, code: 'TRASH_RESTORE_INVALID_PATH', message: 'path must be absolute' })
          continue
        }
        let canonical
        try {
          canonical = await fs.realpath(source)
        } catch (error) {
          errors.push({ path: source, code: 'TRASH_RESTORE_NOT_FOUND', message: String(error?.message ?? error) })
          continue
        }
        if (!isInsideOrEqual(sessionDir, canonical)) {
          errors.push({ path: source, code: 'TRASH_RESTORE_OUTSIDE_TRASH', message: 'path is not in this session trash' })
          continue
        }
        const entry = manifest.find((item) => samePath(item.to, canonical))
        if (entry === undefined) {
          errors.push({ path: source, code: 'TRASH_RESTORE_NO_MANIFEST', message: 'no move record for this path' })
          continue
        }
        if (samePath(entry.from, trashRoot) || isInsideOrEqual(trashRoot, entry.from)) {
          errors.push({ path: source, code: 'TRASH_RESTORE_INVALID_ORIGIN', message: 'original path is in the trash root' })
          continue
        }
        try {
          await fs.lstat(entry.from)
          errors.push({ path: source, code: 'TRASH_RESTORE_EXISTS', message: `original path already exists: ${entry.from}` })
          continue
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            errors.push({ path: source, code: 'TRASH_RESTORE_STAT_FAILED', message: String(error?.message ?? error) })
            continue
          }
        }
        const parent = path.dirname(entry.from)
        try {
          const parentStat = await fs.stat(parent)
          if (!parentStat.isDirectory()) {
            errors.push({ path: source, code: 'TRASH_RESTORE_PARENT_INVALID', message: `parent is not a directory: ${parent}` })
            continue
          }
        } catch (error) {
          errors.push({ path: source, code: 'TRASH_RESTORE_PARENT_MISSING', message: String(error?.message ?? error) })
          continue
        }
        try {
          await fs.rename(canonical, entry.from)
          restored.push({ from: canonical, to: entry.from })
          await appendManifest(trashRoot, sessionId, { from: entry.from, to: canonical, restored: true })
        } catch (error) {
          errors.push({ path: source, code: error?.code === 'EXDEV' ? 'TRASH_RESTORE_CROSS_DEVICE' : 'TRASH_RESTORE_FAILED', message: String(error?.message ?? error) })
        }
      }

      audit?.({
        type: 'trash_restore',
        decision: errors.length === 0 ? 'allow' : 'partial',
        code: errors.length === 0 ? 'TRASH_RESTORED' : 'TRASH_RESTORE_PARTIAL',
        sessionId,
        restored,
        errors,
      })
      if (errors.length > 0) return { ok: restored.length > 0, code: 'TRASH_RESTORE_PARTIAL', restored, errors }
      return { ok: true, code: 'TRASH_RESTORED', restored }
    },
  }
}

export const __internal = { moveOne, sessionSegment, readManifest, appendManifest, resolveTrashRoot }


