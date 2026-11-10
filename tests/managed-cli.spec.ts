import { createHash } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { checkDirectoryChain, cliEnvironment, ManagedCli, privateDirectory, runCli } from '../src/app/managed-cli.ts'
import { CliFailure } from '../src/app/cli-connect-types.ts'

const roots: string[] = []
const children = new Set<number>()
const posix = process.platform !== 'win32'
// macOS's default temporary directory alone can exceed the CLI's socket budget.
const temporaryBase = () => realpath(process.platform === 'darwin' ? '/tmp' : tmpdir())
function alive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }
function kill(pid: number): void { try { process.kill(pid, 'SIGKILL') } catch { /* Already exited. */ } }
afterEach(async () => {
  for (const pid of children) kill(pid)
  children.clear()
  vi.unstubAllEnvs(); vi.restoreAllMocks()
  const base = await temporaryBase()
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(base, 'managed-cli-test-'))) throw new Error('Unexpected cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(await temporaryBase(), 'managed-cli-test-'))
  roots.push(root)
  return { root, env: cliEnvironment('feishu', root), signal: new AbortController().signal }
}
it('discovers only private managed attempt directories for the requested platform without creating storage', async () => {
  const h = await fixture(), managed = new ManagedCli(h.root)
  await expect(managed.configurations('feishu')).resolves.toEqual([])
  const selected = await managed.connectionDirectory('feishu')
  await managed.connectionDirectory('dingtalk')
  const root = join(h.root, 'managed-im', 'connections')
  const legacy = await privateDirectory(h.root, 'managed-im', 'connections', 'feishu-12345678-1234-1234-1234-123456789abc')
  await mkdir(join(root, 'feishu-not-a-managed-attempt'), { mode: 0o700 })
  if (posix) {
    const publicDirectory = await managed.connectionDirectory('feishu')
    await chmod(publicDirectory, 0o755)
  }
  await symlink(selected, join(root, 'feishu-00000000-0000-0000-0000-000000000000'), posix ? 'dir' : 'junction')
  expect(await managed.configurations('feishu')).toEqual(expect.arrayContaining([selected, legacy]))
  expect(await managed.configurations('feishu')).toHaveLength(2)
})

it('does not discover attempts through a redirected managed directory', async () => {
  const h = await fixture(), managed = new ManagedCli(h.root)
  const outside = join(h.root, 'outside')
  await mkdir(outside, { mode: 0o700 })
  await mkdir(join(outside, 'connections'), { mode: 0o700 })
  await symlink(outside, join(h.root, 'managed-im'), posix ? 'dir' : 'junction')
  await expect(managed.configurations('feishu')).resolves.toEqual([])
})

const forbidden = {
  OPENAI_API_KEY: 'FAKE_PROVIDER_SECRET', ANTHROPIC_API_KEY: 'FAKE_PROVIDER_SECRET', DEEPSEEK_API_KEY: 'FAKE_PROVIDER_SECRET',
  LARKSUITE_CLI_APP_ID: 'cli_wrong', LARKSUITE_CLI_APP_SECRET: 'FAKE_APP_SECRET',
  LARKSUITE_CLI_USER_ACCESS_TOKEN: 'FAKE_USER_TOKEN', LARKSUITE_CLI_TENANT_ACCESS_TOKEN: 'FAKE_BOT_TOKEN',
  LARKSUITE_CLI_STRICT_MODE: 'off', LARKSUITE_CLI_DEFAULT_AS: 'user', LARKSUITE_CLI_PROFILE: 'personal',
  LARKSUITE_CLI_AUTH_PROXY: 'http://127.0.0.1:1', LARKSUITE_CLI_PROXY_KEY: 'FAKE_PROXY_SECRET',
  LARKSUITE_CLI_BRAND: 'lark', LARKSUITE_CLI_DATA_DIR: '/wrong/data', LARKSUITE_CLI_LOG_DIR: '/wrong/logs',
  DWS_ACCESS_TOKEN: 'FAKE_DWS_TOKEN', DWS_CONFIG_DIR: '/wrong/dws', DWS_AGENT_CLIENT_SECRET: 'FAKE_DWS_SECRET',
  OPENCLAW_HOME: '/wrong/openclaw', HERMES_HOME: '/wrong/hermes', LARK_CHANNEL: '1',
  NODE_OPTIONS: '--require=/does-not-exist', GIT_CONFIG_COUNT: '1', npm_config_registry: 'https://invalid.example',
}

it.each(['feishu', 'dingtalk'] as const)('whitelists essentials and removes inherited credentials, routing and code injection for %s', platform => {
  for (const [key, value] of Object.entries(forbidden)) vi.stubEnv(key, value)
  vi.stubEnv('HTTPS_PROXY', 'http://localhost:1234')
  const env = cliEnvironment(platform, '/private/attempt')
  for (const key of Object.keys(forbidden)) {
    if (platform === 'dingtalk' && key === 'DWS_CONFIG_DIR') continue
    expect(env[key], key).toBeUndefined()
  }
  expect(env.HTTPS_PROXY).toBe('http://localhost:1234')
  expect(env).toMatchObject({ TERM: 'dumb', NO_COLOR: '1', CI: '1' })
  if (platform === 'feishu') expect(env.LARKSUITE_CLI_CONFIG_DIR).toBe('/private/attempt')
  else expect(env.DWS_CONFIG_DIR).toBe('/private/attempt')
})

it('delivers stdin privately, preserves literal argv without a shell, and returns only process output', async () => {
  const h = await fixture(), secret = 'STDIN_ONLY_FAKE_SECRET', literal = '$(touch unexpected); `echo injected`'
  const log = vi.spyOn(console, 'log'), error = vi.spyOn(console, 'error')
  const script = `const {createHash}=require('node:crypto'); let input=''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk=>input+=chunk); process.stdin.on('end', ()=>{
      process.stdout.write(JSON.stringify({digest:createHash('sha256').update(input).digest('hex'),args:process.argv.slice(1),
        leaked:JSON.stringify({args:process.argv,env:process.env}).includes(input.trim())})); process.stderr.write('private diagnostic'); });`
  const output = await runCli(process.execPath, ['-e', script, '--', literal], { signal: h.signal, stdin: secret + '\n' }, h.env, h.root)
  expect(JSON.parse(output.stdout)).toEqual({ digest: createHash('sha256').update(secret + '\n').digest('hex'), args: [literal], leaked: false })
  expect(output.stderr).toBe('private diagnostic')
  expect(JSON.stringify(output)).not.toContain(secret)
  expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled()
})

it('closes stdin even when no input was supplied', async () => {
  const h = await fixture()
  const output = await runCli(process.execPath, ['-e', "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('EOF'))"], { signal: h.signal, timeoutMs: 2000 }, h.env, h.root)
  expect(output.stdout).toBe('EOF')
})

it('maps nonzero exits and launch failures to stable errors without exposing stderr or paths', async () => {
  const h = await fixture()
  await expect(runCli(process.execPath, ['-e', "process.stderr.write('FAKE_SECRET_DIAGNOSTIC');process.exitCode=7"], { signal: h.signal }, h.env, h.root))
    .rejects.toEqual(new CliFailure('authorization_failed'))
  await expect(runCli(join(h.root, 'missing-native'), [], { signal: h.signal }, h.env, h.root))
    .rejects.toEqual(new CliFailure('authorization_failed'))
})

it('maps synchronous spawn validation failures to the same stable process error', async () => {
  const h = await fixture()
  await expect(runCli(process.execPath, ['invalid\0argument'], { signal: h.signal }, h.env, h.root))
    .rejects.toEqual(new CliFailure('authorization_failed'))
})

it('rejects already cancelled work without spawning a process', async () => {
  const h = await fixture(), controller = new AbortController()
  controller.abort()
  await expect(runCli('/nonexistent', [], { signal: controller.signal }, h.env, h.root)).rejects.toEqual(new CliFailure('cancelled'))
})

it('bounds combined stdout/stderr before forwarding an overflowing chunk', async () => {
  const h = await fixture()
  let bytes = 0
  await expect(runCli(process.execPath, ['-e', "process.stdout.write('x'.repeat(1100000));process.stderr.write('y'.repeat(1100000));setInterval(()=>{},1000)"], {
    signal: h.signal, timeoutMs: 3000, onOutput: (_stream, chunk) => { bytes += Buffer.byteLength(chunk) },
  }, h.env, h.root)).rejects.toEqual(new CliFailure('invalid_response'))
  expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024)
  expect(bytes).toBeGreaterThan(0)
})

it('stops the process when a streaming consumer rejects its output', async () => {
  const h = await fixture()
  await expect(runCli(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], {
    signal: h.signal, onOutput: () => { throw new Error('FAKE_SECRET') },
  }, h.env, h.root)).rejects.toEqual(new CliFailure('invalid_response'))
})

it('waits for an aborted process to exit before rejecting', async () => {
  const h = await fixture(), controller = new AbortController()
  let pid = 0
  await expect(runCli(process.execPath, ['-e', "process.stdout.write(String(process.pid)+'\\n');setInterval(()=>{},1000)"], {
    signal: controller.signal,
    onOutput: (stream, chunk) => { if (stream === 'stdout') { pid = Number(chunk.trim()); children.add(pid); controller.abort() } },
  }, h.env, h.root)).rejects.toEqual(new CliFailure('cancelled'))
  expect(pid).toBeGreaterThan(0)
  expect(alive(pid)).toBe(false)
})

it('times out and reaps a process rather than returning while it keeps polling', async () => {
  const h = await fixture()
  let pid = 0
  await expect(runCli(process.execPath, ['-e', "process.stdout.write(String(process.pid)+'\\n');setInterval(()=>{},1000)"], {
    signal: h.signal, timeoutMs: 500,
    onOutput: (stream, chunk) => { if (stream === 'stdout') { pid = Number(chunk.trim()); children.add(pid) } },
  }, h.env, h.root)).rejects.toEqual(new CliFailure('expired'))
  expect(pid).toBeGreaterThan(0)
  expect(alive(pid)).toBe(false)
})

it.skipIf(!posix)('forces SIGKILL when a native poller ignores SIGTERM', async () => {
  const h = await fixture(), controller = new AbortController()
  let pid = 0
  await expect(runCli(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write(String(process.pid)+'\\n');setInterval(()=>{},1000)"], {
    signal: controller.signal,
    onOutput: (stream, chunk) => { if (stream === 'stdout') { pid = Number(chunk.trim()); children.add(pid); controller.abort() } },
  }, h.env, h.root)).rejects.toEqual(new CliFailure('cancelled'))
  expect(pid).toBeGreaterThan(0)
  expect(alive(pid)).toBe(false)
})

it.skipIf(!posix)('kills a SIGTERM-resistant descendant even after its parent closes all capture pipes', async () => {
  const h = await fixture(), controller = new AbortController()
  let descendant = 0
  const childCode = "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"
  const parentCode = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],
    {stdio:['ignore','ignore','ignore','ipc']}); child.once('message',()=>process.stdout.write(String(child.pid)+'\\n'));setInterval(()=>{},1000)`
  await expect(runCli(process.execPath, ['-e', parentCode], {
    signal: controller.signal,
    onOutput: (stream, chunk) => { if (stream === 'stdout') { descendant = Number(chunk.trim()); children.add(descendant); controller.abort() } },
  }, h.env, h.root)).rejects.toEqual(new CliFailure('cancelled'))
  expect(descendant).toBeGreaterThan(0)
  await vi.waitFor(() => expect(alive(descendant)).toBe(false), { timeout: 500, interval: 20 })
})

it('creates and reuses only private nested directories, rejecting path traversal and files', async () => {
  const h = await fixture()
  const directory = await privateDirectory(h.root, 'connections', 'attempt-123')
  expect(await privateDirectory(h.root, 'connections', 'attempt-123')).toBe(directory)
  await checkDirectoryChain(directory)
  if (posix) expect((await stat(directory)).mode & 0o777).toBe(0o700)
  for (const part of ['..', '.', 'a/b', '/absolute', 'space here']) await expect(privateDirectory(h.root, part)).rejects.toMatchObject({ code: 'save_failed' })
  await writeFile(join(h.root, 'regular-file'), '')
  await expect(privateDirectory(h.root, 'regular-file')).rejects.toMatchObject({ code: 'save_failed' })
})

it('rejects symlink directory components and preserves their target', async () => {
  const h = await fixture(), target = join(h.root, 'target')
  await mkdir(target, { mode: 0o700 })
  const link = join(h.root, 'redirect')
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(privateDirectory(h.root, 'redirect', 'attempt')).rejects.toMatchObject({ code: 'save_failed' })
  await expect(checkDirectoryChain(link)).rejects.toMatchObject({ code: 'save_failed' })
  expect((await stat(target)).isDirectory()).toBe(true)
})

it.skipIf(!posix)('refuses existing directories with group or other permissions', async () => {
  const h = await fixture(), directory = join(h.root, 'shared')
  await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o755)
  await expect(privateDirectory(h.root, 'shared')).rejects.toMatchObject({ code: 'save_failed' })
  expect((await stat(directory)).mode & 0o777).toBe(0o755)
})

it.skipIf(!posix)('writes a private wrapper with correctly quoted paths and literal forwarded arguments, without storing secrets', async () => {
  const h = await fixture(), directory = join(h.root, "connection ' $(ignored)")
  await mkdir(directory, { mode: 0o700 })
  const managed = new ManagedCli(h.root), cli = managed.io('feishu', process.execPath, directory)
  const wrapper = await managed.wrapper(cli)
  const original = await readFile(wrapper, 'utf8')
  const retry = await managed.wrapper(cli)
  expect(retry).not.toBe(wrapper)
  expect(await readFile(wrapper, 'utf8')).toBe(original)
  const retryResult = await runCli(retry, ['-e', "process.stdout.write('saved-again')"], { signal: h.signal }, h.env, h.root)
  expect(retryResult.stdout).toBe('saved-again')
  expect((await stat(wrapper)).mode & 0o777).toBe(0o700)
  const contents = await readFile(wrapper, 'utf8')
  expect(contents).not.toContain('FAKE_APP_SECRET')
  const result = await runCli(wrapper, ['-e', "process.stdout.write(JSON.stringify({config:process.env.LARKSUITE_CLI_CONFIG_DIR,args:process.argv.slice(1)}))", '--', 'literal $(not-a-command)'], {
    signal: h.signal,
  }, { ...h.env, LARKSUITE_CLI_APP_SECRET: 'FAKE_APP_SECRET', LARKSUITE_CLI_CONFIG_DIR: '/wrong' }, h.root)
  expect(JSON.parse(result.stdout)).toEqual({ config: directory, args: ['literal $(not-a-command)'] })
})

it.skipIf(!posix)('sanitizes worker wrapper credentials, workspace routing and strict-mode overrides just like the host runner', async () => {
  const h = await fixture(), managed = new ManagedCli(h.root)
  const wrapper = await managed.wrapper(managed.io('feishu', process.execPath, h.root))
  const injected = { ...forbidden }
  // NODE_OPTIONS is removed here so an unsafe wrapper still starts the diagnostic child.
  delete (injected as Partial<typeof forbidden>).NODE_OPTIONS
  const script = `const forbidden=${JSON.stringify(Object.keys(injected))};process.stdout.write(JSON.stringify(forbidden.filter(key=>process.env[key]!==undefined)))`
  const result = await runCli(wrapper, ['-e', script], { signal: h.signal }, { ...h.env, ...injected }, h.root)
  expect(JSON.parse(result.stdout)).toEqual([])
})

it.skipIf(!posix)('removes Node preload options before the wrapper bootstrap starts', async () => {
  const h = await fixture(), managed = new ManagedCli(h.root)
  const preload = join(h.root, 'preload.cjs'), marker = join(h.root, 'preload-executed')
  await writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected preload')`)
  const wrapper = await managed.wrapper(managed.io('feishu', process.execPath, h.root))
  const result = await runCli(wrapper, ['-e', "process.stdout.write('native-ready')"], { signal: h.signal }, {
    ...h.env, NODE_OPTIONS: `--require=${preload}`, NODE_PATH: h.root,
  }, h.root)
  expect(result.stdout).toBe('native-ready')
  await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('creates a separate private configuration directory for every connection attempt', async () => {
  const h = await fixture(), managed = new ManagedCli(h.root)
  const first = await managed.connectionDirectory('feishu'), second = await managed.connectionDirectory('feishu')
  expect(first).not.toBe(second)
  expect(first.startsWith(join(h.root, 'f') + sep)).toBe(true)
  if (posix) expect((await stat(first)).mode & 0o777).toBe(0o700)
})

const botApp = 'cli_0123456789abcdef'
async function legacyBot(h: Awaited<ReturnType<typeof fixture>>) {
  const managed = new ManagedCli(h.root)
  const directory = await privateDirectory(h.root, 'managed-im', 'connections', 'feishu-12345678-1234-1234-1234-123456789abc')
  const config = { apps: [{ appId: botApp, brand: 'feishu', appSecret: { source: 'file', id: join(directory, 'app-secret') }, users: [] as unknown[] }],
    tokenCache: 'DO_NOT_COPY_CACHED_TOKEN' }
  await writeFile(join(directory, 'app-secret'), 'PRIVATE_FAKE_APP_SECRET', { flag: 'wx', mode: 0o600 })
  await writeFile(join(directory, 'config.json'), JSON.stringify(config), { flag: 'wx', mode: 0o600 })
  await writeFile(join(directory, 'tokens.json'), 'DO_NOT_COPY_CACHED_TOKEN', { flag: 'wx', mode: 0o600 })
  return { managed, directory, config, cli: managed.io('feishu', process.execPath, directory) }
}

it('migrates a legacy bot into a private short directory, preserving its credential without copying cached tokens', async () => {
  const h = await fixture(), saved = await legacyBot(h)
  const original = await readFile(join(saved.directory, 'config.json'), 'utf8')
  const cli = await saved.managed.compactFeishu(saved.cli, botApp, h.signal)
  expect(cli.configDir).not.toBe(saved.directory)
  expect(Buffer.byteLength(join(cli.configDir, 'events', botApp, 'bus.sock'))).toBeLessThanOrEqual(103)
  expect(await readdir(cli.configDir)).toEqual(['app-secret', 'config.json'])
  expect(JSON.parse(await readFile(join(cli.configDir, 'config.json'), 'utf8'))).toEqual({ apps: [{
    appId: botApp, brand: 'feishu', appSecret: { source: 'file', id: join(cli.configDir, 'app-secret') },
    lang: 'zh_cn', strictMode: 'bot', defaultAs: 'bot', users: [],
  }] })
  expect(await readFile(join(cli.configDir, 'app-secret'), 'utf8')).toBe('PRIVATE_FAKE_APP_SECRET')
  expect(await readFile(join(saved.directory, 'config.json'), 'utf8')).toBe(original)
  if (posix) {
    expect((await stat(cli.configDir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(cli.configDir, 'app-secret'))).mode & 0o777).toBe(0o600)
  }
  await expect(saved.managed.compactFeishu(cli, botApp, h.signal)).resolves.toBe(cli)
  expect(await saved.managed.configurations('feishu')).toContain(cli.configDir)
})

it('preserves only the matching keychain reference when compacting a legacy bot', async () => {
  const h = await fixture(), saved = await legacyBot(h)
  saved.config.apps[0]!.appSecret = { source: 'keychain', id: `appsecret:${botApp}` }
  await writeFile(join(saved.directory, 'config.json'), JSON.stringify(saved.config), { mode: 0o600 })
  const cli = await saved.managed.compactFeishu(saved.cli, botApp, h.signal)
  expect(await readdir(cli.configDir)).toEqual(['config.json'])
  expect(JSON.parse(await readFile(join(cli.configDir, 'config.json'), 'utf8')).apps[0].appSecret).toEqual(saved.config.apps[0]!.appSecret)
})

it.each(['foreign file', 'foreign keychain', 'symlink', 'hardlink', 'personal login'] as const)('rejects %s during legacy migration without publishing a configuration', async kind => {
  const h = await fixture(), saved = await legacyBot(h), app = saved.config.apps[0]!
  if (kind === 'foreign file') app.appSecret.id = join(h.root, 'another-app-secret')
  if (kind === 'foreign keychain') app.appSecret = { source: 'keychain', id: 'appsecret:cli_someoneelse' }
  if (kind === 'personal login') app.users.push({ token: 'DO_NOT_COPY_PERSONAL_TOKEN' })
  if (kind === 'symlink') {
    const target = join(h.root, 'secret-target')
    await writeFile(target, 'OTHER_PRIVATE_SECRET', { mode: 0o600 })
    await rm(app.appSecret.id)
    await symlink(target, app.appSecret.id)
  }
  if (kind === 'hardlink') await link(app.appSecret.id, join(h.root, 'secret-link'))
  await writeFile(join(saved.directory, 'config.json'), JSON.stringify(saved.config), { mode: 0o600 })
  await expect(saved.managed.compactFeishu(saved.cli, botApp, h.signal)).rejects.toEqual(new CliFailure('save_failed'))
  expect(await saved.managed.configurations('feishu')).toEqual([saved.directory])
})

it.skipIf(!posix)('rejects public secret files instead of copying them into a trusted bot configuration', async () => {
  const h = await fixture(), saved = await legacyBot(h)
  await chmod(join(saved.directory, 'app-secret'), 0o644)
  await expect(saved.managed.compactFeishu(saved.cli, botApp, h.signal)).rejects.toEqual(new CliFailure('save_failed'))
})

it('refuses a different app or an aborted migration before binding a wrapper', async () => {
  const h = await fixture(), saved = await legacyBot(h), aborted = new AbortController()
  aborted.abort()
  await expect(saved.managed.compactFeishu(saved.cli, 'cli_other', h.signal)).rejects.toEqual(new CliFailure('invalid_credentials'))
  await expect(saved.managed.compactFeishu(saved.cli, botApp, aborted.signal)).rejects.toEqual(new CliFailure('cancelled'))
  expect(await saved.managed.configurations('feishu')).toEqual([saved.directory])
})

it('reports an oversized data root before authorization, including multibyte directory names', async () => {
  const h = await fixture(), root = await privateDirectory(h.root, 'long-state-root'.repeat(8))
  await expect(new ManagedCli(root).connectionDirectory('feishu')).rejects.toEqual(new CliFailure('config_path_too_long'))
  expect(await readdir(root)).toEqual([])
  const unicodeRoot = join(h.root, '本机数据目录'.repeat(4))
  await mkdir(unicodeRoot, { mode: 0o700 })
  await expect(new ManagedCli(unicodeRoot).connectionDirectory('feishu')).rejects.toEqual(new CliFailure('config_path_too_long'))
  expect(await readdir(unicodeRoot)).toEqual([])
  // The actual app ID is also checked; character length is not a socket byte budget.
  const managed = new ManagedCli(h.root), directory = await managed.connectionDirectory('feishu')
  await expect(managed.compactFeishu(managed.io('feishu', process.execPath, directory), `cli_${'a'.repeat(80)}`, h.signal)).rejects.toEqual(new CliFailure('config_path_too_long'))
})

it.skipIf(!posix)('can bind a real event-bus socket beneath a newly generated Feishu connection', async () => {
  const h = await fixture(), directory = await new ManagedCli(h.root).connectionDirectory('feishu')
  const events = await privateDirectory(directory, 'events', botApp), server = createServer()
  try {
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(join(events, 'bus.sock'), accept) })
    expect(server.listening).toBe(true)
  } finally {
    if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()))
  }
})
