import net from 'node:net'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { NativeDeliveryError } from './native-desktop'

export interface RelayReply { ok: boolean; ready?: boolean; status?: 'delivered' | 'unconfirmed' | 'failed'; baselineTurnId?: string; error?: string; result?: Record<string, unknown> }
export interface RelayConfig { endpoint: string; token: string; executor: string }
export function desktopRelayDirectory(): string {
  return path.join(process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex'), 'shenlan-desktop-relay')
}
export async function desktopRelayRequest(payload: Record<string, unknown>, directory = desktopRelayDirectory(), timeoutMs = 20000): Promise<RelayReply> {
  let config: RelayConfig
  try { config = JSON.parse(await readFile(path.join(directory, 'connection.json'), 'utf8')) }
  catch { throw new NativeDeliveryError('尚未安装 Codex 桌面桥接，请先运行本机桥接安装，然后重新启动 Codex') }
  if (!/^[a-f0-9]{64}$/.test(config.token) || (process.platform === 'win32' ? !/^\\\\\.\\pipe\\shenlan-codex-[a-f0-9]{32}$/.test(config.endpoint) : !config.endpoint.startsWith(directory + path.sep))) throw new NativeDeliveryError('本机桥接配置无效，请重新安装')
  const bytes = Buffer.from(JSON.stringify({ ...payload, token: config.token }) + '\n')
  if (bytes.length > 128 * 1024) throw new NativeDeliveryError('消息超过桥接大小限制')
  return new Promise((resolve, reject) => {
    let sent = false; let done = false; let buffer: Buffer = Buffer.alloc(0)
    const socket = net.connect(config.endpoint)
    const finish = (error?: Error, reply?: RelayReply): void => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(reply!) }
    const fail = (): void => finish(new NativeDeliveryError(sent ? '桥接结果未确认；请查看原对话，不要重复发送' : '桌面桥接未启动；请重新启动 Codex 后刷新本机', sent))
    const timer = setTimeout(fail, timeoutMs)
    socket.on('connect', () => { sent = true; socket.write(bytes) }); socket.on('error', fail); socket.on('close', () => { if (!done) fail() })
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]); if (buffer.length > 256 * 1024) return fail()
      const end = buffer.indexOf(10); if (end < 0) return
      try { finish(undefined, JSON.parse(buffer.subarray(0, end).toString('utf8'))) } catch { fail() }
    })
  })
}
