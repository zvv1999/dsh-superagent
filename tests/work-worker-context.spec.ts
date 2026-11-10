import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { assertWorkDeployment, buildContextConfig, buildLayeredContextConfig, parseContextDocument,
  parseSharedContext, parseProjectMap, TOOL_SKILL, COLLABORATION_SKILL } from '../scripts/sync-work-worker-context.ts'
import { Prompts, defaultPrompts, type PromptConfig } from '../src/app/prompts.ts'
import { Store } from '../src/app/store.ts'

const document = readFileSync(new URL('../docs/work-worker-context.md', import.meta.url), 'utf8')
const blocks = parseContextDocument(document)
const sharedDocument = readFileSync(new URL('../docs/superagent-context.md', import.meta.url), 'utf8')
const shared = parseSharedContext(sharedDocument)
const projectDocument = readFileSync(new URL('../docs/project-map.md', import.meta.url), 'utf8')
const projectMap = parseProjectMap(projectDocument)
const reviewed = (config: PromptConfig) => ({ ...shared, previousTeamHashes: {
  communication: createHash('sha256').update(config.communication).digest('hex'),
  scope: createHash('sha256').update(config.scope).digest('hex'),
  delivery: createHash('sha256').update(config.delivery).digest('hex'),
} })
const viewOf = (prompts: Prompts, config: PromptConfig) => ({ current: { revision: 0, config },
  parts: Object.values(prompts.preview(config).parts).flat().map(part => ({
    key: 'key' in part ? part.key : part.name, text: part.text, base: 'current-base',
  })) })
const variables = () => [
  { key: 'DSH_SUPERAGENT_GITLAB_HOST', value: 'gitlab.com', owner: 'gitlab', description: { zh: '地址', en: 'Host' } },
  { key: 'DSH_SUPERAGENT_GITLAB_REPOSITORY', value: 'example/widgets', owner: 'gitlab', description: { zh: '仓库', en: 'Repository' } },
]

it('matches a caller-selected GitHub repository or custom GitLab host without inheriting the example identity', () => {
  const preview = (text: string) => ({ worker: '', skills: {}, parts: { worker: [{ name: 'runtime/environment', text }] } })
  const github = preview('- DSH_SUPERAGENT_GITHUB_REPOSITORY = "owner/project": Repository.')
  expect(() => assertWorkDeployment(github, { source: 'github', repository: 'owner/project' })).not.toThrow()
  expect(() => assertWorkDeployment(github, { source: 'github', repository: 'another/project' })).toThrow('Refusing')
  expect(() => assertWorkDeployment(github, { source: 'gitlab', repository: 'owner/project' })).toThrow('Refusing')
  const gitlab = preview('- DSH_SUPERAGENT_GITLAB_HOST = "gitlab.example.com:8443": Host.\n- DSH_SUPERAGENT_GITLAB_REPOSITORY = "team/project": Repository.')
  expect(() => assertWorkDeployment(gitlab, { source: 'gitlab', host: 'gitlab.example.com:8443', repository: 'team/project' })).not.toThrow()
  expect(() => assertWorkDeployment(gitlab, { source: 'gitlab', host: 'gitlab.com', repository: 'team/project' })).toThrow('Refusing')
})

it('ships initial context migration hashes for the actual bundled defaults rather than a private deployment', () => {
  const config = defaultPrompts()
  for (const name of ['communication', 'scope', 'delivery'] as const) {
    expect(shared.previousTeamHashes[name]).toBe(createHash('sha256').update(config[name]).digest('hex'))
  }
})

it('preserves deployment-specific authorization, unrelated overrides and skills when adding Work context', () => {
  const dir = mkdtempSync(join(tmpdir(), 'work-context-'))
  const store = new Store(join(dir, 'db'))
  try {
    const prompts = new Prompts(store, () => 100000, variables, () => false, () => 'gitlab')
    const config = { ...defaultPrompts(), delivery: 'Local patches only; never push.', skills: { existing: 'Keep this skill.' },
      overrides: { 'runtime/worker': { text: 'Retain existing role instructions.', base: 'previous-base' },
        'runtime/replies': { text: 'Preserve existing reply policy.' } } }
    const preview = prompts.preview(config)
    const next = buildContextConfig({ current: { revision: 1, config }, parts: preview.parts.worker.map(part => ({ key: 'key' in part ? part.key : part.name,
      text: part.text, base: 'current-base' })) }, blocks)
    expect(next.delivery).toContain(config.delivery)
    expect(next.communication).toBe(config.communication)
    expect(next.scope).toBe(config.scope)
    expect(next.skills.existing).toBe('Keep this skill.')
    expect(next.overrides?.['runtime/replies']).toEqual(config.overrides['runtime/replies'])
    expect(next.overrides?.['runtime/worker']?.base).toBe('previous-base')
    expect(next.overrides?.['runtime/worker']?.text).toContain('Retain existing role instructions.')
    const again = buildContextConfig({ current: { revision: 2, config: next }, parts: preview.parts.worker.map(part => ({
      key: 'key' in part ? part.key : part.name, text: part.text, base: 'current-base' })) }, blocks)
    expect(again).toEqual(next)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('restores the complete worker context and callable skill after a persistent prompt store is reopened', () => {
  const dir = mkdtempSync(join(tmpdir(), 'work-context-recovery-'))
  let store = new Store(join(dir, 'db'))
  try {
    let prompts = new Prompts(store, () => 100000, variables, () => false, () => 'gitlab')
    const view = { current: prompts.current(), parts: Object.values(prompts.preview(defaultPrompts()).parts).flat()
      .map(part => ({ key: 'key' in part ? part.key : part.name, text: part.text, base: 'current-base' })) }
    const config = buildContextConfig(view, blocks)
    prompts.save(config, 0, 'panel')
    store.close()
    store = new Store(join(dir, 'db'))
    prompts = new Prompts(store, () => 100000, variables, () => false, () => 'gitlab')
    const preview = prompts.preview(prompts.current().config)
    assertWorkDeployment(preview)
    expect(preview.worker).toContain(blocks['worker-instructions'])
    expect(preview.worker).toContain(blocks['worker-work-addendum'])
    expect(preview.worker).toContain(blocks['worker-delivery'])
    expect(preview.skills[TOOL_SKILL]).toBe(blocks['worker-tools'])
    expect(preview.skills).toHaveProperty('gitlab')
    expect(preview.orchestrator).not.toContain('## Project engineering contract')
    expect(prompts.current().revision).toBe(1)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('refuses the wrong project or a missing generated environment and ambiguous document blocks', () => {
  for (const text of ['', '- DSH_SUPERAGENT_GITLAB_HOST = "gitlab.com": Host.\n- DSH_SUPERAGENT_GITLAB_REPOSITORY = "another/project": Repository.']) {
    expect(() => assertWorkDeployment({ worker: '', skills: {}, parts: { worker: [{ name: 'runtime/environment', text }] } })).toThrow('Refusing')
  }
  expect(() => parseContextDocument(document.replace('```worker-tools', '```other'))).toThrow('worker-tools')
  expect(() => parseContextDocument(`${document}\n\x60\x60\x60worker-tools\nDuplicate\n\x60\x60\x60\n`)).toThrow('worker-tools')
  expect(parseContextDocument(document.replace(/\n/g, '\r\n'))).toEqual(blocks)
})

it('assembles a compact router map and mandatory worker loaders while retaining the full project guide on demand', () => {
  const dir = mkdtempSync(join(tmpdir(), 'layered-context-'))
  const store = new Store(join(dir, 'db'))
  try {
    const prompts = new Prompts(store, () => 100000, variables, () => false, () => 'gitlab')
    const config = defaultPrompts()
    const next = buildLayeredContextConfig(viewOf(prompts, config), blocks, reviewed(config), projectMap)
    const preview = prompts.preview(next)
    assertWorkDeployment(preview)
    for (const role of [preview.orchestrator, preview.worker]) {
      expect(role).toContain(shared.blocks['context-shared'])
      expect(role).toContain('preserve explicit human holds')
      expect(role).toContain('Default to no commit/push/MR creation')
      expect(role).not.toContain('## Project engineering contract')
    }
    expect(preview.orchestrator).toContain(projectMap)
    expect(preview.orchestrator).toContain(shared.blocks['router-instructions'])
    expect(preview.orchestrator).not.toContain(blocks['worker-instructions'])
    expect(preview.worker).toContain(blocks['worker-instructions'])
    expect(preview.worker).toContain(blocks['worker-work-addendum'])
    expect(preview.worker).not.toContain(projectMap)
    expect(preview.skills[TOOL_SKILL]).toBe(blocks['worker-tools'])
    expect(preview.skills[TOOL_SKILL]).toContain('## Project engineering contract')
    expect(preview.skills[COLLABORATION_SKILL]).toContain('at most three distinct review runs')
    expect(preview.skills).toHaveProperty('gitlab')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('retains manual agreements outside managed blocks and unrelated role settings across repeated migrations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'layered-preserve-'))
  const store = new Store(join(dir, 'db'))
  try {
    const prompts = new Prompts(store, () => 100000, variables, () => false, () => 'gitlab')
    const config = { ...defaultPrompts(), skills: { existing: 'Keep skill' }, overrides: {
      'runtime/replies': { text: 'Keep original reply gate', base: 'old-reply-base' },
      'runtime/shared': { text: 'Retain explicit human stop.', base: 'old-shared-base' },
    } }
    const first = buildLayeredContextConfig(viewOf(prompts, config), blocks, reviewed(config), projectMap)
    const manual: PromptConfig = { ...first, communication: `Use the original sender.\n\n${first.communication}`,
      scope: `${first.scope}\n\nWait until the owner lifts the hold.`,
      delivery: `Ticket-specific publication permission is required.\n\n${first.delivery}` }
    const second = buildLayeredContextConfig(viewOf(prompts, manual), blocks, shared, projectMap)
    expect(second.communication).toContain('Use the original sender.')
    expect(second.scope).toContain('Wait until the owner lifts the hold.')
    expect(second.delivery).toContain('Ticket-specific publication permission is required.')
    expect(second.overrides?.['runtime/shared']).toMatchObject({ base: 'old-shared-base' })
    expect(second.overrides?.['runtime/shared']?.text).toContain('Retain explicit human stop.')
    expect(second.overrides?.['runtime/replies']).toEqual(config.overrides['runtime/replies'])
    expect(second.skills.existing).toBe('Keep skill')
    expect(buildLayeredContextConfig(viewOf(prompts, second), blocks, shared, projectMap)).toEqual(second)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('refuses unreviewed authorization changes and malformed managed sections before migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'layered-refuse-'))
  const store = new Store(join(dir, 'db'))
  try {
    const prompts = new Prompts(store, () => 100000, variables, () => false, () => 'gitlab')
    const config = defaultPrompts(), approved = reviewed(config)
    for (const name of ['communication', 'scope', 'delivery'] as const) {
      const changed = { ...config, [name]: config[name] + '\nA new human condition.' }
      expect(() => buildLayeredContextConfig(viewOf(prompts, changed), blocks, approved, projectMap))
        .toThrow(`Unreviewed team section changed: ${name}`)
    }
    const next = buildLayeredContextConfig(viewOf(prompts, config), blocks, approved, projectMap)
    for (const malformed of [
      next.scope.replace('<!-- /superagent-team:scope -->', ''),
      `${next.scope}\n<!-- superagent-team:scope:v1 -->`,
      `<!-- /superagent-team:scope -->\n${next.scope}`,
    ]) {
      expect(() => buildLayeredContextConfig(viewOf(prompts, { ...next, scope: malformed }), blocks, shared, projectMap))
        .toThrow('Ambiguous managed context block')
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
  expect(parseSharedContext(sharedDocument.replace(/\n/g, '\r\n'))).toEqual(shared)
  expect(() => parseSharedContext(sharedDocument.replace('```context-shared', '```other'))).toThrow('context-shared')
  expect(() => parseSharedContext(sharedDocument.replace(/```context-migration\n[^\n]+/, '```context-migration\n[]')))
    .toThrow('Missing reviewed migration hash')
  expect(() => parseProjectMap(`${projectDocument}\n\x60\x60\x60router-project-map\nDuplicate\n\x60\x60\x60`))
    .toThrow('router-project-map')
})

it('recovers both layered roles and on-demand skills from the persisted revision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'layered-recovery-'))
  let store = new Store(join(dir, 'db'))
  try {
    let prompts = new Prompts(store, () => 100000, variables, () => false, () => 'gitlab')
    const config = defaultPrompts()
    const next = buildLayeredContextConfig(viewOf(prompts, config), blocks, reviewed(config), projectMap)
    const saved = prompts.save(next, 0, 'panel')
    store.close()
    store = new Store(join(dir, 'db'))
    prompts = new Prompts(store, () => 100000, variables, () => false, () => 'gitlab')
    const actual = prompts.preview(prompts.current().config)
    expect(prompts.current().revision).toBe(saved.revision)
    expect(actual.orchestrator).toContain(projectMap)
    expect(actual.worker).toContain(blocks['worker-instructions'])
    expect(actual.skills[TOOL_SKILL]).toBe(blocks['worker-tools'])
    expect(actual.skills[COLLABORATION_SKILL]).toBe(shared.blocks['collaboration-tools'])
    expect(buildLayeredContextConfig(viewOf(prompts, prompts.current().config), blocks, shared, projectMap))
      .toEqual(prompts.current().config)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})
