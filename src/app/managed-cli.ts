/** Installs pinned official native CLIs privately and runs them without inherited credentials, shell interpolation, or output logging. */
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { z } from 'zod'
import { CliFailure, type CliCommandOptions, type CliCommandResult, type CliIo, type CliPlatform } from './cli-connect-types.ts'

export const CLI_RELEASES = {
  feishu: { version: '1.0.99', package: '@larksuite/cli', installer: 'scripts/install.js', binary: 'bin/lark-cli' },
  dingtalk: { version: '1.0.67', package: 'dingtalk-workspace-cli', installer: 'install.js', binary: 'vendor/dws' },
} as const

/** Check each existing directory component; credentials must never follow a path redirected outside the state directory. */
export async function checkDirectoryChain(directory: string): Promise<void> {
  const absolute = resolve(directory), root = parse(absolute).root
  let current = root
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new CliFailure('save_failed')
  }
}
export async function privateDirectory(root: string, ...parts: string[]): Promise<string> {
  await checkDirectoryChain(root)
  let current = resolve(root)
  for (const part of parts) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..') throw new CliFailure('save_failed')
    current = join(current, part)
    try { await mkdir(current, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new CliFailure('save_failed') }
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new CliFailure('save_failed')
  }
  return current
}
/** Whitelist process essentials; CLI routing, debug variables and all provider tokens are deliberately not inherited. */
export function cliEnvironment(platform: CliPlatform, configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'LOCALAPPDATA', 'APPDATA',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  Object.assign(env, { NO_COLOR: '1', TERM: 'dumb', CI: '1', DO_NOT_TRACK: '1' })
  if (platform === 'feishu') Object.assign(env, { LARKSUITE_CLI_CONFIG_DIR: configDir, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' })
  else Object.assign(env, { DWS_CONFIG_DIR: configDir, DWS_LANG: 'en', DWS_NO_UPDATE_CHECK: '1', DWS_NO_SKILLS: '1' })
  return env
}

/** Bounded private process capture. Cancellation waits for exit, including a forced process-group shutdown when needed. */
export function runCli(executable: string, args: readonly string[], options: CliCommandOptions,
  environment: NodeJS.ProcessEnv, cwd: string): Promise<CliCommandResult> {
  if (options.signal.aborted) return Promise.reject(new CliFailure('cancelled'))
  return new Promise<CliCommandResult>((accept, reject) => {
    let stdout = '', stderr = '', bytes = 0, finished = false, failure: CliFailure | undefined
    let forced: ReturnType<typeof setTimeout> | undefined
    const child = spawn(executable, [...args], { cwd, env: environment, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal) } catch { /* It may already have exited. */ }
    }
    const stop = (reason: CliFailureCodeForProcess) => {
      if (finished || failure) return
      failure = new CliFailure(reason); kill('SIGTERM')
      forced = setTimeout(() => kill('SIGKILL'), 1500); forced.unref?.()
    }
    const aborted = () => stop('cancelled')
    const timeout = setTimeout(() => stop('expired'), Math.min(options.timeoutMs ?? 45_000, 18 * 60_000)); timeout.unref?.()
    options.signal.addEventListener('abort', aborted, { once: true })
    const complete = (code: number | null, error = false) => {
      if (finished) return
      finished = true
      if (failure) kill('SIGKILL')
      clearTimeout(timeout); if (forced) clearTimeout(forced)
      options.signal.removeEventListener('abort', aborted)
      if (failure || error || code !== 0) reject(failure ?? new CliFailure('authorization_failed'))
      else accept({ stdout, stderr })
    }
    for (const [stream, pipe] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
      pipe.setEncoding('utf8')
      pipe.on('data', (chunk: string) => {
        if (failure || finished) return
        bytes += Buffer.byteLength(chunk)
        if (bytes > 2 * 1024 * 1024) { stop('invalid_response'); return }
        if (stream === 'stdout') stdout += chunk; else stderr += chunk
        try { options.onOutput?.(stream, chunk) } catch { stop('invalid_response') }
      })
    }
    child.once('error', () => complete(null, true))
    child.once('close', code => complete(code))
    child.stdin.on('error', () => { /* A CLI can reject before reading stdin; the exit result remains authoritative. */ })
    child.stdin.end(options.stdin)
    if (options.signal.aborted) aborted()
  }).catch(error => { throw error instanceof CliFailure ? error : new CliFailure('authorization_failed') })
}
type CliFailureCodeForProcess = 'cancelled' | 'expired' | 'invalid_response'
const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`
const legacyAttempt = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const shortAttempt = /^[0-9a-f]{16}$/
// Leave room for the terminating NUL on macOS (104 bytes); also fits Linux.
const feishuSocketFits = (directory: string, appId: string) => Buffer.byteLength(join(directory, 'events', appId, 'bus.sock')) <= 103
const botConfig = z.object({ apps: z.array(z.object({
  appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']),
  appSecret: z.object({ source: z.enum(['file', 'keychain']), id: z.string() }),
  users: z.array(z.unknown()).max(0).optional(),
})).length(1) })
async function privateFile(path: string, limit: number): Promise<Buffer> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink()) throw new CliFailure('save_failed')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await file.stat()
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev || info.nlink !== 1 || info.size < 1 || info.size > limit
      || (process.platform !== 'win32' && ((info.mode & 0o077) || info.uid !== process.getuid?.()))) throw new CliFailure('save_failed')
    const buffer = Buffer.alloc(limit + 1), { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (!bytesRead || bytesRead > limit) throw new CliFailure('save_failed')
    return buffer.subarray(0, bytesRead)
  } finally { await file.close() }
}

/** Owner of pinned binaries and per-attempt configuration directories within one Superagent state directory. */
export class ManagedCli {
  private readonly installs = new Map<CliPlatform, Promise<string>>()
  constructor(private readonly stateDir: string) {}
  private base() { return join(resolve(this.stateDir), 'managed-im') }
  private destination(platform: CliPlatform) { return join(this.base(), 'cli', `${platform}-${CLI_RELEASES[platform].version}`) }
  private binary(platform: CliPlatform) { return join(this.destination(platform), 'node_modules', CLI_RELEASES[platform].package, CLI_RELEASES[platform].binary) }
  async installed(platform: CliPlatform): Promise<boolean> {
    try {
      const file = this.binary(platform)
      await checkDirectoryChain(dirname(file))
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink()) return false
      const stamp = JSON.parse(await readFile(join(this.destination(platform), 'installed.json'), 'utf8')) as { version?: string }
      await access(file, constants.X_OK)
      return stamp.version === CLI_RELEASES[platform].version
    } catch { return false }
  }
  async ensure(platform: CliPlatform, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new CliFailure('cancelled')
    if (await this.installed(platform)) return this.binary(platform)
    const pending = this.installs.get(platform)
    if (pending) { await pending.catch(() => {}); if (signal.aborted) throw new CliFailure('cancelled'); if (await this.installed(platform)) return this.binary(platform) }
    const task = this.install(platform, signal)
    this.installs.set(platform, task)
    try { return await task } finally { if (this.installs.get(platform) === task) this.installs.delete(platform) }
  }
  async connectionDirectory(platform: CliPlatform): Promise<string> {
    if (platform === 'feishu') {
      const name = randomBytes(8).toString('hex'), path = join(resolve(this.stateDir), 'f', name)
      if (!feishuSocketFits(path, 'cli_000000000000000000')) throw new CliFailure('config_path_too_long')
      return privateDirectory(this.stateDir, 'f', name)
    }
    return privateDirectory(this.stateDir, 'managed-im', 'connections', `${platform}-${randomUUID()}`)
  }
  /** Read metadata only; a panel refresh must never install a CLI or resolve credentials. */
  async configurations(platform: CliPlatform): Promise<string[]> {
    const locations = [{ root: join(this.base(), 'connections'), valid: (name: string) => name.startsWith(`${platform}-`) && legacyAttempt.test(name.slice(platform.length + 1)) },
      ...platform === 'feishu' ? [{ root: join(resolve(this.stateDir), 'f'), valid: (name: string) => shortAttempt.test(name) }] : []]
    const found = await Promise.all(locations.map(async ({ root, valid }) => {
      try {
        await checkDirectoryChain(root)
        const entries = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && valid(entry.name))
        if (entries.length > 1000) return []
        const directories = await Promise.all(entries.map(async entry => {
          const path = join(root, entry.name)
          try {
            const info = await lstat(path)
            if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && ((info.mode & 0o077) || info.uid !== process.getuid?.()))) return
            return { path, modified: info.mtimeMs }
          } catch { return }
        }))
        return directories.filter((entry): entry is { path: string; modified: number } => !!entry)
      } catch { return [] }
    }))
    return found.flat().sort((a, b) => b.modified - a.modified).slice(0, 50).map(entry => entry.path)
  }
  /** Migrate only a verified managed bot app, without copying personal logins, token caches or shared keychain values. */
  async compactFeishu(cli: CliIo, appId: string, signal: AbortSignal): Promise<CliIo> {
    if (signal.aborted) throw new CliFailure('cancelled')
    if (!/^cli_[A-Za-z0-9]+$/.test(appId)) throw new CliFailure('invalid_credentials')
    if (feishuSocketFits(cli.configDir, appId)) return cli
    try {
      const source = resolve(cli.configDir), root = join(this.base(), 'connections')
      if (dirname(source) !== root || !source.startsWith(join(root, 'feishu-')) || !legacyAttempt.test(source.slice(join(root, 'feishu-').length))) throw new CliFailure('config_path_too_long')
      await checkDirectoryChain(source)
      const info = await lstat(source)
      if (process.platform !== 'win32' && ((info.mode & 0o077) || info.uid !== process.getuid?.())) throw new CliFailure('save_failed')
      const app = botConfig.parse(JSON.parse((await privateFile(join(source, 'config.json'), 65_536)).toString('utf8'))).apps[0]!
      if (app.appId !== appId) throw new CliFailure('invalid_credentials')
      if (app.appSecret.id !== (app.appSecret.source === 'file' ? join(source, 'app-secret') : `appsecret:${appId}`)) throw new CliFailure('save_failed')
      const secret = app.appSecret.source === 'file' ? await privateFile(app.appSecret.id, 4096) : undefined
      try {
        const destination = await this.connectionDirectory('feishu')
        if (!feishuSocketFits(destination, appId)) throw new CliFailure('config_path_too_long')
        let reference = app.appSecret
        if (secret) {
          if (signal.aborted) throw new CliFailure('cancelled')
          reference = { source: 'file', id: join(destination, 'app-secret') }
          await writeFile(reference.id, secret, { flag: 'wx', mode: 0o600 })
        }
        if (signal.aborted) throw new CliFailure('cancelled')
        await writeFile(join(destination, 'config.json'), JSON.stringify({ apps: [{ appId, brand: app.brand, appSecret: reference,
          lang: 'zh_cn', strictMode: 'bot', defaultAs: 'bot', users: [] }] }), { flag: 'wx', mode: 0o600 })
        if (signal.aborted) throw new CliFailure('cancelled')
        return this.io('feishu', cli.executable, destination)
      } finally { secret?.fill(0) }
    } catch (error) { throw error instanceof CliFailure ? error : new CliFailure('save_failed') }
  }
  io(platform: CliPlatform, executable: string | undefined, configDir: string): CliIo {
    const file = executable ?? this.binary(platform)
    return { executable: file, configDir, run: (args, options) => runCli(file, args, options, cliEnvironment(platform, configDir), configDir) }
  }
  async wrapper(cli: CliIo): Promise<string> {
    if (process.platform === 'win32') throw new CliFailure('unsupported_platform')
    await checkDirectoryChain(cli.configDir)
    const name = `lark-bot-${randomUUID()}`
    const file = join(cli.configDir, name), scriptFile = join(cli.configDir, `${name}.mjs`)
    const keys = Object.keys(cliEnvironment('feishu', cli.configDir)).filter(key => !key.startsWith('LARKSUITE_') && !['NO_COLOR', 'TERM', 'CI', 'DO_NOT_TRACK'].includes(key))
    const program = `import { spawn } from 'node:child_process';\nconst env = {};\nfor (const key of ${JSON.stringify(keys)}) if (process.env[key] !== undefined) env[key] = process.env[key];\nObject.assign(env, ${JSON.stringify({ LARKSUITE_CLI_CONFIG_DIR: cli.configDir, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1', NO_COLOR: '1', DO_NOT_TRACK: '1' })});\nconst child = spawn(${JSON.stringify(cli.executable)}, process.argv.slice(2), { env, shell: false, stdio: 'inherit' });\nfor (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill(signal); });\nchild.once('error', () => { process.stderr.write('Feishu CLI could not start.\\n'); process.exitCode = 1; });\nchild.once('close', code => { process.exitCode = code ?? 1; });\n`
    await writeFile(scriptFile, program, { flag: 'wx', mode: 0o600 })
    const cleanEnvironment = keys.map(key => `${key}="\${${key}-}"`).join(' ')
    await writeFile(file, `#!/bin/sh\nexec /usr/bin/env -i ${cleanEnvironment} ${quote(process.execPath)} ${quote(scriptFile)} "$@"\n`, { flag: 'wx', mode: 0o700 })
    return file
  }
  private async npm(): Promise<string> {
    for (const directory of [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter)]) {
      if (!directory || !isAbsolute(directory)) continue
      try { const file = await realpath(join(directory, 'npm')); await access(file, constants.X_OK); return file } catch { /* Try the next fixed command location. */ }
    }
    throw new CliFailure('install_failed')
  }
  private async install(platform: CliPlatform, signal: AbortSignal): Promise<string> {
    // The service and its existing command shims use POSIX shells. Preserve manual setup on other hosts.
    if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) throw new CliFailure('unsupported_platform')
    const root = await privateDirectory(this.stateDir, 'managed-im', 'cli')
    const staging = await privateDirectory(root, `install-${platform}-${randomUUID()}`)
    const release = CLI_RELEASES[platform]
    const env = cliEnvironment(platform, staging)
    env.PATH = [dirname(process.execPath), env.PATH ?? ''].join(delimiter)
    const npmrc = join(staging, '.npmrc')
    await writeFile(npmrc, '', { mode: 0o600, flag: 'wx' })
    env.NPM_CONFIG_USERCONFIG = npmrc
    env.NPM_CONFIG_CACHE = await privateDirectory(this.stateDir, 'managed-im', 'npm-cache')
    env.DWS_NO_SKILLS = '1'
    try {
      await runCli(await this.npm(), ['install', '--prefix', staging, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact',
        '--registry=https://registry.npmjs.org', `${release.package}@${release.version}`], { signal, timeoutMs: 10 * 60_000 }, env, staging)
      const packageDir = join(staging, 'node_modules', release.package)
      const metadata = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as { name?: string; version?: string }
      if (metadata.name !== release.package || metadata.version !== release.version) throw new CliFailure('install_failed')
      // These exact official installers only prepare native binaries; dws skill installation is explicitly disabled.
      await runCli(process.execPath, [join(packageDir, release.installer)], { signal, timeoutMs: 10 * 60_000 }, env, packageDir)
      const binary = join(packageDir, release.binary)
      await checkDirectoryChain(dirname(binary)); const file = await lstat(binary)
      if (!file.isFile() || file.isSymbolicLink()) throw new CliFailure('install_failed')
      const version = await runCli(binary, ['--version'], { signal, timeoutMs: 30_000 }, env, staging)
      if (![...`${version.stdout}\n${version.stderr}`.matchAll(/\b(?:v)?(\d+\.\d+\.\d+)(?![\d.])/g)].some(match => match[1] === release.version)) throw new CliFailure('install_failed')
      if (signal.aborted) throw new CliFailure('cancelled')
      await writeFile(join(staging, 'installed.json'), JSON.stringify({ version: release.version }), { mode: 0o600, flag: 'wx' })
      const destination = this.destination(platform)
      await checkDirectoryChain(root)
      if (resolve(staging).startsWith(root + sep) && dirname(destination) === root) await rename(staging, destination)
      else throw new CliFailure('install_failed')
      return this.binary(platform)
    } catch (error) {
      // Remove only this attempt's checked directory. Never touch an installed binary or another account configuration.
      try { await checkDirectoryChain(staging); if (dirname(resolve(staging)) === root && staging.split(sep).at(-1)!.startsWith(`install-${platform}-`)) await rm(staging, { recursive: true }) } catch { /* Leave an unsafe or already-removed path alone. */ }
      throw error instanceof CliFailure && ['cancelled', 'expired', 'unsupported_platform'].includes(error.code) ? error : new CliFailure('install_failed')
    }
  }
}
