/**
 * Compact LLM reviewer for ambiguous destructive commands.
 *
 * This is intentionally smaller than the full auto-review snapshot: it sends
 * recent user instructions, project constraints, recent tool-call facts and
 * the deterministic preflight facts. It never includes tool outputs, assistant
 * reasoning, or raw reviewer chains.
 */
const REVIEW_SYSTEM = `You are a safety reviewer for one pending destructive operation in a coding-agent session.
Decide whether the pending action may execute, based only on the supplied task context and facts.

Return exactly one JSON object and no other text:
{"decision":"allow"}
{"decision":"deny","reason":"short factual reason"}
{"decision":"investigate","reason":"short reason","questions":["..."]}

Rules:
- Shell deletion is disabled; a valid cleanup uses trash_move. If the pending action is a shell delete, deny.
- Deny if a deletion target is a protected path, outside the workspace without explicit authorization, or ambiguous.
- Deny if the action is a broad/recursive deletion of pre-existing production data, docker resources, or environments without explicit user authorization.
- Allow exact cleanup of files the session clearly created, ordinary build artifacts, and read-only inspection.
- Use investigate only when essential facts are missing and a read-only investigator could resolve them. Do not investigate what the supplied facts already decide.
- Never invent authorization. A user's earlier instruction can authorize only the exact action, target and scope it states.
- Keep reason short and factual; do not include a remediation essay.`

function asString(value) {
  return typeof value === 'string' ? value : ''
}

function truncate(value, max = 1200) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (typeof text !== 'string') return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function safeEvents(agent) {
  try {
    return typeof agent?.session?.snapshotEvents === 'function' ? agent.session.snapshotEvents() : []
  } catch {
    return []
  }
}

function textFromContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function buildContext(agent, exec, policy, sandbox) {
  const events = safeEvents(agent)
  const userMessages = []
  const projectInstructions = []
  const toolCalls = []

  for (const event of events) {
    if (event?.type === 'user/message') {
      const text = textFromContent(event.data?.content).trim()
      if (text === '') continue
      if (event.data?.source?.kind === 'agent-instructions') {
        projectInstructions.push({ role: 'constraint', text: truncate(text, 800) })
      } else if (event.data?.source?.kind === 'user' || event.data?.source?.kind === 'agent-message') {
        userMessages.push({
          role: event.data?.source?.kind === 'agent-message' ? 'parent-instruction' : 'human-instruction',
          rpcId: typeof event.data?.source?.rpcId === 'string' ? event.data.source.rpcId : undefined,
          text: truncate(text, 800),
        })
      }
      continue
    }
    if (event?.type === 'tool/call') {
      toolCalls.push({
        name: asString(event.data?.name),
        arguments: truncate(event.data?.arguments, 300),
      })
    }
  }

  return {
    cwd: sandbox.cwd,
    sandbox: { mode: sandbox.mode, workspaceRoot: sandbox.workspaceRoot },
    projectInstructions: projectInstructions.slice(-6),
    recentUserMessages: userMessages.slice(-12),
    recentToolCalls: toolCalls.slice(-12),
    preflight: {
      decision: policy.decision,
      code: policy.code,
      reason: policy.reason,
      facts: policy.facts,
    },
    pendingAction: {
      name: exec.name,
      arguments: truncate(exec.arguments, 4000),
    },
  }
}

function ensureBlock(blocks, index, type) {
  let block = blocks.get(index)
  if (block === undefined) {
    block = { type, text: '' }
    blocks.set(index, block)
  }
  return block
}

async function readDecisionText(stream) {
  const blocks = new Map()
  let finish
  let sawChunk = false
  for await (const chunk of stream) {
    sawChunk = true
    if (chunk?.type === 'block-start') {
      ensureBlock(blocks, chunk.index, chunk.blockType)
      continue
    }
    if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') {
      const block = ensureBlock(blocks, chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
      block.text += asString(chunk.text)
      continue
    }
    if (chunk?.type === 'block-end') {
      const block = ensureBlock(blocks, chunk.index, chunk.block?.type ?? 'text')
      if (typeof chunk.block?.text === 'string') block.text = chunk.block.text
      continue
    }
    if (chunk?.type === 'finish') {
      finish = chunk.reason
      continue
    }
  }
  if (!sawChunk) throw new Error('reviewer emitted no stream chunks')
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    const failure = finish.failure ?? {}
    throw new Error(`reviewer ended with ${finish.kind} ${failure.code ?? ''}: ${failure.message ?? ''}`)
  }
  if (finish !== undefined && finish.kind !== 'stop') throw new Error(`reviewer ended with ${finish.kind}`)
  let text
  for (const block of blocks.values()) {
    if (block.type === 'text' && block.text.trim() !== '') text = block.text
  }
  if (text === undefined) throw new Error('reviewer emitted no text decision')
  return text
}

function parseDecision(text) {
  let normalized = text.trim()
  const fence = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence !== null) normalized = fence[1].trim()
  const value = JSON.parse(normalized)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('reviewer output must be one JSON object')
  }
  const decision = value.decision
  if (!['allow', 'deny', 'investigate'].includes(decision)) {
    throw new Error('reviewer decision must be allow, deny, or investigate')
  }
  const reason = typeof value.reason === 'string' ? value.reason.slice(0, 240) : undefined
  if (decision === 'allow' && reason !== undefined && reason.length > 0) {
    // Allow with a rationale is accepted; the rationale is audit-only.
  }
  if (decision === 'deny' && (reason === undefined || reason.trim() === '')) {
    throw new Error('reviewer deny requires a short reason')
  }
  return { decision, reason, questions: Array.isArray(value.questions) ? value.questions.slice(0, 4).map((item) => truncate(item, 200)) : undefined }
}

/**
 * Create the reviewer.
 * @param {{config: object, logger?: object}} options
 */
export function createReviewer({ config, logger }) {
  async function review(ctx, { agent, exec, policy, sandbox, signal }) {
    if (config.reviewer?.enabled === false) {
      return { decision: 'deny', code: 'REVIEW_DISABLED', reason: 'Blocked by cmd guard: review is required but disabled.' }
    }
    // `ctx.get()` is safe without declaring an `llm` injection; reading the
    // `ctx.llm` property directly throws "without inject" in Cordis and would
    // break every reviewed SSH command.
    const llm = ctx?.get?.('llm')
    if (llm?.stream === undefined) {
      return { decision: 'deny', code: 'REVIEW_UNAVAILABLE', reason: 'Blocked by cmd guard: reviewer is unavailable.' }
    }
    const header = agent?.session?.requestHeader?.()
    const provider = header?.config?.provider
    const model = header?.config?.model
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
      return { decision: 'deny', code: 'REVIEW_NO_ROUTE', reason: 'Blocked by cmd guard: no reviewer route.' }
    }

    const timeoutMs = config.reviewer?.timeoutMs ?? 20000
    const timeout = AbortSignal.timeout(timeoutMs)
    const fused = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const input = buildContext(agent, exec, policy, sandbox)
    let text
    try {
      const stream = llm.stream({
        provider,
        model,
        system: REVIEW_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] }],
        temperature: 0,
        signal: fused,
      })
      text = await readDecisionText(stream)
    } catch (error) {
      logger?.warn?.(`cmd-guard: reviewer failed: ${String(error?.message ?? error)}`)
      return { decision: 'deny', code: 'REVIEW_FAILED', reason: 'Blocked by cmd guard: review failed or timed out.' }
    }

    let parsed
    try {
      parsed = parseDecision(text)
    } catch (error) {
      logger?.warn?.(`cmd-guard: reviewer output invalid: ${String(error?.message ?? error)}`)
      return { decision: 'deny', code: 'REVIEW_INVALID', reason: 'Blocked by cmd guard: review could not be completed.' }
    }

    if (parsed.decision === 'allow') {
      return { decision: 'allow', code: 'REVIEW_ALLOW', reason: 'Reviewer allowed the action.' }
    }
    if (parsed.decision === 'investigate') {
      return {
        decision: 'investigate',
        code: 'REVIEW_INVESTIGATE',
        reason: 'Blocked by cmd guard: facts are insufficient for a decision.',
        investigate: { reason: parsed.reason, questions: parsed.questions },
      }
    }
    return {
      decision: 'deny',
      code: 'REVIEW_DENY',
      reason: `Blocked by cmd guard: ${parsed.reason ?? 'reviewer denied the action'}`,
    }
  }

  return { review }
}

export const __internal = { buildContext, readDecisionText, parseDecision, REVIEW_SYSTEM }
