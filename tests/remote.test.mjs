import assert from 'node:assert/strict'
import test from 'node:test'
import { createRemoteInspector } from '../lib/remote.js'

function baseConfig(overrides = {}) {
  return {
    remote: {
      enabled: true,
      allowedHosts: ['prod'],
      user: 'tester',
      port: 22,
      identityFile: '/keys/id',
      knownHostsFile: '/tmp/known_hosts',
      strictHostKeyChecking: 'accept-new',
      probeTimeoutMs: 2000,
      maxProbes: 3,
      maxBytes: 4096,
      failClosed: true,
      ...overrides,
    },
  }
}

test('remote inspector builds stat/list probes for a remote deletion', async () => {
  const calls = []
  const inspector = createRemoteInspector({
    config: baseConfig(),
    runner: async ({ host, probe }) => {
      calls.push({ host, probe })
      if (probe.verb === 'stat') return { ok: true, code: 'REMOTE_PROBE_OK', stdout: 'directory|4096|1|/srv/app' }
      return { ok: true, code: 'REMOTE_PROBE_OK', stdout: 'app' }
    },
  })
  const result = await inspector.inspectForCommand({
    host: 'prod',
    remoteCommand: 'rm -rf /srv/app',
    code: 'SSH_REMOTE_DELETE',
  })
  assert.equal(result.ok, true)
  assert.equal(result.code, 'REMOTE_INSPECTED')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].host, 'prod')
  assert.equal(calls[0].probe.verb, 'stat')
  assert.equal(calls[0].probe.target, '/srv/app')
  assert.equal(calls[1].probe.verb, 'list')
  assert.equal(calls[1].probe.target, '/srv/app')
})

test('remote inspector reads remote content when the command asks for it', async () => {
  const calls = []
  const inspector = createRemoteInspector({
    config: baseConfig(),
    runner: async ({ probe }) => {
      calls.push(probe)
      return { ok: true, code: 'REMOTE_PROBE_OK', stdout: 'DATABASE_URL=redacted' }
    },
  })
  const result = await inspector.inspectForCommand({
    host: 'prod',
    remoteCommand: 'cat /srv/app/config',
    code: 'SSH_COMMAND',
  })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].verb, 'read')
  assert.equal(calls[0].target, '/srv/app/config')
})

test('remote inspector builds docker inspect probes', async () => {
  const calls = []
  const inspector = createRemoteInspector({
    config: baseConfig(),
    runner: async ({ probe }) => {
      calls.push(probe)
      return { ok: true, code: 'REMOTE_PROBE_OK', stdout: '[]' }
    },
  })
  const result = await inspector.inspectForCommand({
    host: 'prod',
    remoteCommand: 'docker rm app-container',
    code: 'SSH_COMMAND',
  })
  assert.equal(result.ok, true)
  assert.equal(calls[0].verb, 'docker_inspect')
  assert.equal(calls[0].target, 'app-container')
  assert.equal(calls[0].resourceType, 'container')
})

test('remote inspector denies unlisted hosts and disabled config', async () => {
  const inspector = createRemoteInspector({ config: baseConfig() })
  const denied = await inspector.inspectForCommand({ host: 'other', remoteCommand: 'rm -rf /x', code: 'SSH_REMOTE_DELETE' })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'REMOTE_HOST_NOT_ALLOWED')

  const disabled = createRemoteInspector({ config: baseConfig({ enabled: false }) })
  const disabledResult = await disabled.inspectForCommand({ host: 'prod', remoteCommand: 'rm -rf /x', code: 'SSH_REMOTE_DELETE' })
  assert.equal(disabledResult.ok, false)
  assert.equal(disabledResult.code, 'REMOTE_DISABLED')
})

test('remote inspector reports no targets for an opaque destructive command', async () => {
  const inspector = createRemoteInspector({ config: baseConfig(), runner: async () => ({ ok: true, code: 'REMOTE_PROBE_OK' }) })
  const result = await inspector.inspectForCommand({ host: 'prod', remoteCommand: 'rm -rf *', code: 'SSH_REMOTE_DELETE' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'REMOTE_NO_PROBE_TARGETS')
})
