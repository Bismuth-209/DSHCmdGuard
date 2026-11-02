import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createPathGuard } from '../lib/path-guard.js'
import { createTrashRestoreTool, createTrashTool } from '../lib/trash.js'
import { makeTempDir } from './helpers.mjs'

function configFor(home, workspace, extraAllowedRoots = []) {
  return {
    trash: {
      relativeRoot: 'tmp/.cmd-guard-trash',
      maxPaths: 20,
      extraAllowedRoots,
      extraProtected: [],
    },
  }
}

test('path guard accepts workspace files and rejects roots/protected/paths', async () => {
  const root = makeTempDir('dg-path-')
  const home = path.join(root, 'home')
  const workspace = path.join(root, 'workspace')
  const outside = path.join(root, 'outside')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(workspace, '.git'), { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  const file = path.join(workspace, 'file.txt')
  fs.writeFileSync(file, 'hello')
  fs.writeFileSync(path.join(workspace, '.git', 'config'), 'git')
  fs.writeFileSync(path.join(outside, 'file.txt'), 'outside')

  const guard = createPathGuard({
    workspaceRoot: workspace,
    homeDir: home,
    trashRoot: path.join(workspace, 'tmp', '.cmd-guard-trash'),
  })

  const ok = await guard.validate(file)
  assert.equal(ok.ok, true)
  assert.equal(ok.canonical.toLowerCase(), fs.realpathSync(file).toLowerCase())

  assert.equal((await guard.validate('relative.txt')).code, 'TRASH_RELATIVE_PATH')
  assert.equal((await guard.validate(path.join(workspace, 'missing.txt'))).code, 'TRASH_NOT_FOUND')
  assert.equal((await guard.validate(workspace)).code, 'TRASH_WORKSPACE_ROOT')
  assert.equal((await guard.validate(path.join(workspace, '.git', 'config'))).code, 'TRASH_PROTECTED_PATH')
  assert.equal((await guard.validate(path.join(outside, 'file.txt'))).code, 'TRASH_OUTSIDE_WORKSPACE')

  const extra = createPathGuard({
    workspaceRoot: workspace,
    homeDir: home,
    trashRoot: path.join(workspace, 'tmp', '.cmd-guard-trash'),
    extraAllowedRoots: [outside],
  })
  assert.equal((await extra.validate(path.join(outside, 'file.txt'))).ok, true)
})

test('trash_move moves files out of the workspace without deleting them', async () => {
  const root = makeTempDir('dg-trash-')
  const home = path.join(root, 'home')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  const source = path.join(workspace, 'obsolete.txt')
  fs.writeFileSync(source, 'recoverable')

  const config = configFor(home, workspace)
  const events = []
  const tool = createTrashTool({ config, homeDir: home, audit: (event) => events.push(event) })
  const exec = { agent: { session: { id: 's1', header: { cwd: workspace } } }, signal: new AbortController().signal }

  const result = await tool.execute({ paths: [source], reason: 'test cleanup' }, exec)
  assert.equal(result.ok, true)
  assert.equal(result.moved.length, 1)
  assert.equal(fs.existsSync(source), false)
  assert.equal(fs.existsSync(result.moved[0].to), true)
  assert.equal(fs.readFileSync(result.moved[0].to, 'utf8'), 'recoverable')
  assert.equal(events.at(-1).code, 'TRASH_MOVED')
})

test('trash_restore restores a moved file without overwriting', async () => {
  const root = makeTempDir('dg-restore-')
  const home = path.join(root, 'home')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  const source = path.join(workspace, 'restore-me.txt')
  fs.writeFileSync(source, 'restore me')

  const config = configFor(home, workspace)
  const moveTool = createTrashTool({ config, homeDir: home })
  const restoreTool = createTrashRestoreTool({ config, homeDir: home })
  const exec = { agent: { session: { id: 's-restore', header: { cwd: workspace } } }, signal: new AbortController().signal }

  const moved = await moveTool.execute({ paths: [source] }, exec)
  assert.equal(moved.ok, true)
  const trashPath = moved.moved[0].to
  assert.equal(fs.existsSync(trashPath), true)

  const restored = await restoreTool.execute({ paths: [trashPath] }, exec)
  assert.equal(restored.ok, true)
  assert.equal(restored.restored.length, 1)
  assert.equal(fs.existsSync(source), true)
  assert.equal(fs.existsSync(trashPath), false)
  assert.equal(fs.readFileSync(source, 'utf8'), 'restore me')

  // A second restore must not overwrite the now-existing original.
  const again = await restoreTool.execute({ paths: [trashPath] }, exec)
  assert.equal(again.ok, false)
})

test('trash_move refuses protected and missing paths without moving anything', async () => {
  const root = makeTempDir('dg-trash-refuse-')
  const home = path.join(root, 'home')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(path.join(workspace, '.git'), { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(workspace, '.git', 'config'), 'git')
  const safe = path.join(workspace, 'safe.txt')
  fs.writeFileSync(safe, 'safe')

  const tool = createTrashTool({ config: configFor(home, workspace), homeDir: home })
  const exec = { agent: { session: { id: 's1', header: { cwd: workspace } } }, signal: new AbortController().signal }

  const protectedResult = await tool.execute({ paths: [path.join(workspace, '.git', 'config')] }, exec)
  assert.equal(protectedResult.ok, false)
  assert.equal(protectedResult.code, 'TRASH_VALIDATION_FAILED')
  assert.equal(fs.existsSync(path.join(workspace, '.git', 'config')), true)

  const mixed = await tool.execute({ paths: [safe, path.join(workspace, 'missing.txt')] }, exec)
  assert.equal(mixed.ok, false)
  assert.equal(fs.existsSync(safe), true)
})

