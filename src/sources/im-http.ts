/** Private IM credentials and bounded, redacted JSON transport. No provider payload enters error messages. */
import { constants } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

/** A safe transport failure; only an explicit provider rejection permits automatic delivery retry. */
export class ImError extends Error {
  constructor(message: string, readonly rejected = false) { super(message) }
}
export const privateFile = z.string().refine(value => value === '' || isAbsolute(value), 'Use an absolute credential file path').default('')
export async function readPrivateJson(file: string, optional = false): Promise<unknown> {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const info = await handle.stat()
    if (!info.isFile() || info.size > 2 * 1024 * 1024 || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error()
    return JSON.parse(await handle.readFile('utf8')) as unknown
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new ImError('Cannot read private IM file; use a regular JSON file with owner-only permissions')
  } finally { await handle?.close() }
}
export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await stat(directory)
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new ImError('IM private directory must have owner-only permissions')
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}
export async function credentials<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  const result = schema.safeParse(await readPrivateJson(file))
  if (!result.success) throw new ImError('IM credential file has an invalid shape; see docs/im.md')
  return result.data
}
/** Preserve uint64 WeChat message IDs before JSON.parse can round them. */
export const parseImJson = (text: string): unknown => JSON.parse(text.replace(/("message_id"\s*:\s*)(\d+)(?=\s*[,}])/g, '$1"$2"')) as unknown
export async function imJson(url: string, init: RequestInit, signal: AbortSignal, timeoutMs = 15000): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) })
    if (!response.ok) { await response.body?.cancel(); throw new ImError(`IM API returned HTTP ${response.status}`, response.status >= 400 && response.status < 500) }
    const reader = response.body?.getReader()
    if (!reader) throw new ImError('IM API returned an empty response')
    const chunks: Uint8Array[] = []; let size = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.length
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new ImError('IM API response exceeds the size limit') }
        chunks.push(part.value)
      }
    } finally { reader.releaseLock() }
    const parsed = z.record(z.string(), z.unknown()).safeParse(parseImJson(Buffer.concat(chunks).toString('utf8')))
    if (!parsed.success) throw new ImError('IM API returned an invalid response')
    for (const field of ['ret', 'errcode']) {
      const code = parsed.data[field]
      if (typeof code === 'number' && code !== 0) throw new ImError(`IM API rejected the request (code ${code})`, true)
    }
    return parsed.data
  } catch (error) {
    if (signal.aborted) throw new ImError('IM operation stopped')
    if (error instanceof ImError) throw error
    throw new ImError('IM request failed or timed out')
  }
}
export const postJson = (body: unknown, headers: Record<string, string> = {}): RequestInit =>
  ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
