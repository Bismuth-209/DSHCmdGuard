import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createPathGuard } from '../lib/path-guard.js'
import { createTrashRestoreTool, createTrashTool } from '../lib/trash.js'

const enabled = process.platform === 'win32'

function rootDir() {
  const root = process.env.CMD_GUARD_WINDOWS_TEST_ROOT
    ?? path.join(process.cwd(), '.test-workspaces', 'windows-path-run')
  fs.mkdirSync(root, { recursive: true })
  return root
}

test('Windows path guard handles case-insensitive workspace roots', { skip: !enabled }, async () => {
  const root = rootDir()
  const run = path.join(root, `run-${Date.now()}`)
  const workspace = path.join(run, 'workspace')
  const home = path.join(run, 'home')
  const trash = path.join(run, 'trash')
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'Canary.txt'), 'case canary')

  const guard = createPathGuard({ workspaceRoot: workspace, homeDir: home, trashRoot: trash })
  const file = path.join(workspace, 'Canary.txt')
  assert.equal((await guard.validate(file)).ok, true)
  assert.equal((await guard.validate(file.toUpperCase())).ok, true)
  assert.equal((await guard.validate(workspace.toUpperCase())).code, 'TRASH_WORKSPACE_ROOT')
})

test('Windows junction is rejected by the path guard', { skip: !enabled }, async () => {
  const root = rootDir()
  const run = path.join(root, `junction-${Date.now()}`)
  const workspace = path.join(run, 'workspace')
  const home = path.join(run, 'home')
  const trash = path.join(run, 'trash')
  const outside = path.join(run, 'outside')
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'target.txt'), 'outside canary')

  const junction = path.join(workspace, 'link')
  try {
    fs.symlinkSync(outside, junction, 'junction')
  } catch (error) {
    // Some Windows policies disable junction creation; report a skip rather
    // than claiming the path guard passed.
    assert.fail(`could not create test junction: ${String(error?.message ?? error)}`)
  }

  const guard = createPathGuard({ workspaceRoot: workspace, homeDir: home, trashRoot: trash })
  const result = await guard.validate(junction)
  assert.equal(result.ok, false)
  assert.match(result.code, /TRASH_(SYMLINK|PROTECTED|OUTSIDE_WORKSPACE)/)
})

test('Windows trash_move/restore works on real paths without deletion', { skip: !enabled }, async () => {
  const root = rootDir()
  const run = path.join(root, `trash-${Date.now()}`)
  const workspace = path.join(run, 'workspace')
  const home = path.join(run, 'home')
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  const source = path.join(workspace, 'RestoreMe.txt')
  fs.writeFileSync(source, 'windows restore')

  const config = { trash: { relativeRoot: 'tmp/.cmd-guard-trash', maxPaths: 20, extraAllowedRoots: [], extraProtected: [] } }
  const move = createTrashTool({ config, homeDir: home, userHome: path.join(run, 'user-home') })
  const restore = createTrashRestoreTool({ config, homeDir: home, userHome: path.join(run, 'user-home') })
  const exec = { agent: { session: { id: `session-${Date.now()}`, header: { cwd: workspace } } }, signal: new AbortController().signal }

  const moved = await move.execute({ paths: [source] }, exec)
  assert.equal(moved.ok, true)
  assert.equal(fs.existsSync(source), false)
  assert.equal(fs.existsSync(moved.moved[0].to), true)
  const restored = await restore.execute({ paths: [moved.moved[0].to] }, exec)
  assert.equal(restored.ok, true)
  assert.equal(fs.existsSync(source), true)
  assert.equal(fs.readFileSync(source, 'utf8'), 'windows restore')
})

