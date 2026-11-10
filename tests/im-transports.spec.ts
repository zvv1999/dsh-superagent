import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import NodeWebSocket, { WebSocketServer } from 'ws'
import { dingtalkEvent, dingtalkTransport, DINGTALK_TOPIC, listenDingtalk, type StreamSocket } from '../src/sources/im-dingtalk.ts'
import { wechatTransport, wechatBaseUrl } from '../src/sources/im-wechat.ts'
import { ImConfigSchema, type ImEvent } from '../src/sources/im.ts'
import { imJson, parseImJson, readPrivateJson, writePrivateJson } from '../src/sources/im-http.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { OutboundMessage } from '../src/core/index.ts'
import { key } from '../src/core/index.ts'
import { deferred, track, waitUntil } from './fixtures/async.ts'

const directories: string[] = []
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
const temporary = async () => { const directory = await mkdtemp(join(tmpdir(), 'superagent-im-')); directories.push(directory); return directory }
const signal = () => new AbortController().signal
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
const event = { msgId: 'm1', conversationId: 'team', conversationType: '2', senderId: 'opaque', senderStaffId: 'alice',
  chatbotUserId: 'robot', robotCode: 'bot', isInAtList: true, createAt: 1794096000000, msgtype: 'text', text: { content: 'fix #12' } }
function socket() {
  const listeners = new Map<string, Set<(event: { data?: unknown }) => void>>()
  const transport: StreamSocket = { readyState: 1,
    addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(fn) },
    removeEventListener: (type, fn) => { listeners.get(type)?.delete(fn) },
    on: (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(fn) },
    off: (type, fn) => { listeners.get(type)?.delete(fn) }, ping: vi.fn(), terminate: vi.fn(), send: vi.fn(), close: vi.fn() }
  return { transport, listeners, emit: (type: string, data?: unknown) => { for (const listener of listeners.get(type) ?? []) listener({ data }) } }
}
it('acks DingTalk only after durable intake and keeps heartbeats, disconnects and aborts bounded', async () => {
  const f = socket(), ready = vi.fn(), stored = deferred(), receive = vi.fn(() => stored.promise), controller = new AbortController()
  const running = listenDingtalk(f.transport, ImConfigSchema.parse({ accountId: 'bot' }), 'bot', receive, ready, controller.signal)
  f.emit('open')
  expect(ready).toHaveBeenCalledOnce()
  const headers = { messageId: 'frame1', topic: DINGTALK_TOPIC }
  f.emit('message', JSON.stringify({ type: 'CALLBACK', headers, data: JSON.stringify(event) }))
  await waitUntil(() => receive.mock.calls.length === 1)
  expect(f.transport.send).not.toHaveBeenCalled()
  stored.resolve()
  await waitUntil(() => vi.mocked(f.transport.send).mock.calls.length === 1)
  expect(JSON.parse(vi.mocked(f.transport.send).mock.calls[0]![0])).toMatchObject({ code: 200, headers: { messageId: 'frame1' } })
  f.emit('message', JSON.stringify({ type: 'SYSTEM', headers: { topic: 'ping', messageId: 'ping' }, data: 'alive' }))
  await waitUntil(() => vi.mocked(f.transport.send).mock.calls.length === 2)
  controller.abort(); await running
  expect(f.transport.terminate).toHaveBeenCalledOnce()
  expect([...f.listeners.values()].every(set => set.size === 0)).toBe(true)
})
it('does not acknowledge a failed intake, and drops raw error details before reconnecting', async () => {
  const f = socket()
  const running = listenDingtalk(f.transport, ImConfigSchema.parse({ accountId: 'bot' }), 'bot', async () => { throw new Error('secret in provider input') }, () => {}, signal())
  const rejected = expect(running).rejects.toThrow('intake failed')
  f.emit('message', JSON.stringify({ type: 'CALLBACK', headers: { topic: DINGTALK_TOPIC, messageId: '1' }, data: JSON.stringify(event) }))
  await rejected
  expect(f.transport.send).not.toHaveBeenCalled()
  expect(f.transport.terminate).toHaveBeenCalledOnce()
})
it('probes idle DingTalk connections and keeps them alive while pong responses arrive', async () => {
  vi.useFakeTimers()
  const f = socket(), controller = new AbortController()
  const running = track(listenDingtalk(f.transport, ImConfigSchema.parse({ accountId: 'bot' }), 'bot', async () => {}, () => {}, controller.signal))
  try {
    for (let pulse = 1; pulse <= 6; pulse++) {
      await vi.advanceTimersByTimeAsync(20_000)
      expect(f.transport.ping).toHaveBeenCalledTimes(pulse)
      f.emit('pong')
      expect(running.settled).toBe(false)
    }
  } finally { controller.abort(); await running.promise }
  expect([...f.listeners.values()].every(set => set.size === 0)).toBe(true)
})
it('reconnects an open DingTalk socket that stops answering probes and clears heartbeat timers', async () => {
  vi.useFakeTimers()
  const f = socket(), controller = new AbortController()
  const running = track(listenDingtalk(f.transport, ImConfigSchema.parse({ accountId: 'bot' }), 'bot', async () => {}, () => {}, controller.signal))
  try {
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.transport.ping).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(running.error).toMatchObject({ message: 'DingTalk Stream heartbeat timed out' })
    expect(f.transport.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  } finally { controller.abort(); await running.promise.catch(() => {}) }
})
it('keeps a real loopback WebSocket alive through two minutes without application messages', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }), controller = new AbortController()
  const connected = deferred<NodeWebSocket>()
  server.on('connection', peer => connected.resolve(peer))
  let running: Promise<void> | undefined
  try {
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected loopback TCP address')
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    const client = new NodeWebSocket(`ws://127.0.0.1:${address.port}`)
    client.on('error', () => {})
    const ready = deferred(), receive = vi.fn(async () => {})
    running = listenDingtalk(client, ImConfigSchema.parse({ accountId: 'bot' }), 'bot', receive, ready.resolve, controller.signal)
    const state = track(running)
    await ready.promise
    const peer = await connected.promise
    for (let pulse = 0; pulse < 6; pulse++) {
      const pong = new Promise<void>(resolve => client.once('pong', () => resolve()))
      await vi.advanceTimersByTimeAsync(20_000)
      await pong
      expect(state.settled).toBe(false)
    }
    expect(peer.readyState).toBe(NodeWebSocket.OPEN)
    expect(receive).not.toHaveBeenCalled()
    controller.abort(); await running
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    controller.abort(); await running?.catch(() => {}); vi.useRealTimers()
    for (const peer of server.clients) peer.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
it.each([true, false])('DingTalk sends to the original direct=%s conversation with only the bot token in request headers', async direct => {
  const directory = await temporary(), file = join(directory, 'ding.json')
  await writePrivateJson(file, { clientId: 'bot', clientSecret: 'SECRET' })
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ accessToken: 'TOKEN', expireIn: 7200 })).mockResolvedValueOnce(response({ processQueryKey: 'receipt' }))
  vi.stubGlobal('fetch', fetcher)
  const connection = await dingtalkTransport.connect(ImConfigSchema.parse({ accountId: 'bot', credentialsFile: file }), {} as SourceContext, signal())
  const message: OutboundMessage = { id: 'out', text: 'Done', kind: 'reply', channel: { source: 'dingtalk', thread: 'thread', address: { conversationId: 'team', senderId: 'alice', direct: String(direct) } } }
  const commit = await connection.prepare(message, signal())
  expect(fetcher).toHaveBeenCalledOnce()
  await commit()
  const [url, init] = fetcher.mock.calls[1]!
  expect(String(url)).toContain(direct ? '/oToMessages/batchSend' : '/groupMessages/send')
  expect(init!.headers).toMatchObject({ 'x-acs-dingtalk-access-token': 'TOKEN' })
  expect(JSON.parse(String(init!.body))).toMatchObject({ robotCode: 'bot', msgKey: 'sampleText', ...(direct ? { userIds: ['alice'] } : { openConversationId: 'team' }) })
  expect(init!.body).not.toContain('SECRET')
  expect(init!.body).not.toContain('TOKEN')
})
it('rejects DingTalk credentials for another app before opening a connection', async () => {
  const directory = await temporary(), file = join(directory, 'ding.json')
  await writePrivateJson(file, { clientId: 'other', clientSecret: 'SECRET' })
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  await expect(dingtalkTransport.connect(ImConfigSchema.parse({ accountId: 'bot', credentialsFile: file }), {} as SourceContext, signal())).rejects.toThrow('does not match')
  expect(fetcher).not.toHaveBeenCalled()
})
const wx = { message_id: '18446744073709551615', from_user_id: 'alice', to_user_id: 'bot', create_time_ms: 1794096000000,
  message_type: 1, message_state: 2, item_list: [{ type: 1, text_item: { text: 'fix #12' } }], context_token: 'CONTEXT_SECRET' }
it('persists WeChat context privately, advances cursors only after intake, and recovers both after restart', async () => {
  const directory = await temporary(), file = join(directory, 'wechat.json')
  await writePrivateJson(file, { token: 'TOKEN_SECRET', botId: 'bot' })
  const config = ImConfigSchema.parse({ accountId: 'bot', credentialsFile: file })
  const host = { deployment: { stateDir: directory } } as SourceContext
  const statePath = join(directory, 'im-private', `wechat-${key('bot')}.json`)
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ msgs: [wx], get_updates_buf: 'next' }))
  vi.stubGlobal('fetch', fetcher)
  const first = await wechatTransport.connect(config, host, signal())
  await expect(first.listen(async () => { throw new Error('storage unavailable') }, () => {}, signal())).rejects.toThrow('storage unavailable')
  expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({ cursor: '', contexts: { alice: { token: 'CONTEXT_SECRET' } } })
  const controller = new AbortController()
  fetcher.mockResolvedValueOnce(response({ msgs: [wx], get_updates_buf: 'next' }))
  const received = vi.fn(async (_event: ImEvent) => { controller.abort() })
  const second = await wechatTransport.connect(config, host, signal())
  await second.listen(received, () => {}, controller.signal)
  expect(received.mock.calls[0]![0]).not.toHaveProperty('contextToken')
  expect(JSON.stringify(received.mock.calls)).not.toContain('CONTEXT_SECRET')
  expect(JSON.parse(await readFile(statePath, 'utf8')).cursor).toBe('next')
  if (process.platform !== 'win32') expect((await stat(statePath)).mode & 0o777).toBe(0o600)
  const third = await wechatTransport.connect(config, host, signal())
  fetcher.mockResolvedValueOnce(response({ ret: 0, message_id: '999' }))
  const reply: OutboundMessage = { id: 'reply1', text: 'Done', kind: 'reply', channel: { source: 'wechat', thread: 'thread', address: { conversationId: 'alice', senderId: 'alice', direct: 'true' } } }
  const commit = await third.prepare(reply, signal())
  expect(await commit()).toBe('999')
  const [, init] = fetcher.mock.calls.at(-1)!
  expect(JSON.parse(String(init!.body))).toMatchObject({ msg: { to_user_id: 'alice', client_id: 'dsh-reply1', context_token: 'CONTEXT_SECRET', message_type: 2 } })
  expect(init!.headers).toMatchObject({ Authorization: 'Bearer TOKEN_SECRET' })
})
it('rejects malicious WeChat API origins and preserves uint64 message IDs', () => {
  expect(wechatBaseUrl('https://ilinkai.weixin.qq.com/')).toBe('https://ilinkai.weixin.qq.com')
  for (const url of ['http://ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com.evil.test', 'https://user:secret@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com/path', 'https://127.0.0.1']) expect(() => wechatBaseUrl(url)).toThrow()
  expect(parseImJson('{"message_id":18446744073709551615,"text":"ok"}')).toMatchObject({ message_id: '18446744073709551615' })
})
it('redacts response bodies and fetch errors, disables redirects and separates definite rejection from unknown outcome', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ message: 'TOKEN_SECRET' }, 401))
    .mockRejectedValueOnce(new Error('https://secret.example/TOKEN_SECRET'))
    .mockResolvedValueOnce(response({ ret: -14, errmsg: 'TOKEN_SECRET' }))
  vi.stubGlobal('fetch', fetcher)
  await expect(imJson('https://example.test', {}, signal())).rejects.toMatchObject({ rejected: true, message: 'IM API returned HTTP 401' })
  await expect(imJson('https://example.test', {}, signal())).rejects.toMatchObject({ rejected: false, message: 'IM request failed or timed out' })
  await expect(imJson('https://example.test', {}, signal())).rejects.toMatchObject({ rejected: true, message: 'IM API rejected the request (code -14)' })
  expect(fetcher.mock.calls[0]![1]!.redirect).toBe('error')
})
it('refuses public-readable or malformed credential files without exposing their content', async () => {
  const directory = await temporary(), file = join(directory, 'secret.json')
  await writeFile(file, 'TOKEN_SECRET', { mode: 0o600 })
  await expect(readPrivateJson(file)).rejects.toThrow('Cannot read private IM file')
  if (process.platform !== 'win32') {
    const publicFile = join(directory, 'public.json')
    await writeFile(publicFile, '{"token":"TOKEN_SECRET"}', { mode: 0o644 })
    await expect(readPrivateJson(publicFile)).rejects.toThrow('owner-only')
  }
})
