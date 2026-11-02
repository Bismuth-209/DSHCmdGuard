import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { findListener, makeExec, makeFakeAgent, makeFakeCtx, makeNext, makeTempDir } from './helpers.mjs'

const enabled = process.env.CMD_GUARD_REMOTE_LIVE === '1'
  && typeof process.env.REMOTE_SSH_HOST === 'string'
  && process.env.REMOTE_SSH_HOST.length > 0

test('plugin gathers live SSH facts before the reviewer decision', { skip: !enabled }, async () => {
  const host = process.env.REMOTE_SSH_HOST
  const home = makeTempDir('dg-remote-plugin-home-')
  const workspace = makeTempDir('dg-remote-plugin-ws-')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  const llmCalls = []
  const ctx = makeFakeCtx({ cwd: workspace, reviewerDecision: 'deny', reviewerReason: 'remote deletion denied', llmCalls })
  const config = {
    enabled: true,
    commandTools: ['bash', 'pwsh', 'terminal_send'],
    trash: { enabled: true, relativeRoot: 'tmp/.cmd-guard-trash', maxPaths: 20, extraAllowedRoots: [] },
    reviewer: { enabled: true, timeoutMs: 5000 },
    remote: {
      enabled: true,
      allowedHosts: [host],
      user: process.env.REMOTE_SSH_USER ?? 'tester',
      port: 22,
      identityFile: process.env.REMOTE_SSH_KEY ?? '/keys/id_ed25519',
      knownHostsFile: process.env.REMOTE_SSH_KNOWN_HOSTS ?? '/tmp/known_hosts',
      strictHostKeyChecking: 'accept-new',
      probeTimeoutMs: 10000,
      maxProbes: 3,
      maxBytes: 8192,
      failClosed: true,
    },
    investigator: { enabled: false },
    audit: { enabled: true, root: path.join(home, 'audit') },
  }
  const dispose = apply(ctx, config)
  const listener = findListener(ctx)
  const agent = makeFakeAgent({ cwd: workspace })
  const next = makeNext()
  const result = await listener(makeExec({
    name: 'pwsh',
    args: { command: `ssh ${host} "rm -rf /srv/app"` },
    agent,
  }), next)

  assert.equal(result.kind, 'deny')
  assert.equal(result.info.code, 'REVIEW_DENY')
  assert.equal(next.calls.length, 0)
  assert.equal(llmCalls.length, 1)
  const reviewText = llmCalls[0].messages[0].content[0].text
  const input = JSON.parse(reviewText)
  assert.equal(input.preflight.facts.remote.ok, true)
  assert.ok(input.preflight.facts.remote.probes.some((probe) => probe.probe === 'stat' && probe.ok))
  assert.ok(input.preflight.facts.remote.probes.some((probe) => probe.probe === 'list' && probe.ok))
  assert.match(JSON.stringify(input.preflight.facts.remote), /hello from remote|srv\/app/)
  dispose()
})

