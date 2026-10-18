/** Shared human-interaction helper for browser and task handoff tools. */

import type { PluginContext, ToolRunContext, UserQuestion, UserQuestionsService } from '../context.js'
import type { Logger } from '../util/log.js'

/** Result of asking the host's human-interaction seam. */
export interface AskedResult {
  answered: boolean
  selected: string[]
  custom?: string
  unavailable?: string
}

/** Read the optional user-questions seam without assuming a profile mounts one. */
export function userQuestionsService(ctx: PluginContext): UserQuestionsService | undefined {
  const candidate = ctx.get('userQuestions')
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const service = candidate as Partial<UserQuestionsService>
  return typeof service.ask === 'function' ? service as UserQuestionsService : undefined
}

/**
 * Ask one question and return the human's answer.
 * @param ctx - plugin context.
 * @param exec - tool execution identity (agent and cancellation).
 * @param question - question to present.
 * @param logger - diagnostic sink.
 * @returns the answer, or an availability diagnostic instead of throwing.
 */
export async function askHuman(
  ctx: PluginContext,
  exec: ToolRunContext,
  question: UserQuestion,
  logger: Logger,
): Promise<AskedResult> {
  const service = userQuestionsService(ctx)
  if (service === undefined) {
    return {
      answered: false,
      selected: [],
      unavailable: 'this profile has no user-questions provider; ask the question with the ask_user_question tool, keep task status waiting_for_user, and continue after the user answers',
    }
  }
  try {
    const answer = await service.ask({
      questions: [question],
      ...exec.agent === undefined ? {} : { agent: exec.agent },
      signal: exec.signal,
    })
    const item = answer.answers.find(candidate => candidate.id === question.id) ?? answer.answers[0]
    return {
      answered: true,
      selected: item?.selected ?? [],
      ...item?.custom === undefined ? {} : { custom: item.custom },
    }
  } catch (error) {
    if (exec.signal.aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    logger.warn('user question unavailable', { questionId: question.id, error: message })
    return { answered: false, selected: [], unavailable: message }
  }
}
