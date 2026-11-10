/** Apply reviewed shared, role and Work context through the versioned API without waking workers. */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import type { PromptConfig } from '../src/app/prompts.ts'

type Block = 'worker-instructions' | 'worker-tools' | 'worker-delivery' | 'worker-work-addendum'
type Blocks = Record<Block, string>
interface View {
  current: { revision: number; config: PromptConfig }
  parts: { key: string; base: string; text: string }[]
}
interface Preview {
  orchestrator: string
  worker: string
  skills: Record<string, string>
  parts: { worker: { name: string; text: string }[] }
}
const BLOCKS: Block[] = ['worker-instructions', 'worker-tools', 'worker-delivery', 'worker-work-addendum']
const MARKER = '<!-- work-worker-context:v1 -->'
const END = '<!-- /work-worker-context -->'
export const TOOL_SKILL = 'work-project-tools'
export const COLLABORATION_SKILL = 'collaboration'
const SHARED_BLOCKS = ['context-shared', 'context-communication', 'context-scope', 'context-delivery',
  'router-instructions', 'collaboration-tools'] as const
type SharedBlock = typeof SHARED_BLOCKS[number]
type TeamSection = 'communication' | 'scope' | 'delivery'
export interface SharedContext {
  blocks: Record<SharedBlock, string>
  previousTeamHashes: Record<TeamSection, string>
}

function documentBlock(document: string, name: string): string {
  const matches = [...document.matchAll(new RegExp('^```' + name + '\\r?\\n([\\s\\S]*?)^```[ \\t]*$', 'gm'))]
  if (matches.length !== 1 || !matches[0]?.[1]?.trim()) throw new Error(`Expected one nonempty ${name} block`)
  return matches[0][1].replace(/\r\n/g, '\n').trim()
}

export function parseContextDocument(document: string): Blocks {
  const blocks = {} as Blocks
  for (const name of BLOCKS) {
    blocks[name] = documentBlock(document, name)
  }
  return blocks
}

export function parseSharedContext(document: string): SharedContext {
  const blocks = {} as Record<SharedBlock, string>
  for (const name of SHARED_BLOCKS) blocks[name] = documentBlock(document, name)
  const previous: unknown = JSON.parse(documentBlock(document, 'context-migration'))
  const hashes = {} as Record<TeamSection, string>
  for (const name of ['communication', 'scope', 'delivery'] as const) {
    const value: unknown = previous && typeof previous === 'object' && !Array.isArray(previous)
      && Object.hasOwn(previous, name) ? Reflect.get(previous, name) : undefined
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Missing reviewed migration hash: ${name}`)
    hashes[name] = value
  }
  return { blocks, previousTeamHashes: hashes }
}

export const parseProjectMap = (document: string): string => documentBlock(document, 'router-project-map')

function withManagedBlock(previous: string, text: string, marker = MARKER, closing = END): string {
  const start = previous.indexOf(marker)
  let base = previous
  if (start >= 0) {
    const end = previous.indexOf(closing, start)
    if (end < 0 || previous.indexOf(closing) < start || previous.indexOf(marker, start + marker.length) >= 0
      || previous.indexOf(closing, end + closing.length) >= 0) throw new Error('Ambiguous managed context block; review before replacing')
    base = previous.slice(0, start) + previous.slice(end + closing.length)
  } else if (previous.includes(closing)) {
    throw new Error('Ambiguous managed context block; review before replacing')
  }
  return [base.trim(), `${marker}\n${text}\n${closing}`].filter(Boolean).join('\n\n')
}

export function buildContextConfig(view: View, blocks: Blocks): PromptConfig {
  const config = view.current.config
  const overrides = { ...config.overrides }
  for (const [key, block] of [['runtime/worker', 'worker-instructions'], ['runtime/work', 'worker-work-addendum']] as const) {
    const part = view.parts.find(part => part.key === key)
    if (!part) throw new Error(`Missing runtime part: ${key}`)
    const previous = overrides[key]
    overrides[key] = { text: withManagedBlock(previous?.text ?? part.text, blocks[block]), base: previous?.base ?? part.base }
  }
  return { ...config, delivery: withManagedBlock(config.delivery, blocks['worker-delivery']),
    skills: { ...config.skills, [TOOL_SKILL]: blocks['worker-tools'] }, overrides }
}

/** Migrate only reviewed team text; later saves replace managed blocks and preserve human additions around them. */
export function buildLayeredContextConfig(view: View, blocks: Blocks, shared: SharedContext, projectMap: string): PromptConfig {
  const next = buildContextConfig(view, blocks)
  for (const name of ['communication', 'scope', 'delivery'] as const) {
    const marker = `<!-- superagent-team:${name}:v1 -->`, closing = `<!-- /superagent-team:${name} -->`
    const previous = view.current.config[name]
    const hash = createHash('sha256').update(previous).digest('hex')
    if (!previous.includes(marker) && hash !== shared.previousTeamHashes[name]) {
      throw new Error(`Unreviewed team section changed: ${name}; review and retain its authorization before migration`)
    }
    next[name] = withManagedBlock(previous.includes(marker) ? previous : '', shared.blocks[`context-${name}`], marker, closing)
  }
  const overrides = { ...next.overrides }
  for (const [key, label, text] of [
    ['runtime/shared', 'shared', shared.blocks['context-shared']],
    ['runtime/orchestrator', 'router', `${shared.blocks['router-instructions']}\n\n${projectMap}`],
  ] as const) {
    const part = view.parts.find(part => part.key === key)
    if (!part) throw new Error(`Missing runtime part: ${key}`)
    const previous = overrides[key]
    overrides[key] = { text: withManagedBlock(previous?.text ?? part.text, text,
      `<!-- superagent-context:${label}:v1 -->`, `<!-- /superagent-context:${label} -->`), base: previous?.base ?? part.base }
  }
  return { ...next, overrides, skills: { ...next.skills, [COLLABORATION_SKILL]: shared.blocks['collaboration-tools'] } }
}

export interface ProjectIdentity { source: 'github' | 'gitlab'; repository: string; host?: string }
export function assertWorkDeployment(preview: Pick<Preview, 'worker' | 'skills' | 'parts'>,
  expected: ProjectIdentity = { source: 'gitlab', host: 'gitlab.com', repository: 'example/widgets' }): void {
  const environment = preview.parts.worker.find(part => part.name === 'runtime/environment')?.text ?? ''
  const variables = expected.source === 'github'
    ? [['DSH_SUPERAGENT_GITHUB_REPOSITORY', expected.repository]]
    : [['DSH_SUPERAGENT_GITLAB_HOST', expected.host ?? 'gitlab.com'], ['DSH_SUPERAGENT_GITLAB_REPOSITORY', expected.repository]]
  for (const [key, value] of variables) {
    if (!environment.split('\n').some(line => line.startsWith(`- ${key} = ${JSON.stringify(value)}:`))) {
      throw new Error(`Refusing a different or unconfigured deployment: ${key}`)
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, help: { type: 'boolean' },
    source: { type: 'string', default: 'gitlab' }, host: { type: 'string', default: 'gitlab.com' },
    repository: { type: 'string' }, url: { type: 'string', default: 'http://127.0.0.1:3082' } } })
  const usage = 'Usage: node --experimental-strip-types scripts/sync-work-worker-context.ts --repository owner/repo [--source github|gitlab] [--host gitlab.com] [--url http://127.0.0.1:3082] [--apply]'
  if (values.help) { console.log(usage); return }
  if ((values.source !== 'github' && values.source !== 'gitlab') || !values.repository
    || !/^(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+$/.test(values.repository)) throw new Error(usage)
  const target: ProjectIdentity = { source: values.source, repository: values.repository, host: values.host }
  const endpoint = new URL(values.url)
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('The management URL must be a local loopback HTTP origin')
  }
  const root = new URL('../', import.meta.url)
  const document = await readFile(new URL('docs/work-worker-context.md', root), 'utf8')
  const blocks = parseContextDocument(document)
  const sharedDocument = await readFile(new URL('docs/superagent-context.md', root), 'utf8')
  const projectDocument = await readFile(new URL('docs/project-map.md', root), 'utf8')
  const shared = parseSharedContext(sharedDocument), projectMap = parseProjectMap(projectDocument)
  const base = new URL('/orchestrator/api/', endpoint).href
  async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(base + route, { method, signal: AbortSignal.timeout(15000),
      headers: { 'x-orchestrator-request': '1', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!response.ok) throw new Error(`Management API ${method} ${route}: ${response.status}; read current revision before retrying`)
    return await response.json() as T
  }
  const view = await api<View>('prompts')
  const config = buildLayeredContextConfig(view, blocks, shared, projectMap)
  const preview = await api<Preview>('prompts/preview', 'POST', config)
  assertWorkDeployment(preview, target)
  if (!preview.worker.includes(blocks['worker-instructions']) || preview.skills[TOOL_SKILL] !== blocks['worker-tools']
    || preview.skills[COLLABORATION_SKILL] !== shared.blocks['collaboration-tools'] || !preview.orchestrator.includes(projectMap)
    || preview.orchestrator.includes(blocks['worker-instructions'])) {
    throw new Error('Preview did not include the complete reviewed instructions and tools skill')
  }
  const documents = { 'docs/superagent-context.md': sharedDocument, 'docs/project-map.md': projectDocument,
    'docs/work-worker-context.md': document }
  const documentHashes = Object.fromEntries(Object.entries(documents).map(([name, text]) => [name, createHash('sha256').update(text).digest('hex')]))
  const sha256 = createHash('sha256').update(JSON.stringify(documentHashes)).digest('hex')
  const candidate = { config, baseRevision: view.current.revision }
  const artifact = new URL('.artifacts/work-worker-context-candidate.json', root)
  await writeFile(artifact, JSON.stringify({ sha256, documentHashes, ...candidate }, null, 2) + '\n', { mode: 0o600 })
  if (!values.apply) {
    console.log(JSON.stringify({ mode: 'preview', baseRevision: view.current.revision, sha256, candidate: fileURLToPath(artifact),
      routerChars: preview.orchestrator.length, workerChars: preview.worker.length, toolsChars: blocks['worker-tools'].length }))
    return
  }
  if (JSON.stringify(view.current.config) === JSON.stringify(config)) {
    console.log(JSON.stringify({ mode: 'unchanged', revision: view.current.revision, sha256 }))
    return
  }
  const saved = await api<{ revision: number; context_delivery: unknown }>('prompts', 'PUT', candidate)
  const current = await api<View>('prompts')
  if (current.current.revision !== saved.revision || JSON.stringify(current.current.config) !== JSON.stringify(config)) {
    throw new Error('Saved config changed before readback; inspect current revision, do not overwrite it')
  }
  await writeFile(new URL('.artifacts/work-worker-context-applied.json', root), JSON.stringify({ ...saved, sha256,
    previousRevision: view.current.revision, appliedAt: new Date().toISOString(), documents: documentHashes,
    toolSkill: `dsh-superagent-${TOOL_SKILL}`, scope: `${target.source === 'github' ? 'github.com' : target.host}/${target.repository}`, readbackVerified: true }, null, 2) + '\n')
  console.log(JSON.stringify({ mode: 'applied', ...saved, sha256, readbackVerified: true }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
