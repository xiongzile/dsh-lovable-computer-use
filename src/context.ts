/**
 * Structural types for the small slice of the DeepSeek Harness plugin API this
 * package uses. The package deliberately has no runtime import of dsh
 * packages: the desktop application may carry a different (and hoisted) copy
 * of every `@deepseek-ai/*` package, so the plugin only receives the host's
 * context object and calls the documented service methods on it.
 */

/** One model-facing text block produced by a tool renderer. */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/** JSON Schema subset accepted by `ctx.tools.register()`. */
export interface JsonSchemaNode {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  oneOf?: JsonSchemaNode[]
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchemaNode
  enum?: Array<string | number | boolean | null>
  const?: string | number | boolean | null
  description?: string
  title?: string
  default?: unknown
  examples?: unknown
}

/** One canonical tool output projection. */
export interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode
  render(args: unknown, value: unknown): TextBlock[]
}

/** The tool contract `ctx.tools.register()` accepts. */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchemaNode
  readonly output: ToolOutputDefinition
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  isConcurrencySafe?(args: unknown): boolean
}

/** Host agent view available to a running tool call. */
export interface AgentLike {
  readonly id: string
  readonly session?: {
    readonly id?: string
    readonly header?: {
      readonly cwd?: string
    }
  }
}

/** Host execution context passed to `execute()`. */
export interface ToolRunContext {
  readonly signal: AbortSignal
  readonly agent?: AgentLike
}

/** One question the host can show to the human. */
export interface UserQuestion {
  id: string
  question: string
  header?: string
  detail?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}

/** Answer returned by the host's human-interaction seam. */
export interface UserQuestionAnswer {
  answers: Array<{
    id: string
    selected: string[]
    custom?: string
  }>
}

/** `ctx.userQuestions` as used by browser handoff and host decisions. */
export interface UserQuestionsService {
  ask(request: {
    questions: UserQuestion[]
    agent?: AgentLike
    signal?: AbortSignal
  }): Promise<UserQuestionAnswer>
}

/** `ctx.systemPrompt` as used to add model guidance. */
export interface SystemPromptService {
  getSectionOrder?(name: string): number
  section(section: {
    name: string
    order: number
    text: string | ((context: unknown) => string)
    interpolate?: boolean
  }): () => void
}

/** The Cordis context slice consumed by {@link apply}. */
export interface PluginContext {
  readonly tools: {
    register(definition: ToolDefinition): () => void
  }
  get(name: string): unknown
  effect?(execute: () => void | (() => void | Promise<void>)): unknown
  readonly systemPrompt?: SystemPromptService
}
