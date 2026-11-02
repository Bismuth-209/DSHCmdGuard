import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'
import {
  findListener,
  makeExec,
  makeFakeAgent,
  makeFakeCtx,
  makeNext,
  makeTempDir,
} from './helpers.mjs'

function configFor(home, workspace, { investigatorEnabled = false } = {}) {
  return {
    enabled: true,
    commandTools: ['bash', 'pwsh', 'terminal_send'],
    trash: {
      enabled: true,
      relativeRoot: 'tmp/.cmd-guard-trash',
      maxPaths: 20,
      extraAllowedRoots: [],
    },
    reviewer: { enabled: true, timeoutMs: 5000 },
    investigator: {
      enabled: investigatorEnabled,
      provider: 'spawn',
      agentPreset: 'cmd-review-investigator',
      timeoutMs: 1000,
      maxFiles: 3,
    },
    audit: { enabled: true, root: path.join(home, 'audit') },
  }
}

function setup({ preset = 'workspace-write', reviewerDecision = 'deny', reviewerReason = 'test denial', investigatorEnabled = false, subagents } = {}) {
  const home = makeTempDir('dg-plugin-home-')
  const workspace = makeTempDir('dg-plugin-ws-')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  const llmCalls = []
  const ctx = makeFakeCtx({ cwd: workspace, preset, reviewerDecision, reviewerReason, llmCalls, subagents })
  const dispose = apply(ctx, configFor(home, workspace, { investigatorEnabled }))
  const listener = findListener(ctx)
  const agent = makeFakeAgent({ cwd: workspace })
  return { home, workspace, ctx, dispose, listener, agent, llmCalls }
}

test('registers one short system section and one trash tool', () => {
  const { ctx, dispose } = setup()
  assert.equal(ctx.sections.length, 1)
  assert.match(ctx.sections[0].text, /do not retry/i)
  assert.match(ctx.sections[0].text, /trash_move/)
  assert.ok(ctx.sections[0].text.length < 600)
  assert.ok(ctx.toolsRegistered.some((tool) => tool.name === 'trash_move'))
  assert.ok(ctx.toolsRegistered.some((tool) => tool.name === 'trash_restore'))
  dispose()
  assert.equal(ctx.sections.length, 0)
  assert.equal(ctx.listeners.length, 0)
  assert.equal(ctx.toolsRegistered.length, 0)
})

test('denies shell deletion before the tool body runs', async () => {
  const { listener, agent, dispose } = setup()
  const next = makeNext()
  const exec = makeExec({ name: 'pwsh', args: { command: 'Remove-Item -LiteralPath "C:\\x" -Recurse -Force' }, agent })
  const result = await listener(exec, next)
  assert.equal(result.kind, 'deny')
  assert.equal(result.info.code, 'SHELL_DELETE')
  assert.equal(next.calls.length, 0)
  dispose()
})

test('allows ordinary commands through to the downstream pipeline', async () => {
  const { listener, agent, dispose } = setup()
  const next = makeNext()
  const exec = makeExec({ name: 'pwsh', args: { command: 'git status' }, agent })
  const result = await listener(exec, next)
  assert.equal(result.kind, 'allow')
  assert.equal(next.calls.length, 1)
  dispose()
})

test('routes ssh to the reviewer and honors reviewer deny', async () => {
  const { listener, agent, llmCalls, dispose } = setup({ reviewerDecision: 'deny', reviewerReason: 'remote state is production data' })
  const next = makeNext()
  const exec = makeExec({ name: 'pwsh', args: { command: 'ssh prod "rm -rf /srv/app"' }, agent })
  const result = await listener(exec, next)
  assert.equal(result.kind, 'deny')
  assert.equal(result.info.code, 'REVIEW_DENY')
  assert.match(result.reason, /production data/)
  assert.equal(llmCalls.length, 1)
  assert.equal(next.calls.length, 0)
  dispose()
})

test('honors reviewer allow', async () => {
  const { listener, agent, dispose } = setup({ reviewerDecision: 'allow' })
  const next = makeNext()
  const exec = makeExec({ name: 'pwsh', args: { command: 'ssh prod "systemctl status app"' }, agent })
  const result = await listener(exec, next)
  assert.equal(result.kind, 'allow')
  assert.equal(next.calls.length, 1)
  dispose()
})

test('investigate is fail-closed in Phase 1', async () => {
  const { listener, agent, dispose } = setup({ reviewerDecision: 'investigate', reviewerReason: 'need facts' })
  const next = makeNext()
  const exec = makeExec({ name: 'pwsh', args: { command: 'ssh prod "cat /etc/app/config"' }, agent })
  const result = await listener(exec, next)
  assert.equal(result.kind, 'deny')
  assert.equal(result.info.code, 'REVIEW_INVESTIGATE')
  assert.equal(next.calls.length, 0)
  dispose()
})

test('investigator can resolve an investigate decision to allow', async () => {
  const subagents = {
    calls: [],
    async startActivation(spec) {
      this.calls.push(spec)
      return {
        childId: 'child-1',
        async dispose() {},
        result: Promise.resolve({
          output: [{ type: 'text', text: '{"decision":"allow","reason":"target is session-created"}' }],
          structured: { decision: 'allow', reason: 'target is session-created' },
          stopReason: 'completed',
        }),
      }
    },
  }
  const { listener, agent, dispose } = setup({
    reviewerDecision: 'investigate',
    investigatorEnabled: true,
    subagents,
  })
  const next = makeNext()
  const result = await listener(makeExec({ name: 'pwsh', args: { command: 'ssh prod "cat /srv/app/config"' }, agent }), next)
  assert.equal(result.kind, 'allow')
  assert.equal(next.calls.length, 1)
  assert.equal(subagents.calls.length, 1)
  assert.equal(subagents.calls[0].request.agentPreset, 'cmd-review-investigator')
  dispose()
})

test('reviewer uses ctx.get(llm) without an llm injection', async () => {
  const { listener, agent, ctx, dispose } = setup({ reviewerDecision: 'deny', reviewerReason: 'review works' })
  Object.defineProperty(ctx, 'llm', {
    configurable: true,
    get() {
      throw new Error("cannot get property 'llm' without inject")
    },
  })
  const next = makeNext()
  const result = await listener(makeExec({ name: 'pwsh', args: { command: 'ssh prod "systemctl status app"' }, agent }), next)
  assert.equal(result.kind, 'deny')
  assert.equal(result.info.code, 'REVIEW_DENY')
  assert.equal(next.calls.length, 0)
  dispose()
})

test('auto preset keeps its own LLM and only runs deterministic deny', async () => {
  const { listener, agent, llmCalls, ctx, dispose } = setup({ preset: 'auto' })
  const next = makeNext()

  const deleteResult = await listener(makeExec({ name: 'pwsh', args: { command: 'rm -rf /workspace/x' }, agent }), next)
  assert.equal(deleteResult.kind, 'deny')
  assert.equal(deleteResult.info.code, 'SHELL_DELETE')
  assert.equal(next.calls.length, 0)
  assert.equal(llmCalls.length, 0)

  const sshResult = await listener(makeExec({ name: 'pwsh', args: { command: 'ssh prod "rm -rf /srv"' }, agent }), next)
  assert.equal(sshResult.kind, 'allow')
  assert.equal(next.calls.length, 1)
  assert.equal(llmCalls.length, 0)
  assert.equal(ctx.services.permissionPresets.current(), 'auto')
  dispose()
})

test('registers a working trash_move tool', async () => {
  const { ctx, workspace, dispose } = setup()
  const source = path.join(workspace, 'old.txt')
  fs.writeFileSync(source, 'move me')
  const tool = ctx.toolsRegistered.find((item) => item.name === 'trash_move')
  const result = await tool.execute({ paths: [source] }, {
    agent: { session: { id: 's1', header: { cwd: workspace } } },
    signal: new AbortController().signal,
  })
  assert.equal(result.ok, true)
  assert.equal(fs.existsSync(source), false)
  assert.equal(fs.existsSync(result.moved[0].to), true)
  dispose()
})

