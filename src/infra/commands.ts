/** Subprocess wrapper for running gh/glab, lark-cli, and git commands under the deployment's configured accounts. */
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Deployment } from '../deployment.ts'

const exec = promisify(execFile)
const TIMEOUT_MS = 90_000
/**
 * Error thrown by Commands when a CLI invocation fails, capturing stderr diagnostics, API error codes, and exit status without echoing command arguments.
 * Source channels and pollers inspect its code to distinguish deleted conversations from retryable failures.
 */
export class CliError extends Error {
  constructor(message: string, readonly code?: number, readonly exitCode?: number) { super(message) }
}
/** Extracts a sanitized error from a failed subprocess without echoing argv, which may contain message text. */
export function commandError(error: unknown, program = 'command'): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  const exitCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    const stderr = error.stderr.trim()
    let parsed: { error?: { code?: number; message?: string } } | undefined
    try { parsed = JSON.parse(stderr.slice(stderr.indexOf('{'))) as typeof parsed }
    catch { /* Non-JSON CLI diagnostics are retained below. */ }
    const code = parsed?.error?.code
    if (parsed?.error?.message) return new CliError(`${parsed.error.message}${code ? ` (${code})` : ''}`, code, exitCode)
    // `gh` exits non-zero on HTTP errors (such as `gh: Not Found (HTTP 404)`) and on `gh: HTTP 304`, which ETag polling relies on.
    if (stderr) return new CliError(stderr.slice(0, 2000), Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || undefined, exitCode)
  }
  return new CliError(`${basename(program)} ${ended(error)}`, undefined, exitCode)
}
function ended(error: unknown): string {
  const { killed, signal, code } = (error ?? {}) as { killed?: boolean; signal?: string | null; code?: unknown }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'printed more output than it may'
  // `execFile` timeout terminates the process with SIGTERM and sets `killed: true`.
  if (killed && signal === 'SIGTERM') return `timed out after ${TIMEOUT_MS / 1000} s`
  if (signal) return `was stopped by ${signal}`
  if (typeof code === 'number') return `exited with code ${code}`
  return typeof code === 'string' ? `could not run: ${code}` : 'failed'
}
export interface Tally { skipped: number }
/** Parses array elements against a schema, skipping invalid items and incrementing `tally.skipped`. */
export function validItems<T>(item: z.ZodType<T>, list: readonly unknown[], tally?: Tally): T[] {
  const items = list.flatMap(value => { const parsed = item.safeParse(value); return parsed.success ? [parsed.data] : [] })
  if (tally) tally.skipped += list.length - items.length
  return items
}
/** Rewrites Feishu error 232011 (bot not in chat) with remediation instructions. */
const membership = (error: unknown): unknown => {
  if (!(error instanceof CliError) || error.code !== 232011) return error
  const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
  return new CliError(hint, error.code, error.exitCode)
}

const gitlabPath = (projectId: number, path: string): string => {
  const pathname = path.split('?', 1)[0] ?? ''
  const decoded = (() => {
    let current = path
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let next: string
      try { next = decodeURIComponent(current) } catch { throw new Error('GitLab calls are restricted to the configured project') }
      if (next === current) return current
      current = next
    }
    return current
  })()
  const decodedPathname = decoded.split('?', 1)[0] ?? ''
  const outside = !Number.isSafeInteger(projectId) || projectId <= 0
    || /^[a-z][a-z0-9+.-]*:/i.test(path) || /^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\')
    || pathname.split('/').some(part => part === '.' || part === '..') || /^projects(?:\/|$)/i.test(pathname)
    || decodedPathname.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(decodedPathname) || /^\//.test(decodedPathname)
    || /^[A-Za-z]:[\\/]/.test(decodedPathname) || /^projects(?:\/|$)/i.test(decodedPathname)
    || decodedPathname.split('/').some(part => part === '.' || part === '..')
  if (outside) throw new Error('GitLab calls are restricted to the configured project')
  return path ? `projects/${projectId}/${path}` : `projects/${projectId}`
}
const gitlabFlags = (flags: readonly string[]): void => {
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!
    if (/^--hostname(?:=|$)/.test(flag) || /^--repo(?:=|$)/.test(flag) || flag === '-R' || /^--api-url(?:=|$)/.test(flag)) {
      throw new Error('GitLab calls cannot override the configured host or project')
    }
    if (flag === '--output' && flags[index + 1] !== 'json' && flags[index + 1] !== 'ndjson') {
      throw new Error('GitLab output must be json or ndjson')
    }
    if (flag.startsWith('--output=') && flag.slice('--output='.length) !== 'json' && flag.slice('--output='.length) !== 'ndjson') {
      throw new Error('GitLab output must be json or ndjson')
    }
  }
}
const gitlabJson = (output: string, includeHeaders: boolean): unknown => {
  const separator = output.search(/\r?\n\r?\n/)
  const length = output.slice(separator, separator + 4) === '\r\n\r\n' ? 4 : 2
  const body = includeHeaders && separator >= 0 ? output.slice(separator + length) : output
  return JSON.parse(body.trim())
}
const gitlabItems = (output: string): unknown[] => {
  const text = output.trim()
  if (!text) return []
  try {
    const value = JSON.parse(text)
    return Array.isArray(value) ? value.flatMap(item => Array.isArray(item) ? item : [item]) : [value]
  } catch {
    return text.split(/\r?\n/).filter(Boolean).flatMap(line => {
      const value: unknown = JSON.parse(line)
      return Array.isArray(value) ? value : [value]
    })
  }
}
/**
 * Executes gh/glab, lark-cli, and git subprocesses with deployment account credentials, timeouts, and abort signals.
 * Restricts GitHub/GitLab API calls to the configured repository/project and translates CLI failures into CliError instances for Sources, MasterAssessor, Outbox, and Settings.
 */
export class Commands {
  /**
   * @param resolved - returns the resolved deployment setup, or throws while setup is still pending.
   * @param environment - variables overriding `process.env` for every command (such as isolated git settings).
   */
  constructor(private readonly resolved: () => Deployment, private readonly environment: Record<string, string | undefined>, private readonly signal: AbortSignal) {}
  get deployment(): Deployment { return this.resolved() }
  get repository(): string { return this.deployment.repository }
  withSignal(signal?: AbortSignal): Commands { return signal ? new Commands(this.resolved, this.environment, AbortSignal.any([this.signal, signal])) : this }
  async run(program: string, args: string[], cwd?: string): Promise<string> {
    try {
      const { stdout } = await exec(program, args, { cwd, signal: this.signal, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...this.environment, GH_PROMPT_DISABLED: '1', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
      return stdout
    } catch (error) { throw commandError(error, program) }
  }
  private githubAccount(): NonNullable<Deployment['github']> {
    const github = this.deployment.github
    if (!github) throw new Error('The GitHub Source is not configured in this deployment')
    return github
  }
  private gitlabAccount(): NonNullable<Deployment['gitlab']> {
    const gitlab = this.deployment.gitlab
    if (!gitlab) throw new Error('The GitLab Source is not configured in this deployment')
    return gitlab
  }
  /** Runs the agent's GitHub CLI and parses its JSON output; callers should prefer `api`, which is restricted to the configured repository and validates output. */
  async gh<T>(args: string[]): Promise<T> { return JSON.parse(await this.run(this.githubAccount().cli, args)) as T }
  /**
   * Calls the GitHub API on a path within the configured repository, validating JSON output when a schema is provided
   * or returning raw CLI output (such as raw files or `--include` headers) when omitted.
   * @throws CliError with GitHub's HTTP status as `code` on failure.
   */
  async api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async api(path: string, ...flags: string[]): Promise<string>
  async api<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    if (typeof schema === 'string') return this.run(this.githubAccount().cli, ['api', this.path(schema), ...rest])
    const [path = '', ...flags] = rest
    return schema.parse(await this.gh(['api', this.path(path), ...flags]))
  }
  /** Fetches all pages of a GitHub API list within the configured repository, skipping items that fail schema validation. */
  async pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const pages = z.array(z.array(z.unknown())).parse(await this.gh(['api', this.path(path), '--paginate', '--slurp']))
    return validItems(item, pages.flat(), tally)
  }
  /** Calls the GitLab API within the resolved project, with the hostname and project ID supplied by setup. */
  async gitlabApi<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async gitlabApi(path: string, ...flags: string[]): Promise<string>
  async gitlabApi<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    const account = this.gitlabAccount()
    const path = typeof schema === 'string' ? schema : rest[0] ?? ''
    const flags = typeof schema === 'string' ? rest : rest.slice(1)
    gitlabFlags(flags)
    const output = await this.run(account.cli, ['api', '--hostname', account.hostname, gitlabPath(account.projectId, path), ...flags])
    return typeof schema === 'string' ? output : schema.parse(gitlabJson(output, flags.includes('--include')))
  }
  /** Fetches all GitLab pages with ndjson output and validates each item, without allowing a project override. */
  async gitlabPages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const output = await this.gitlabApi(path, '--paginate', '--output', 'ndjson')
    return validItems(item, gitlabItems(output), tally)
  }
  private path(path: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error('GitHub calls are restricted to the configured repository')
    return path ? `repos/${this.repository}/${path}` : `repos/${this.repository}`
  }
  /**
   * Runs the Feishu bot's `lark-cli` and returns the JSON `data` payload.
   * @throws CliError with Feishu's error code on failure (rewriting 232011 when the bot is not in the chat).
   */
  async lark<T>(args: string[], cwd?: string): Promise<T> {
    const bot = this.deployment.feishu
    if (!bot) throw new Error('The Feishu Source has no working bot CLI')
    const output = await this.run(bot.cli, [...args, '--as', 'bot', '--format', 'json'], cwd)
      .catch((error: unknown) => { throw membership(error) })
    const result = JSON.parse(output) as { ok: boolean; data: T; error?: { code?: number; message?: string } }
    const code = result.error?.code
    if (!result.ok) throw membership(new CliError(`${result.error?.message ?? 'Feishu command failed'}${code ? ` (${code})` : ''}`, code))
    return result.data
  }
  /** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
  async git(args: string[], cwd: string): Promise<string> { return this.run('git', args, cwd) }
}
