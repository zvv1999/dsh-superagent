/** GitLab outbound channel: posts idempotent notes on Issues and merge requests under the configured account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { NoteSchema, type GitlabEntity } from './gitlab-trigger.ts'

const gone = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410)
const notePath = (kind: GitlabEntity, iid: number): string => `${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}/notes`

/** Posts a note with a hidden marker; retries find the marker under the agent account before creating another note. */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const gitlab = commands.deployment.gitlab
  if (!gitlab) throw new Error('GitLab Source has no working account')
  const kind = message.channel.address.kind
  const entity: GitlabEntity = kind === 'mr' ? 'mr' : kind === 'issue' ? 'issue' : (() => { throw new Error('Missing GitLab reply kind') })()
  const iid = Number(message.channel.address.iid)
  if (!Number.isInteger(iid) || iid <= 0) throw new Error('Missing GitLab reply target')
  const path = notePath(entity, iid)
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    const mine = (note: z.infer<typeof NoteSchema>) => sameName(note.author.username ?? '', gitlab.login) && (note.body ?? '').includes(marker)
    if ((await commands.gitlabPages(NoteSchema, path)).some(mine)) return 'sent'
    await commands.gitlabApi(z.unknown(), path, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}

/** Returns the retained trigger URL when available; channel addresses always carry one for new GitLab events. */
export function gitlabLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  const kind: GitlabEntity | undefined = address.kind === 'mr' ? 'mr' : address.kind === 'issue' ? 'issue' : undefined
  const iid = Number(address.iid)
  const url = address.url ?? ''
  const label = kind === 'mr' ? `GitLab !${iid}` : kind === 'issue' ? `GitLab #${iid}` : 'GitLab'
  // Keep the import-time adapter independent of Deployment's optional GitLab block; a trigger's URL is authoritative.
  return { url, label: { zh: label, en: label } }
}
