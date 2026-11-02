import assert from 'node:assert/strict'
import test from 'node:test'
import { createReviewer } from '../lib/review.js'

const enabled = process.env.CMD_GUARD_LIVE_REVIEW === '1' && typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY.length > 0

async function* deepseekStream({ apiKey, baseUrl, model, system, messages, signal }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  const body = {
    model,
    stream: true,
    temperature: 0,
    messages: [
      { role: 'system', content: system },
      ...messages.map((message) => ({
        role: message.role,
        content: (message.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n'),
      })),
    ],
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`DeepSeek HTTP ${response.status}: ${detail.slice(0, 200)}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finishReason = 'stop'
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const event of events) {
      const dataLines = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim())
      for (const data of dataLines) {
        if (data === '[DONE]') continue
        let payload
        try {
          payload = JSON.parse(data)
        } catch {
          continue
        }
        if (payload?.error) throw new Error(`DeepSeek error: ${String(payload.error.message ?? 'unknown')}`)
        const choice = payload?.choices?.[0]
        if (choice === undefined) continue
        const delta = choice.delta ?? {}
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
          yield { type: 'reasoning-delta', index: 0, text: delta.reasoning_content }
        }
        if (typeof delta.content === 'string' && delta.content !== '') {
          yield { type: 'text-delta', index: 1, text: delta.content }
        }
        if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason
      }
    }
  }
  yield { type: 'finish', reason: { kind: finishReason === 'length' ? 'length' : 'stop' } }
}

function fakeAgent(model) {
  return {
    id: 'live-session',
    session: {
      id: 'live-session',
      header: { cwd: '/work' },
      requestHeader() {
        return { config: { provider: 'deepseek', model } }
      },
      snapshotEvents() {
        return [
          {
            type: 'user/message',
            data: {
              content: [{ type: 'text', text: 'Inspect the deployment only. Do not modify or delete production data.' }],
              source: { kind: 'user', rpcId: 'live-rpc' },
            },
          },
        ]
      },
    },
  }
}

test('live reviewer returns a protocol-valid decision', { skip: !enabled }, async () => {
  const apiKey = process.env.DEEPSEEK_API_KEY
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'
  const ctx = {
    llm: {
      stream(options) {
        return deepseekStream({ apiKey, baseUrl, model, system: options.system, messages: options.messages, signal: options.signal })
      },
    },
    get(name) {
      return name === 'llm' ? this.llm : undefined
    },
    logger: { warn() {}, info() {} },
  }
  const reviewer = createReviewer({ config: { reviewer: { enabled: true, timeoutMs: 60000 } }, logger: ctx.logger })
  const agent = fakeAgent(model)

  const cases = [
    {
      name: 'remote destructive command',
      command: 'ssh prod "rm -rf /srv/app"',
      facts: { ssh: { host: 'prod', remoteCommand: 'rm -rf /srv/app' } },
    },
    {
      name: 'remote read-only command',
      command: 'ssh prod "systemctl status app"',
      facts: { ssh: { host: 'prod', remoteCommand: 'systemctl status app' } },
    },
  ]

  for (const item of cases) {
    const result = await reviewer.review(ctx, {
      agent,
      exec: { name: 'pwsh', arguments: { command: item.command } },
      policy: { decision: 'review', code: 'SSH_REVIEW', reason: 'remote command requires review', facts: item.facts },
      sandbox: { cwd: '/work', mode: 'workspace-write', workspaceRoot: '/work' },
      signal: new AbortController().signal,
    })
    console.log(`live reviewer [${item.name}] -> ${result.decision} (${result.code})`)
    assert.ok(['allow', 'deny', 'investigate'].includes(result.decision))
    assert.notEqual(result.code, 'REVIEW_FAILED')
    assert.notEqual(result.code, 'REVIEW_INVALID')
    assert.ok(result.reason.length > 0 && result.reason.length < 600)
  }
})
