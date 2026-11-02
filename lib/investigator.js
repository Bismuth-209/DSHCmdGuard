/**
 * Read-only subagent investigator for decisions the first reviewer marked as
 * `investigate`. The investigator is a normal in-process child agent with a
 * dedicated read-only preset; it never gets shell or write tools.
 */
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['allow', 'deny', 'uncertain'] },
    reason: { type: 'string' },
  },
  required: ['decision'],
  additionalProperties: false,
}

function truncate(value, max = 240) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (typeof text !== 'string') return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function outputText(result) {
  if (!Array.isArray(result?.output)) return ''
  return result.output
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function verdictOf(result) {
  if (result?.structured !== undefined && result.structured !== null && typeof result.structured === 'object') {
    return result.structured
  }
  const text = outputText(result)
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

function buildPrompt({ agent, exec, policy, sandbox, questions, maxFiles }) {
  return [
    'You are a read-only safety investigator. Inspect only local files and facts inside the session workspace.',
    'You must NOT modify, create, move, or delete any file. Do not use shell tools.',
    `At most ${maxFiles} files may be read. Be brief.`,
    '',
    `Pending tool: ${String(exec.name)}`,
    `Pending arguments: ${truncate(exec.arguments, 4000)}`,
    `Working directory: ${String(sandbox.cwd)}`,
    `Preflight code: ${String(policy.code)}`,
    `Preflight reason: ${String(policy.reason)}`,
    `Facts: ${truncate(policy.facts, 4000)}`,
    `Questions: ${JSON.stringify(questions ?? [])}`,
    '',
    'Decide whether the pending action is safe with respect to deletion and production data.',
    'Return JSON: {"decision":"allow"|"deny"|"uncertain","reason":"short factual reason"}.',
    'Use "uncertain" if the facts still do not decide it. Never claim the action executed.',
  ].join('\n')
}

/**
 * Create the investigator.
 * @param {{config: object, logger?: object}} options
 */
export function createInvestigator({ config, logger }) {
  async function investigate(ctx, { agent, exec, policy, sandbox, signal, questions }) {
    if (config.investigator?.enabled !== true) {
      return { decision: 'deny', code: 'INVESTIGATOR_DISABLED', reason: 'Blocked by cmd guard: investigator is disabled.' }
    }
    const subagents = ctx.get?.('subagents')
    if (typeof subagents?.startActivation !== 'function') {
      return { decision: 'deny', code: 'INVESTIGATOR_UNAVAILABLE', reason: 'Blocked by cmd guard: investigator is unavailable.' }
    }

    const provider = config.investigator.provider ?? 'spawn'
    const agentPreset = config.investigator.agentPreset ?? 'cmd-review-investigator'
    const timeoutMs = config.investigator.timeoutMs ?? 15000
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const fused = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
    let activation
    let timer

    try {
      activation = await subagents.startActivation({
        provider,
        label: 'cmd-guard-review',
        request: {
          parent: agent,
          agentPreset,
          prompt: [{
            type: 'text',
            text: buildPrompt({
              agent,
              exec,
              policy,
              sandbox,
              questions,
              maxFiles: config.investigator.maxFiles ?? 5,
            }),
          }],
          outputSchema: VERDICT_SCHEMA,
          maxDepth: 0,
        },
        delivery: 'caller',
        signal: fused,
      })

      const timeoutResult = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
      })
      // Avoid an unhandled rejection if the timeout wins the race.
      activation.result.catch?.(() => {})
      const result = await Promise.race([activation.result, timeoutResult])
      if (result?.kind === 'timeout') {
        return { decision: 'deny', code: 'INVESTIGATOR_TIMEOUT', reason: 'Blocked by cmd guard: investigation timed out.' }
      }

      const verdict = verdictOf(result)
      const decision = verdict?.decision
      if (!['allow', 'deny', 'uncertain'].includes(decision)) {
        return { decision: 'deny', code: 'INVESTIGATOR_INVALID', reason: 'Blocked by cmd guard: investigator returned no usable verdict.' }
      }
      const reason = truncate(verdict?.reason ?? '')
      if (decision === 'allow') {
        return { decision: 'allow', code: 'INVESTIGATOR_ALLOW', reason: 'Investigator allowed the action.' }
      }
      if (decision === 'deny') {
        return { decision: 'deny', code: 'INVESTIGATOR_DENY', reason: reason === '' ? 'Blocked by cmd guard: investigator denied the action.' : `Blocked by cmd guard: ${reason}` }
      }
      return { decision: 'deny', code: 'INVESTIGATOR_UNCERTAIN', reason: reason === '' ? 'Blocked by cmd guard: investigator could not decide; ask the user.' : `Blocked by cmd guard: ${reason}` }
    } catch (error) {
      logger?.warn?.(`cmd-guard: investigator failed: ${String(error?.message ?? error)}`)
      return { decision: 'deny', code: 'INVESTIGATOR_FAILED', reason: 'Blocked by cmd guard: investigation failed.' }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      try {
        await activation?.dispose?.()
      } catch {
        // best effort
      }
    }
  }

  return { investigate }
}

export const __internal = { VERDICT_SCHEMA, buildPrompt, verdictOf, outputText }
