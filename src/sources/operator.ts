/** Explicit local-owner requests, separate from personal-message context and external reply transports. */
import { z } from 'zod'
import { key, type ReceiveResult, type Trigger } from '../core/index.ts'
import type { SourceKind } from './kind.ts'

export const OPERATOR_SOURCE = 'operator'
export const OPERATOR_ID = 'local-owner'
export const OperatorRequestSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
  text: z.string().trim().min(1).max(30_000),
}).strict()
export type OperatorRequest = z.infer<typeof OperatorRequestSchema>
export interface OperatorReceipt { triggerId: string; result: ReceiveResult }
/** A request key cannot silently replace the owner's original task with different instructions. */
export class OperatorRequestConflict extends Error {}

export const operatorKind: SourceKind = {
  kind: OPERATOR_SOURCE, title: { zh: '本机派单', en: 'Local requests' },
  description: { zh: '仅接收本机操作者明确提交的任务，经现有评估、工单和 Worker 执行；不向 IM 发消息。',
    en: 'Explicit local-owner requests through existing Eval, Tickets and workers; no IM delivery.' },
  schema: z.object({}).strict(), fields: [], health: [],
  scope: ({ meta }) => meta.origin === 'local-management' ? { listened: true, observed: false }
    : { listened: false, reason: 'not_local_request' },
}

/** The same-origin management route fixes source, actor and addressing; callers supply only a deduplication ID and request. */
export class OperatorRequests {
  constructor(private readonly host: {
    get(id: string): Trigger | undefined
    receive(trigger: Trigger): ReceiveResult
  }) {}
  submit(value: OperatorRequest): OperatorReceipt {
    const input = OperatorRequestSchema.parse(value), triggerId = key('operator-request', input.id)
    const previous = this.host.get(triggerId)
    if (previous && previous.text !== input.text) throw new OperatorRequestConflict('Request ID already contains different text')
    const trigger: Trigger = { id: triggerId, source: OPERATOR_SOURCE,
      actor: { source: OPERATOR_SOURCE, id: OPERATOR_ID }, human: true, addressed: 'direct',
      threads: [{ source: OPERATOR_SOURCE, id: input.id }], at: new Date().toISOString(), text: input.text,
      meta: { origin: 'local-management', requestId: input.id } }
    return { triggerId, result: this.host.receive(trigger) }
  }
}
