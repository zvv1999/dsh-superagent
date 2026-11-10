import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, executable, GitlabAccountsSchema, machineOf, resolveDeployment, resolveFeishuBot, resolveGitlabDeployment, type Machine, type Probe } from '../src/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let dir: string
let path: string
const program = (file: string, body = ''): string => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
/** Fake gh CLI signed in as `login` with configurable push access to acme/widgets (including its former name acme/gadgets). */
const gh = (file: string, login: string, push = true): string => program(file, `case "$*" in\n  "api user") echo '{"login":"${login}","id":7}' ;;\n  "api repos/acme/"*" --jq {name: .full_name, push: .permissions.push}") echo '{"name":"acme/widgets","push":${push}}' ;;\n  *) exit 1 ;;\nesac`)
/** Fake glab CLI returning a GitLab identity and project permissions for the configured host/path. */
const glab = (file: string, username = 'agent-user', accessLevel = 40): string => program(file, `case "$*" in
  "api --hostname gitlab.com user") echo '{"username":"${username}","id":136,"commit_email":"${username}@example.invalid"}' ;;
  "api --hostname gitlab.com projects/example%2Fwidgets") echo '{"id":2834,"path_with_namespace":"example/widgets","permissions":{"project_access":{"access_level":${accessLevel}}}}' ;;
  *) exit 1 ;;
esac`)
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string =>
  `case "$*" in\n  "auth status") echo '${JSON.stringify(status)}' ;;\n  "config strict-mode") echo 'strict-mode: ${mode} (source: profile)' ;;\n  "api GET /open-apis/bot/v3/info --as bot --format ndjson") echo '${JSON.stringify(bot)}' ;;\nesac`
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. */
const probe: Probe = async argv => (await exec(argv[0]!, argv.slice(1), { env: { PATH: path, HOME: dir } })).stdout
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  path = [join(dir, 'state-link', 'worker-bin'), `${join(dir, 'state', 'worker-bin')}/`, join(dir, 'bin'), '/usr/bin', '/bin'].join(':')
  gh(join(dir, 'bin', 'gh'), 'Agent-Bot')
  program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } }))
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  program(join(dir, 'state', 'worker-bin', 'gh'))
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'))
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('accepts nested GitLab projects and rejects URLs, prefixes and dot path segments', () => {
    for (const repository of ['', 'acme/widgets', 'acme/platform/widgets.v2']) {
      expect(GitlabAccountsSchema.safeParse({ repository }).success, repository).toBe(true)
    }
    for (const repository of ['https://gitlab.com/acme/widgets', '/acme/widgets', 'prefix:acme/widgets', '../widgets', './widgets',
      'acme/../widgets', 'acme/./widgets', 'acme/.', 'acme/..', 'acme//widgets', 'acme/widgets/']) {
      expect(GitlabAccountsSchema.safeParse({ repository }).success, repository).toBe(false)
    }
  })
  it('requires only the state directory and reads the editable fields through references', () => {
    expect(() => Config({})).toThrow('stateDir')
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on the GitHub or GitLab Source), repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
})

describe('setup', () => {
  it('reads the repository from the GitHub Source and the accounts from their CLIs, skipping the worker shims', async () => {
    const deployment = await resolveDeployment(machine(), { repository: 'acme/widgets', cli: 'gh' }, probe, path)
    expect(deployment).toMatchObject({ repository: 'acme/widgets', github: { cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
    expect(deployment.github).toEqual({ cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(deployment).not.toHaveProperty('feishu')
    // A renamed repository is still resolved by its old name; notifications carry GitHub's current full_name.
    expect((await resolveDeployment(machine(), { repository: 'acme/gadgets', cli: 'gh' }, probe, path)).repository).toBe('acme/widgets')
  })
  it('reads the GitLab identity and project access through glab without requiring GitHub', async () => {
    const cli = glab(join(dir, 'bin', 'glab'))
    const deployment = await resolveGitlabDeployment(machine(), { hostname: 'gitlab.com', repository: 'example/widgets', cli: 'glab' }, probe, path)
    expect(deployment).toMatchObject({ repository: 'example/widgets', gitlab: {
      cli, hostname: 'gitlab.com', login: 'agent-user', noreply: 'agent-user@example.invalid', projectId: 2834,
    } })
    expect(deployment.github).toBeUndefined()
  })
  it.each([
    { commit_email: '', public_email: '', expected: '136-agent-bot@noreply.gitlab.com' },
    { commit_email: '', public_email: 'public@example.invalid', expected: 'public@example.invalid' },
    { commit_email: 'commit@example.invalid', public_email: '', expected: 'commit@example.invalid' },
    { commit_email: 'commit@example.invalid', public_email: 'public@example.invalid', expected: 'commit@example.invalid' },
    { commit_email: null, public_email: null, expected: '136-agent-bot@noreply.gitlab.com' },
    { commit_email: undefined, public_email: undefined, expected: '136-agent-bot@noreply.gitlab.com' },
  ])('resolves GitLab commit identity when API email fields are $commit_email / $public_email', async ({ commit_email, public_email, expected }) => {
    const cli = program(join(dir, 'bin', 'glab'))
    const inspect = vi.fn<Probe>()
      .mockResolvedValueOnce(JSON.stringify({ username: 'agent-bot', id: 136, commit_email, public_email }))
      .mockResolvedValueOnce(JSON.stringify({ id: 2834, path_with_namespace: 'acme/widgets', permissions: { group_access: { access_level: 40 } } }))
    const deployment = await resolveGitlabDeployment(machine(), { hostname: 'gitlab.com:8443', repository: 'acme/widgets', cli }, inspect, path)
    expect(deployment.gitlab.noreply).toBe(expected)
    expect(inspect).toHaveBeenCalledTimes(2)
  })
  it('rejects an invalid canonical GitLab path returned by the project API', async () => {
    const cli = program(join(dir, 'bin', 'glab'))
    const inspect = vi.fn<Probe>()
      .mockResolvedValueOnce(JSON.stringify({ username: 'agent-bot', id: 136, commit_email: '', public_email: '' }))
      .mockResolvedValueOnce(JSON.stringify({ id: 2834, path_with_namespace: 'acme/../widgets', permissions: { project_access: { access_level: 40 } } }))
    await expect(resolveGitlabDeployment(machine(), { hostname: 'gitlab.com', repository: 'acme/widgets', cli }, inspect, path))
      .rejects.toEqual(setupError('gitlab', 'gitlabRepositoryUnreported', { repository: 'acme/widgets' }))
  })
  it('names GitLab setup failures and refuses read-only projects', async () => {
    const needs = (code: string, values: Record<string, unknown>, gitlab: unknown) =>
      expect(resolveGitlabDeployment(machine(), gitlab, probe, path)).rejects.toEqual(setupError('gitlab', code, values))
    const repository = 'example/widgets'
    await needs('gitlabHostnameUnset', {}, { repository, cli: 'glab' })
    await needs('gitlabRepositoryUnset', {}, { hostname: 'gitlab.com', cli: 'glab' })
    await needs('gitlabCliUnset', {}, { hostname: 'gitlab.com', repository })
    await needs('gitlabCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { hostname: 'gitlab.com', repository, cli: join(dir, 'missing') })
    await needs('gitlabCliSignedOut', {}, { hostname: 'gitlab.com', repository, cli: program(join(dir, 'bin', 'glab-broken'), 'exit 1') })
    await needs('gitlabRepositoryReadOnly', { account: 'agent-user', repository }, { hostname: 'gitlab.com', repository, cli: glab(join(dir, 'bin', 'glab-reader'), 'agent-user', 20) })
    await needs('gitlabCliNoAccount', {}, { hostname: 'gitlab.com', repository, cli: program(join(dir, 'bin', 'glab-anonymous'), `echo '{}'`) })
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveDeployment(machine(), github, probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    await needs('github', 'repositoryUnset', {}, { cli: 'gh' })
    await needs('github', 'agentCliUnset', {}, { repository })
    await needs('github', 'agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { repository, cli: join(dir, 'missing') })
    await needs('github', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, { repository, cli: 'bin/gh' })
    await needs('github', 'agentCliSignedOut', {}, { repository, cli: program(join(dir, 'bin', 'gh-broken'), 'exit 1') })
    await needs('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repository, cli: gh(join(dir, 'bin', 'gh-reader'), 'Agent-Bot', false) })
    // Signed in, but the account cannot read the repository, or the CLI names no account.
    const unreadable = program(join(dir, 'bin', 'gh-outsider'),
      `case "$*" in\n  "api user") echo '{"login":"Agent-Bot","id":7}' ;;\n  *) echo 'HTTP 404' >&2; exit 1 ;;\nesac`)
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repository, cli: unreadable })
    await needs('github', 'agentCliNoAccount', {}, { repository, cli: program(join(dir, 'bin', 'gh-anonymous'), `echo '{}'`) })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: join(dir, 'bin', 'lark-cli'), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
    program(join(dir, 'bin', 'lark-cli'), lark({ identities: { bot: { status: 'ready' } } }))
    await refuses('feishuNoApp')
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } }))
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    await refuses('feishuUserIdentity', { mode: 'off' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} }))
    await refuses('feishuNoBot')
    program(join(dir, 'bin', 'lark-cli'), 'echo "not configured" >&2; exit 1')
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
})
