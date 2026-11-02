/**
 * Filesystem path validation for trash_move.
 *
 * This module is intentionally conservative: the agent may only move existing,
 * regular files/directories from the session workspace (or explicitly allowed
 * extra roots) into the host-owned trash. Symlinks/junctions are rejected in
 * the MVP to avoid path-escape ambiguity.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const WINDOWS = process.platform === 'win32'

function samePath(left, right) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function isInsideOrEqual(parent, child) {
  const parentResolved = path.resolve(parent)
  const childResolved = path.resolve(child)
  if (samePath(parentResolved, childResolved)) return true
  const relative = path.relative(parentResolved, childResolved)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function protectedRootsFor({ workspaceRoot, homeDir, trashRoot, extraProtected = [] }) {
  const workspaceSensitive = [
    path.join(workspaceRoot, '.git'),
    path.join(workspaceRoot, '.ssh'),
  ]
  const outside = [
    homeDir,
    path.join(homeDir, '.ssh'),
    trashRoot,
    ...extraProtected,
  ]
  const system = []
  if (WINDOWS) {
    system.push(
      'C:\\Windows',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\ProgramData',
      'C:\\$Recycle.Bin',
      'C:\\System Volume Information',
    )
  }
  return {
    workspaceSensitive: [...new Set(workspaceSensitive.filter(Boolean))],
    outside: [...new Set([...outside, ...system].filter((value) => typeof value === 'string' && value.length > 0))],
  }
}

/**
 * Create a path validator bound to one config.
 * @param {object} config
 * @returns {{validate: (source: string, options?: object) => Promise<object>}}
 */
export function createPathGuard(config) {
  const workspaceRoot = path.resolve(config.workspaceRoot)
  const homeDir = path.resolve(config.homeDir)
  const trashRoot = path.resolve(config.trashRoot)
  const extraAllowedRoots = (config.extraAllowedRoots ?? []).map((value) => path.resolve(value))
  const protectedRoots = protectedRootsFor({
    workspaceRoot,
    homeDir,
    trashRoot,
    extraProtected: config.extraProtected ?? [],
  })

  /**
   * Validate one source path without moving it.
   * @param {string} source
   * @returns {Promise<{ok: true, source: string, canonical: string, stat: object} | {ok: false, code: string, message: string}>}
   */
  async function validate(source) {
    if (typeof source !== 'string' || source.trim() === '') {
      return { ok: false, code: 'TRASH_INVALID_PATH', message: 'path must be a non-empty string' }
    }
    if (!path.isAbsolute(source)) {
      return { ok: false, code: 'TRASH_RELATIVE_PATH', message: 'path must be absolute' }
    }

    const resolved = path.resolve(source)
    let lstat
    try {
      lstat = await fs.lstat(resolved)
    } catch (error) {
      return { ok: false, code: 'TRASH_NOT_FOUND', message: error?.code === 'ENOENT' ? 'path does not exist' : String(error?.message ?? error) }
    }
    if (lstat.isSymbolicLink()) {
      return { ok: false, code: 'TRASH_SYMLINK', message: 'symlinks are not allowed' }
    }

    let canonical
    try {
      canonical = await fs.realpath(resolved)
    } catch (error) {
      return { ok: false, code: 'TRASH_REALPATH_FAILED', message: String(error?.message ?? error) }
    }

    if (samePath(canonical, workspaceRoot)) {
      return { ok: false, code: 'TRASH_WORKSPACE_ROOT', message: 'workspace root cannot be moved to trash' }
    }
    if (samePath(canonical, trashRoot) || isInsideOrEqual(trashRoot, canonical)) {
      return { ok: false, code: 'TRASH_TRASH_ROOT', message: 'trash root cannot be moved to trash' }
    }
    if (!samePath(canonical, trashRoot) && isInsideOrEqual(canonical, trashRoot)) {
      return { ok: false, code: 'TRASH_TRASH_PARENT', message: 'a parent of the trash root cannot be moved to trash' }
    }

    // Inside the workspace: only explicitly protected subdirectories are
    // rejected. Outside it: protected roots win over extra allowed roots.
    if (isInsideOrEqual(workspaceRoot, canonical)) {
      for (const protectedRoot of protectedRoots.workspaceSensitive) {
        if (samePath(canonical, protectedRoot) || isInsideOrEqual(protectedRoot, canonical)) {
          return { ok: false, code: 'TRASH_PROTECTED_PATH', message: `path is protected: ${protectedRoot}` }
        }
      }
      return { ok: true, source: resolved, canonical, stat: lstat }
    }

    const allowed = extraAllowedRoots.some((root) => isInsideOrEqual(root, canonical))
    if (!allowed) {
      return { ok: false, code: 'TRASH_OUTSIDE_WORKSPACE', message: 'path is outside the session workspace and configured roots' }
    }
    for (const protectedRoot of protectedRoots.outside) {
      if (samePath(canonical, protectedRoot) || isInsideOrEqual(protectedRoot, canonical)) {
        return { ok: false, code: 'TRASH_PROTECTED_PATH', message: `path is protected: ${protectedRoot}` }
      }
    }

    return { ok: true, source: resolved, canonical, stat: lstat }
  }

  return { validate, workspaceRoot, trashRoot, protectedRoots, extraAllowedRoots }
}

export const __internal = { samePath, isInsideOrEqual, protectedRootsFor }
