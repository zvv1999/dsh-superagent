import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { beginWechatLogin, completeWechatLogin, pollWechatLogin, wechatQrUrl } from '../src/sources/im-wechat-login.ts'
const directories: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }) })
it('returns only QR material before confirmation and saves the confirmed token without returning it to callers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'im-login-')); directories.push(dir)
  const file = join(dir, 'wechat.json')
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ qrcode: 'QR_SECRET', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/scan' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'confirmed', bot_token: 'TOKEN_SECRET', ilink_bot_id: 'bot', ilink_user_id: 'alice', baseurl: 'https://ilinkai.weixin.qq.com' })))
  vi.stubGlobal('fetch', fetcher)
  const signal = new AbortController().signal
  const login = await beginWechatLogin(signal)
  expect(login.url).toBe('https://liteapp.weixin.qq.com/q/scan')
  const result = await completeWechatLogin(login.qrcode, file, signal, async () => '')
  expect(result).toEqual({ accountId: 'bot', userId: 'alice' })
  expect(JSON.stringify(result)).not.toContain('TOKEN_SECRET')
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ botId: 'bot', token: 'TOKEN_SECRET', baseUrl: 'https://ilinkai.weixin.qq.com' })
})
it('refuses untrusted login redirects and does not create credentials before confirmed login', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'im-login-')); directories.push(dir)
  const file = join(dir, 'wechat.json')
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: 'scaned_but_redirect', redirect_host: 'evil.example' }))))
  await expect(completeWechatLogin('QR_SECRET', file, new AbortController().signal, async () => '')).rejects.toThrow('Untrusted WeChat API origin')
  await expect(readFile(file)).rejects.toThrow()
})
it.each(['http://liteapp.weixin.qq.com/q', 'https://evil.example/q', 'https://liteapp.weixin.qq.com.evil.example/q',
  'https://user:secret@liteapp.weixin.qq.com/q', 'https://liteapp.weixin.qq.com:444/q', 'javascript:alert(1)'])(
  'refuses an untrusted QR payload %s', value => { expect(() => wechatQrUrl(value)).toThrow() })
it('validates the poll origin before sending QR material and rejects untrusted confirmed credential endpoints', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: 'confirmed', bot_token: 'TOKEN_SECRET',
    ilink_bot_id: 'bot', ilink_user_id: 'alice', baseurl: 'https://evil.example' })))
  vi.stubGlobal('fetch', fetcher)
  const signal = new AbortController().signal
  await expect(pollWechatLogin('QR_SECRET', 'https://evil.example', signal, '123456')).rejects.toThrow('Untrusted')
  expect(fetcher).not.toHaveBeenCalled()
  await expect(pollWechatLogin('QR_SECRET', 'https://ilinkai.weixin.qq.com', signal)).rejects.toThrow('Untrusted')
  expect(fetcher).toHaveBeenCalledOnce()
  expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error')
})
