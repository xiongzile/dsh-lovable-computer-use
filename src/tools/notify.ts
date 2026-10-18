/** Explicit notification tool. */

import type { ToolDefinition } from '../context.js'
import { objectSchema, openObjectSchema, parseArgs } from '../schema.js'
import type { ResolvedConfig } from '../config.js'
import { notifyUser } from '../util/notify.js'
import { throwIfAborted } from '../util/async.js'

/** Register the notification tool. */
export function registerNotifyTool(config: ResolvedConfig): ToolDefinition[] {
  return [{
    name: 'notify_user',
    description: 'Send a macOS notification without activating an application or stealing focus. '
      + 'Use sparingly for a completed background task or a human step that is now required; do not use it as a progress log.',
    parameters: objectSchema({
      title: { type: 'string', required: true, description: 'Short title (max 200 characters).' },
      message: { type: 'string', required: true, description: 'One or two lines of actionable text.' },
    }),
    output: {
      schema: openObjectSchema({
        delivered: { type: 'boolean', required: true },
        error: { type: 'string' },
      }),
      render: (_args, value) => {
        const result = value as { delivered: boolean; error?: string }
        return [{ type: 'text', text: result.delivered ? 'Notification delivered.' : `Notification not delivered: ${result.error ?? 'unknown reason'}` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(rawArgs, exec) {
      throwIfAborted(exec.signal)
      const args = parseArgs('notify_user', this.parameters, rawArgs)
      if (!config.notifications) return { delivered: false, error: 'notifications are disabled by config.notifications' }
      return notifyUser(String(args.title), String(args.message))
    },
  }]
}
