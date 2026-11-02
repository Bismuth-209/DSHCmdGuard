import assert from 'node:assert/strict'
import test from 'node:test'
import { createInvestigator } from '../lib/investigator.js'
import { makeExec, makeFakeAgent } from './helpers.mjs'

function makeSubagents({ verdict, timeout = false, fail = false } = {}) {
  const calls = []
  const state = { disposed: false }
  return {
    calls,
    state,
    async startActivation(spec) {
      calls.push(spec)
      if (fail) throw new Error('spawn failed')
      return {
        childId: 'child-1',
        async dispose() {
          state.disposed = true
        },
        result: timeout
          ? new Promise(() => {})
          : Promise.resolve({
              output: [{ type: 'text', text: JSON.stringify(verdict) }],
              structured: verdict,
              stopReason: 'completed',
            }),
      }
    },
  }
}

function makeCtx(subagents) {
  return {
    logger: { warn() {}, info() {} },
    get(name) {
      return name === 'subagents' ? subagents : undefined
    },
  }
}

function makeInput(overrides = {}) {
  return {
    agent: makeFakeAgent({ cwd: '/work' }),
    exec: makeExec({ name: 'pwsh', args: { command: 'ssh prod "rm -rf /srv"' } }),
    policy: { code: 'SSH_REMOTE_DELETE', reason: 'review remote delete', facts: { ssh: { host: 'prod' } } },
    sandbox: { cwd: '/work', mode: 'workspace-write', workspaceRoot: '/work' },
    signal: new AbortController().signal,
    questions: ['Does /srv exist?'],
    ...overrides,
  }
}

test('investigator uses a read-only in-process child with caller delivery', async () => {
  const subagents = makeSubagents({ verdict: { decision: 'allow', reason: 'target is a session-created temp dir' } })
  const investigator = createInvestigator({
    config: { investigator: { enabled: true, provider: 'spawn', agentPreset: 'cmd-review-investigator', timeoutMs: 2000, maxFiles: 3 } },
  })
  const result = await investigator.investigate(makeCtx(subagents), makeInput())
  assert.equal(result.decision, 'allow')
  assert.equal(result.code, 'INVESTIGATOR_ALLOW')
  assert.equal(subagents.calls.length, 1)
  const spec = subagents.calls[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.delivery, 'caller')
  assert.equal(spec.request.agentPreset, 'cmd-review-investigator')
  assert.equal(spec.request.maxDepth, 0)
  assert.ok(spec.request.outputSchema)
  assert.match(spec.request.prompt[0].text, /read-only/i)
  assert.match(spec.request.prompt[0].text, /NOT modify/)
  assert.equal(subagents.state.disposed, true)
})

test('investigator maps deny and uncertain to deny', async () => {
  for (const verdict of [
    { decision: 'deny', reason: 'production database directory' },
    { decision: 'uncertain', reason: 'remote script is opaque' },
  ]) {
    const subagents = makeSubagents({ verdict })
    const investigator = createInvestigator({
      config: { investigator: { enabled: true, timeoutMs: 2000, maxFiles: 3 } },
    })
    const result = await investigator.investigate(makeCtx(subagents), makeInput())
    assert.equal(result.decision, 'deny')
    assert.match(result.reason, /Blocked by cmd guard/)
  }
})

test('investigator times out and disposes the child', async () => {
  const subagents = makeSubagents({ timeout: true })
  const investigator = createInvestigator({
    config: { investigator: { enabled: true, timeoutMs: 50, maxFiles: 3 } },
  })
  const result = await investigator.investigate(makeCtx(subagents), makeInput())
  assert.equal(result.decision, 'deny')
  assert.equal(result.code, 'INVESTIGATOR_TIMEOUT')
  assert.equal(subagents.state.disposed, true)
})

test('investigator fails closed when disabled or unavailable', async () => {
  const disabled = createInvestigator({ config: { investigator: { enabled: false } } })
  const disabledResult = await disabled.investigate(makeCtx(undefined), makeInput())
  assert.equal(disabledResult.code, 'INVESTIGATOR_DISABLED')

  const enabled = createInvestigator({ config: { investigator: { enabled: true, timeoutMs: 100 } } })
  const unavailableResult = await enabled.investigate(makeCtx(undefined), makeInput())
  assert.equal(unavailableResult.code, 'INVESTIGATOR_UNAVAILABLE')

  const failing = createInvestigator({ config: { investigator: { enabled: true, timeoutMs: 100 } } })
  const failedResult = await failing.investigate(makeCtx(makeSubagents({ fail: true })), makeInput())
  assert.equal(failedResult.code, 'INVESTIGATOR_FAILED')
})
