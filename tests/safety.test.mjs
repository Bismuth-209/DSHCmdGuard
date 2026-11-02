import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { findListener, makeExec, makeFakeAgent, makeFakeCtx, makeNext, makeTempDir } from './helpers.mjs'

function setupCanary() {
  const home = makeTempDir('dg-safe-home-')
  const workspace = makeTempDir('dg-safe-ws-')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  const canary = path.join(workspace, 'PRODUCTION_CANARY.txt')
  fs.writeFileSync(canary, 'must survive')
  const ctx = makeFakeCtx({ cwd: workspace, preset: 'workspace-write', reviewerDecision: 'deny' })
  const dispose = apply(ctx, {
    enabled: true,
    commandTools: ['bash', 'pwsh', 'terminal_send'],
    trash: { enabled: true, relativeRoot: 'tmp/.cmd-guard-trash', maxPaths: 20, extraAllowedRoots: [] },
    reviewer: { enabled: true, timeoutMs: 5000 },
    audit: { enabled: true, root: path.join(home, 'audit') },
  })
  const listener = findListener(ctx)
  const agent = makeFakeAgent({ cwd: workspace })
  return { home, workspace, canary, ctx, dispose, listener, agent }
}

test('a denied destructive body never runs; the canary survives', async () => {
  const { listener, agent, canary, dispose } = setupCanary()
  const calls = []
  async function dangerousBody() {
    calls.push(true)
    // Simulates a body that would damage the canary if it ever ran. It only
    // records the call; tests must never delete real files.
    return { kind: 'allow' }
  }
  const result = await listener(makeExec({ name: 'pwsh', args: { command: 'Remove-Item -LiteralPath "C:\\workspace\\PRODUCTION_CANARY.txt" -Force' }, agent }), dangerousBody)
  assert.equal(result.kind, 'deny')
  assert.equal(calls.length, 0)
  assert.equal(fs.existsSync(canary), true)
  dispose()
})

test('danger corpus never reaches next() and never touches the canary', async () => {
  const { listener, agent, canary, dispose } = setupCanary()
  const corpus = [
    'rm -rf /x',
    'rm -rf "$DIR"',
    'Remove-Item -Path $env:TEMP\\* -Recurse -Force',
    'Get-ChildItem C:\\x | Remove-Item -Recurse -Force',
    'cmd /c rd /s /q C:\\x',
    'powershell -NoProfile -Command "Remove-Item -LiteralPath C:\\x"',
    'bash -c "rm -rf /x"',
    'python -c "import shutil; shutil.rmtree(\'/\')"',
    'ssh prod "rm -rf /srv"',
    'ssh prod "bash -s"',
    'docker system prune -af',
    'docker rm $(docker ps -aq)',
    'git clean -xfd',
    'find . -delete',
    'xargs rm',
    'sudo rm -rf /x',
    'Invoke-Expression $cmd',
    '& $cmd',
  ]

  for (const command of corpus) {
    const calls = []
    async function body() {
      calls.push(command)
      // Do not perform any filesystem operation here. Reaching this body is
      // itself the failure signal.
      return { kind: 'allow' }
    }
    const result = await listener(makeExec({ name: 'pwsh', args: { command }, agent }), body)
    assert.notEqual(result.kind, 'allow', `${command} reached the body`)
    assert.equal(calls.length, 0, `${command} reached the body`)
    assert.equal(fs.existsSync(canary), true, `${command} damaged the canary`)
  }
  dispose()
})

test('trash_move is reversible and never permanently deletes', async () => {
  const { listener, agent, canary, ctx, dispose } = setupCanary()
  const next = makeNext()
  // trash_move is allowed by preflight; the tool body is what moves the file.
  const result = await listener(makeExec({ name: 'trash_move', args: { paths: [canary] }, agent }), next)
  assert.equal(result.kind, 'allow')
  assert.equal(next.calls.length, 1)

  const tool = ctx.toolsRegistered.find((item) => item.name === 'trash_move')
  const moved = await tool.execute({ paths: [canary] }, { agent: { session: { id: 's1', header: { cwd: path.dirname(canary) } } }, signal: new AbortController().signal })
  assert.equal(moved.ok, true)
  assert.equal(fs.existsSync(canary), false)
  assert.equal(fs.existsSync(moved.moved[0].to), true)
  assert.equal(fs.readFileSync(moved.moved[0].to, 'utf8'), 'must survive')
  dispose()
})

