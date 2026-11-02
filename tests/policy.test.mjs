import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyAction, splitCommandSegments, tokenizeCommand } from '../lib/policy.js'

function decide(command, options = {}) {
  return classifyAction({
    toolName: 'pwsh',
    arguments: { command },
    cwd: options.cwd ?? 'C:\\workspace',
    readScript: options.readScript,
  })
}

test('splits shell segments outside quotes', () => {
  assert.deepEqual(splitCommandSegments('echo "a|b"; rm -rf /x'), ['echo "a|b"', ' rm -rf /x'])
  assert.deepEqual(tokenizeCommand('Remove-Item -LiteralPath "C:\\a b\\c"'), ['Remove-Item', '-LiteralPath', 'C:\\a b\\c'])
})

test('denies direct shell deletion', () => {
  for (const command of [
    'rm -rf /x',
    'rm -rf "$DIR"',
    'Remove-Item -LiteralPath "C:\\x"',
    'Remove-Item -Recurse -Force C:\\x',
    'del C:\\x',
    'erase C:\\x',
    'rd C:\\x',
    'unlink /tmp/x',
    'Get-ChildItem C:\\x | Remove-Item -Recurse -Force',
    'Set-Content x; Remove-Item C:\\x',
    'sudo rm -rf /x',
    'xargs rm',
    'find . -name "*.tmp" -delete',
  ]) {
    const result = decide(command)
    assert.equal(result.decision, 'deny', command)
    assert.ok(['SHELL_DELETE', 'FIND_DELETE'].includes(result.code), `${command}: ${result.code}`)
  }
})

test('allows echo of a destructive word', () => {
  assert.equal(decide('echo "rm -rf /x"').decision, 'allow')
  assert.equal(decide('Write-Output "Remove-Item"').decision, 'allow')
})

test('recursively inspects literal nested shells and rejects opaque ones', () => {
  assert.equal(decide('pwsh -Command "Remove-Item C:\\x"').code, 'NESTED_DELETE')
  assert.equal(decide('bash -c "rm -rf /x"').code, 'NESTED_DELETE')
  assert.equal(decide('cmd /c "del C:\\x"').code, 'NESTED_DELETE')
  assert.equal(decide('bash -c $CMD').code, 'OPAQUE_NESTED_SHELL')
  assert.equal(decide('pwsh -Command $Command').code, 'OPAQUE_NESTED_SHELL')
})

test('reviews scripts with deletion patterns and allows clean scripts', () => {
  const destructive = decide('python cleanup.py', {
    cwd: 'C:\\workspace',
    readScript: () => 'import shutil\nshutil.rmtree("/x")',
  })
  assert.equal(destructive.decision, 'review')
  assert.equal(destructive.code, 'SCRIPT_DELETE')

  const clean = decide('python build.py', {
    cwd: 'C:\\workspace',
    readScript: () => 'print("hello")',
  })
  assert.equal(clean.decision, 'allow')
  assert.equal(clean.code, 'SCRIPT_SCANNED')

  const unreadable = decide('pwsh -File deploy.ps1', {
    cwd: 'C:\\workspace',
    readScript: () => undefined,
  })
  assert.equal(unreadable.decision, 'review')
  assert.equal(unreadable.code, 'SCRIPT_UNREADABLE')
})

test('reviews ssh remote deletion, interactive ssh, and opaque remote commands', () => {
  const remoteDelete = decide('ssh prod "rm -rf /var/data"')
  assert.equal(remoteDelete.decision, 'review')
  assert.equal(remoteDelete.code, 'SSH_REMOTE_DELETE')
  assert.equal(remoteDelete.facts.ssh.host, 'prod')

  const interactive = decide('ssh prod')
  assert.equal(interactive.decision, 'review')
  assert.equal(interactive.code, 'SSH_INTERACTIVE')

  const opaque = decide('ssh prod "bash -s"')
  assert.equal(opaque.decision, 'deny')
  assert.equal(opaque.code, 'SSH_OPAQUE')

  const readOnly = decide('ssh prod "systemctl status app"')
  assert.equal(readOnly.decision, 'review')
  assert.equal(readOnly.code, 'SSH_COMMAND')

  const withUser = decide('ssh tester@192.0.2.10 "docker ps"')
  assert.equal(withUser.facts.ssh.host, '192.0.2.10')
  assert.equal(withUser.facts.ssh.user, 'tester')
})

test('reviews explicit docker deletion and denies broad/opaque forms', () => {
  const explicit = decide('docker rm my-container')
  assert.equal(explicit.decision, 'review')
  assert.equal(explicit.code, 'DOCKER_DELETE')

  const broad = decide('docker system prune -af')
  assert.equal(broad.decision, 'deny')
  assert.equal(broad.code, 'DOCKER_BROAD_DELETE')

  const dynamic = decide('docker rm $(docker ps -aq)')
  assert.equal(dynamic.decision, 'deny')
  assert.equal(dynamic.code, 'DOCKER_BROAD_DELETE')
})

test('reviews git clean and allows dry-run', () => {
  assert.equal(decide('git clean -fd').decision, 'review')
  assert.equal(decide('git clean -nd').decision, 'allow')
  assert.equal(decide('git rm file.txt').decision, 'deny')
})

test('denies dynamic invocation', () => {
  assert.equal(decide('Invoke-Expression $cmd').decision, 'deny')
  assert.equal(decide('& $cmd').decision, 'deny')
})

test('allows ordinary commands and trash_move', () => {
  assert.equal(decide('git status').decision, 'allow')
  assert.equal(decide('Get-ChildItem').decision, 'allow')
  assert.equal(classifyAction({ toolName: 'trash_move', arguments: { paths: ['C:\\workspace\\x'] } }).decision, 'allow')
})

test('danger corpus never allows an obvious shell delete', () => {
  const corpus = [
    'rm -rf /',
    'rm -rf C:\\',
    'rm -rf ..',
    'Remove-Item -Path C:\\ -Recurse -Force',
    'Get-ChildItem | Remove-Item -Recurse',
    'cmd /c rd /s /q C:\\x',
    'powershell -NoProfile -Command "Remove-Item C:\\x"',
    'bash -c "find / -delete"',
    'python -c "import shutil; shutil.rmtree(\'/\')"',
    'node -e "require(\'fs\').rmSync(\'/\',{recursive:true})"',
    'ssh prod "rm -rf /srv"',
    'docker rmi $(docker images -q)',
    'git clean -xfd',
  ]
  for (const command of corpus) {
    const result = decide(command)
    assert.notEqual(result.decision, 'allow', `${command} unexpectedly allowed`)
  }
})
