#!/usr/bin/env node
// Operator-only login: credentials are written privately and are never printed.
import { access } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { beginWechatLogin, completeWechatLogin } from '../lib/wechat-login.js'

const file = process.argv[2]
if (!file || !isAbsolute(file)) {
  process.stderr.write('Usage: node scripts/wechat-login.mjs /absolute/private-directory/wechat.json [--replace]\n')
  process.exitCode = 1
} else {
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  try {
    const exists = await access(file).then(() => true, () => false)
    if (exists && !process.argv.includes('--replace')) throw new Error('Credential file already exists; use --replace only to reauthenticate this bot')
    const login = await beginWechatLogin(controller.signal)
    process.stdout.write('Scan this one-time login link with your personal WeChat and confirm the bot login:\n')
    try {
      const qr = await import('qrcode-terminal')
      qr.default.generate(login.url, { small: true })
    } catch { process.stdout.write('Optional local QR renderer: qrcode-terminal; the login link is below.\n') }
    process.stdout.write(`${login.url}\n`)
    const result = await completeWechatLogin(login.qrcode, file, controller.signal, async () => {
      const input = createInterface({ input: process.stdin, output: process.stdout })
      try { return await input.question('Enter the verification code shown by WeChat: ') } finally { input.close() }
    })
    process.stdout.write(`Credentials saved privately. accountId: ${result.accountId}\n`)
    if (result.userId) process.stdout.write(`Your policy sender ID: ${result.userId}\n`)
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'WeChat login failed'}\n`); process.exitCode = 1 }
}
