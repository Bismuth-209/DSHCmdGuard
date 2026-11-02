import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function makeTempDir(prefix = 'cmd-guard-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function makeFakeAgent({ cwd, id = 'session-test', events = [] } = {}) {
  return {
    id,
    session: {
      id,
      header: { cwd },
      requestHeader() {
        return { config: { provider: 'test-provider', model: 'test-model' } }
      },
      snapshotEvents() {
        return events
      },
    },
  }
}

export function makeExec({ name = 'pwsh', args = {}, agent, signal } = {}) {
  return {
    name,
    arguments: args,
    agent,
    signal: signal ?? new AbortController().signal,
  }
}

export function makeNext() {
  const calls = []
  async function next() {
    calls.push(true)
    return { kind: 'allow' }
  }
  next.calls = calls
  return next
}

export function textStream(text) {
  return (async function* stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

export function makeFakeCtx({ cwd, preset = 'workspace-write', reviewerDecision = 'deny', reviewerReason = 'test denial', llmCalls = [], subagents } = {}) {
  const listeners = []
  const tools = []
  const sections = []
  const services = {
    permissionPresets: {
      current() {
        return preset
      },
    },
    sandboxPolicy: {
      resolve() {
        return { mode: preset === 'auto' ? 'danger-full-access' : 'workspace-write', workspaceRoot: cwd }
      },
    },
    llm: {
      stream(options) {
        llmCalls.push(options)
        const decision = reviewerDecision === 'deny'
          ? { decision: 'deny', reason: reviewerReason }
          : { decision: reviewerDecision }
        return textStream(JSON.stringify(decision))
      },
    },
    ...(subagents === undefined ? {} : { subagents }),
  }

  const ctx = {
    logger: { info() {}, warn() {} },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {
          const index = tools.indexOf(tool)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {
          const index = sections.indexOf(section)
          if (index >= 0) sections.splice(index, 1)
        }
      },
    },
    get(name) {
      return services[name]
    },
    on(event, listener, options) {
      const entry = { event, listener, options }
      listeners.push(entry)
      return () => {
        const index = listeners.indexOf(entry)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    listeners,
    toolsRegistered: tools,
    sections,
    services,
  }
  return ctx
}

export function findListener(ctx, event = 'tools/pre-execute') {
  const entry = ctx.listeners.find((item) => item.event === event)
  if (entry === undefined) throw new Error(`listener ${event} not registered`)
  return entry.listener
}
