/** Model-facing foreground-interruption evidence tools. */

import type { ToolDefinition } from '../context.js'
import { objectSchema, openObjectSchema, parseArgs } from '../schema.js'
import { FocusGuard, type FocusReport } from '../focus/guard.js'
import { sampleForeground } from '../focus/sampler.js'
import type { ResolvedConfig } from '../config.js'
import { throwIfAborted } from '../util/async.js'

/** Register focus measurement tools. */
export function registerFocusTools(input: { config: ResolvedConfig; guard: FocusGuard }): ToolDefinition[] {
  const { config, guard } = input
  const tools: ToolDefinition[] = []

  tools.push({
    name: 'foreground_app',
    description: 'Read the current frontmost macOS application and pointer position once. It neither activates an app nor requires Accessibility permission. Use it to establish a baseline before background work.',
    parameters: objectSchema({}),
    output: {
      schema: openObjectSchema({
        supported: { type: 'boolean', required: true },
        bundleId: { type: 'string', required: true },
        name: { type: 'string', required: true },
        pid: { type: 'integer', required: true },
        pointer: { type: 'object', additionalProperties: true },
        chromeProcesses: { type: 'array', required: true, items: { type: 'string' } },
        error: { type: 'string' },
      }),
      render: (_args, value) => {
        const sample = value as Awaited<ReturnType<typeof sampleForeground>>
        if (!sample.supported) return [{ type: 'text', text: `Foreground observation unavailable: ${sample.error ?? 'unknown reason'}` }]
        const pointer = sample.pointer === undefined ? '' : ` pointer=(${Math.round(sample.pointer.x)}, ${Math.round(sample.pointer.y)})`
        return [{ type: 'text', text: `Frontmost: ${sample.name} (${sample.bundleId}, pid ${sample.pid})${pointer}${sample.chromeProcesses.length === 0 ? '' : `\nChromium-family apps running: ${sample.chromeProcesses.join(', ')}`}` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(rawArgs, exec) {
      throwIfAborted(exec.signal)
      parseArgs('foreground_app', this.parameters, rawArgs)
      return sampleForeground()
    },
  })

  tools.push({
    name: 'focus_guard',
    description: 'Measure whether a background operation steals the user\'s foreground focus. '
      + 'action=start records a baseline and samples the frontmost application and pointer every interval; action=status returns the partial observation; action=stop returns transitions, pointer movement, and a verdict. '
      + 'Headless browser work must produce no-interruption. A visible handoff is expected to change focus, so list its bundle id in expectedBundleIds. Transitions are observations, not proof of causation.',
    parameters: objectSchema({
      action: { type: 'string', required: true, enum: ['start', 'status', 'stop'], description: 'Measurement action.' },
      id: { type: 'string', description: 'Guard id for status/stop; omitted uses the active guard.' },
      label: { type: 'string', description: 'What is being measured, e.g. "headless registration".' },
      expectedBundleIds: { type: 'array', items: { type: 'string' }, description: 'Bundle ids whose focus changes are expected (for example the isolated Chrome bundle during an approved handoff).' },
    }),
    output: {
      schema: openObjectSchema({
        action: { type: 'string', required: true },
        id: { type: 'string' },
        verdict: { type: 'string' },
        report: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) => {
        const result = value as { action: string; id?: string; verdict?: string; report?: FocusReport | Record<string, unknown> }
        if (result.action === 'stop' && result.report !== undefined && 'interruptions' in result.report) {
          const report = result.report as FocusReport
          const transitions = report.transitions.length === 0
            ? 'no foreground transitions'
            : report.transitions.map(transition => `${transition.at}: ${transition.from.name} → ${transition.to.name}${transition.expected ? ' (expected)' : ''}`).join('\n')
          return [{
            type: 'text',
            text: [
              `Focus guard ${report.id} (${report.label}) stopped after ${report.durationMs}ms with ${report.samples} sample(s).`,
              `Verdict: ${report.verdict}`,
              `Baseline: ${report.baseline?.name ?? '(unavailable)'} (${report.baseline?.bundleId ?? '?'})`,
              `Pointer: ${report.pointer.sampling}; movement ${report.pointer.movedPx === undefined ? 'unknown' : `${Math.round(report.pointer.movedPx)}px`}`,
              transitions,
              report.note,
            ].join('\n'),
          }]
        }
        return [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(rawArgs, exec) {
      throwIfAborted(exec.signal)
      const args = parseArgs('focus_guard', this.parameters, rawArgs)
      const action = String(args.action)
      if (action === 'start') {
        const label = typeof args.label === 'string' && args.label.length > 0 ? args.label : 'background work'
        const expected = Array.isArray(args.expectedBundleIds)
          ? args.expectedBundleIds.filter((value): value is string => typeof value === 'string')
          : []
        const started = await guard.start(label, expected)
        return { action, id: started.id, baseline: started.baseline, intervalMs: config.focusIntervalMs }
      }
      if (action === 'status') {
        return { action, report: guard.status(typeof args.id === 'string' ? args.id : undefined) }
      }
      if (action === 'stop') {
        const report = guard.stop(typeof args.id === 'string' ? args.id : undefined)
        return { action, id: report.id, verdict: report.verdict, report }
      }
      throw new Error(`unknown focus_guard action ${JSON.stringify(action)}`)
    },
  })

  return tools
}
