/** Explicit operator-driven WeChat QR login; never called by the Source or by model tools. */
import { z } from 'zod'
import { imJson, ImError, postJson, writePrivateJson } from './im-http.ts'
import { WECHAT_API, wechatBaseUrl, wechatHeaders } from './im-wechat.ts'
import { pause } from './poll.ts'

/** QR payloads are encoded locally by the panel, never fetched as remote images. */
export function wechatQrUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new ImError('Invalid WeChat QR URL') }
  if (url.href.length > 4096 || url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !(url.hostname === 'liteapp.weixin.qq.com' || /^(?:[a-z0-9-]+\.)?ilinkai\.weixin\.qq\.com$/i.test(url.hostname))) {
    throw new ImError('Untrusted WeChat QR URL')
  }
  return url.href
}
export async function beginWechatLogin(signal: AbortSignal): Promise<{ qrcode: string; url: string }> {
  const value = await imJson(`${WECHAT_API}/ilink/bot/get_bot_qrcode?bot_type=3`, postJson({ local_token_list: [] }, wechatHeaders()), signal)
  const result = z.object({ qrcode: z.string().min(1).max(8192), qrcode_img_content: z.string().min(1).max(4096) }).safeParse(value)
  if (!result.success) throw new ImError('WeChat did not return a login QR code')
  return { qrcode: result.data.qrcode, url: wechatQrUrl(result.data.qrcode_img_content) }
}
export interface WechatConfirmation {
  accountId: string
  userId?: string
  /** Host-only secret, never serialize into a panel view or settings. */
  credential: { token: string; botId: string; baseUrl: string }
}
export type WechatPoll = { status: 'waiting' | 'scanned' | 'verification' | 'expired' }
  | { status: 'redirect'; base: string } | { status: 'confirmed'; confirmation: WechatConfirmation }
/** One bounded poll; callers own retry cadence and cancellation. Only trusted API origins receive QR handles or codes. */
export async function pollWechatLogin(qrcode: string, base: string, signal: AbortSignal, code?: string): Promise<WechatPoll> {
  const query = new URLSearchParams({ qrcode, ...(code ? { verify_code: code } : {}) })
  const response = await imJson(`${wechatBaseUrl(base)}/ilink/bot/get_qrcode_status?${query}`, { headers: wechatHeaders() }, signal, 40000)
  if (response.status === 'confirmed') {
    const result = z.object({ bot_token: z.string().min(1).max(16384), ilink_bot_id: z.string().trim().min(1).max(512),
      baseurl: z.string().default(WECHAT_API), ilink_user_id: z.string().trim().max(200).optional() }).safeParse(response)
    if (!result.success) throw new ImError('WeChat login confirmation has no bot account')
    return { status: 'confirmed', confirmation: { accountId: result.data.ilink_bot_id,
      ...(result.data.ilink_user_id ? { userId: result.data.ilink_user_id } : {}),
      credential: { token: result.data.bot_token, botId: result.data.ilink_bot_id, baseUrl: wechatBaseUrl(result.data.baseurl) } } }
  }
  if (response.status === 'need_verifycode') return { status: 'verification' }
  if (response.status === 'scaned_but_redirect' && typeof response.redirect_host === 'string') {
    return { status: 'redirect', base: wechatBaseUrl(`https://${response.redirect_host}`) }
  }
  if (response.status === 'wait') return { status: 'waiting' }
  if (response.status === 'scaned') return { status: 'scanned' }
  if (response.status === 'expired') return { status: 'expired' }
  throw new ImError('WeChat login expired or requires action in WeChat; start login again')
}
export async function completeWechatLogin(qrcode: string, file: string, signal: AbortSignal, verifyCode: () => Promise<string>): Promise<{ accountId: string; userId?: string }> {
  let base = WECHAT_API, code: string | undefined
  const deadline = Date.now() + 5 * 60_000
  while (!signal.aborted && Date.now() < deadline) {
    const response = await pollWechatLogin(qrcode, base, signal, code)
    code = undefined
    if (signal.aborted) break
    if (response.status === 'confirmed') {
      const { accountId, userId, credential } = response.confirmation
      await writePrivateJson(file, credential)
      return { accountId, ...(userId ? { userId } : {}) }
    }
    if (response.status === 'verification') {
      code = (await verifyCode()).trim()
      if (!/^\d{4,12}$/.test(code)) throw new ImError('Invalid WeChat verification code')
    } else if (response.status === 'redirect') base = response.base
    else if (response.status === 'expired') break
    await pause(1000, signal)
  }
  throw new ImError('WeChat login stopped or timed out')
}
