import assert from 'node:assert/strict'
import test from 'node:test'
import { createRemoteInspector } from '../lib/remote.js'

const enabled = process.env.CMD_GUARD_REMOTE_LIVE === '1'
  && typeof process.env.REMOTE_SSH_HOST === 'string'
  && process.env.REMOTE_SSH_HOST.length > 0

test('live SSH probe reads real remote facts inside the Docker network', { skip: !enabled }, async () => {
  const host = process.env.REMOTE_SSH_HOST
  const config = {
    remote: {
      enabled: true,
      allowedHosts: [host],
      user: process.env.REMOTE_SSH_USER ?? 'tester',
      port: Number(process.env.REMOTE_SSH_PORT ?? 22),
      identityFile: process.env.REMOTE_SSH_KEY ?? '/keys/id_ed25519',
      knownHostsFile: process.env.REMOTE_SSH_KNOWN_HOSTS ?? '/tmp/known_hosts',
      strictHostKeyChecking: 'accept-new',
      probeTimeoutMs: 10000,
      maxProbes: 3,
      maxBytes: 8192,
      failClosed: true,
    },
  }
  const inspector = createRemoteInspector({ config })

  const deleteFacts = await inspector.inspectForCommand({
    host,
    remoteCommand: 'rm -rf /srv/app',
    code: 'SSH_REMOTE_DELETE',
  })
  console.log('live remote delete probes:', deleteFacts.probes.map((probe) => `${probe.probe}:${probe.target}:${probe.ok ? 'ok' : probe.code}`).join(', '))
  assert.equal(deleteFacts.ok, true)
  assert.ok(deleteFacts.probes.some((probe) => probe.probe === 'stat' && probe.ok && /directory/i.test(probe.stdout ?? '')))
  assert.ok(deleteFacts.probes.some((probe) => probe.probe === 'list' && probe.ok && /config/.test(probe.stdout ?? '')))

  const readFacts = await inspector.inspectForCommand({
    host,
    remoteCommand: 'cat /srv/app/config',
    code: 'SSH_COMMAND',
  })
  console.log('live remote read probes:', readFacts.probes.map((probe) => `${probe.probe}:${probe.target}:${probe.ok ? 'ok' : probe.code}`).join(', '))
  assert.equal(readFacts.ok, true)
  assert.ok(readFacts.probes.some((probe) => probe.probe === 'read' && probe.ok && /hello from remote/.test(probe.stdout ?? '')))

  const dockerFacts = await inspector.inspectForCommand({
    host,
    remoteCommand: 'docker rm app-container',
    code: 'SSH_REMOTE_DELETE',
  })
  console.log('live remote docker probe:', dockerFacts.probes.map((probe) => `${probe.probe}:${probe.target}:${probe.ok ? 'ok' : probe.code}`).join(', '))
  assert.ok(dockerFacts.probes.some((probe) => probe.probe === 'docker_inspect'))
  // The disposable SSH server has no Docker daemon; the probe must fail
  // gracefully and must not pretend the remote state was verified.
  assert.equal(dockerFacts.ok, false)
  assert.ok(dockerFacts.probes.some((probe) => probe.probe === 'docker_inspect' && probe.ok === false))
})
