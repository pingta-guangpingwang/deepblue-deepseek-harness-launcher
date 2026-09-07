import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Internal Desktop protocol, isolated from CLI/app-server execution. Protocol
// reference: buidangminh23/codex-mcp-bridge issue #23 (not a public API contract).
const execFileAsync = promisify(execFile)
const MAX_FRAME = 256 * 1024
export class NativeDeliveryError extends Error {
  constructor(message: string, public readonly uncertain = false) { super(message) }
}

export function splitWindowsArgs(command: string): string[] {
  const args: string[] = []; let value = ''; let quoted = false; let active = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (ch === '\\') {
      let count = 1
      while (command[i + 1] === '\\') { count++; i++ }
      if (command[i + 1] === '"') {
        value += '\\'.repeat(Math.floor(count / 2)); i++
        if (count % 2) value += '"'; else quoted = !quoted
      } else value += '\\'.repeat(count)
      active = true
    } else if (ch === '"') { quoted = !quoted; active = true }
    else if (/\s/.test(ch) && !quoted) { if (active) { args.push(value); value = ''; active = false } }
    else { value += ch; active = true }
  }
  if (quoted) return []
  if (active) args.push(value)
  return args
}

export function nativePipeFromParent(command: string): string | undefined {
  const args = splitWindowsArgs(command)
  if (!/(?:^|[\\/])codex\.exe$/i.test(args[0] || '') || !args.includes('app-server') || args.includes('exec')) return
  const pipes = new Set<string>()
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!
    const config = arg === '-c' || arg === '--config' ? args[++i] : arg.startsWith('--config=') ? arg.slice(9) : ''
    if (!config?.startsWith('mcp_servers.codex_app=')) continue
    // Match only the codex_app environment table. Reject ambiguity rather than
    // searching other sessions/processes for an endpoint that happens to work.
    const env = /(?:^|[,\s{])"?env"?\s*=\s*\{([^{}]*)\}/.exec(config)?.[1]
    if (!env) continue
    const matches = [...env.matchAll(/(?:^|,)\s*"?CODEX_APP_TOOLS_PIPE_PATH"?\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*(?=,|$)/g)]
    if (matches.length !== 1) return
    try {
      const raw = matches[0]![1]!; const pipe = raw.startsWith('"') ? JSON.parse(raw) : raw.slice(1, -1)
      if (typeof pipe !== 'string' || !/^\\\\\.\\pipe\\[^\\]+/i.test(pipe) || /[\r\n\0]/.test(pipe)) return
      pipes.add(pipe)
    } catch { return }
  }
  return pipes.size === 1 ? [...pipes][0] : undefined
}

export async function discoverNativePipe(parentPid = process.ppid): Promise<string | undefined> {
  if (process.env.CODEX_APP_TOOLS_PIPE_PATH) return process.env.CODEX_APP_TOOLS_PIPE_PATH
  if (process.platform !== 'win32' || !Number.isSafeInteger(parentPid) || parentPid <= 0) return
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${parentPid}'; if ($p.Name -eq 'codex.exe') { $p.CommandLine | ConvertTo-Json -Compress }`],
  { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024 })
  return stdout.trim() ? nativePipeFromParent(JSON.parse(stdout.trim())) : undefined
}

export function nativeCall(pipe: string, executor: string, tool: string, args: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
  if (!/^[a-f0-9-]{36}$/i.test(executor)) return Promise.reject(new NativeDeliveryError('桌面桥接执行上下文无效'))
  const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    namespace: 'codex_app', tool, arguments: args, threadId: executor, turnId: randomUUID(), callId: randomUUID()
  } }))
  if (payload.length > MAX_FRAME) return Promise.reject(new NativeDeliveryError('消息超过桌面桥接大小限制'))
  return new Promise((resolve, reject) => {
    let sent = false; let done = false; let buffer: Buffer = Buffer.alloc(0)
    const socket = net.connect(pipe)
    const finish = (error?: Error, result?: unknown): void => {
      if (done) return; done = true; clearTimeout(timer); socket.destroy()
      if (error) reject(error); else resolve(result)
    }
    const fail = (): void => finish(new NativeDeliveryError(sent ? '桌面发送结果未确认；可能已经送达，请查看原对话，禁止自动重发' : '桌面桥接未连接，请检查 Codex 是否已启动', sent))
    const timer = setTimeout(fail, timeoutMs)
    socket.on('connect', () => {
      const header = Buffer.alloc(4); header.writeUInt32LE(payload.length)
      sent = true; socket.write(Buffer.concat([header, payload]))
    })
    socket.on('error', fail); socket.on('close', () => { if (!done) fail() })
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_FRAME) { finish(new NativeDeliveryError('桌面响应超过限制', sent)); return }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0)
        if (!length || length > MAX_FRAME) { finish(new NativeDeliveryError('桌面协议响应无效', sent)); return }
        if (buffer.length < length + 4) return
        try {
          const response = JSON.parse(buffer.subarray(4, length + 4).toString('utf8')); buffer = buffer.subarray(length + 4)
          if (response.id !== 1) continue
          if (response.error) finish(new NativeDeliveryError('Codex 拒绝原生调用：' + String(response.error.message || '未知错误'), sent))
          else if (response.result !== undefined) finish(undefined, response.result)
          else finish(new NativeDeliveryError('桌面响应缺少确认', sent))
        } catch { finish(new NativeDeliveryError('桌面协议解析失败', sent)) }
      }
    })
  })
}

export function unwrapNativeResult(raw: unknown): Record<string, unknown> {
  let result = raw as Record<string, unknown>
  if (result?.isError) throw new NativeDeliveryError('Codex 原生工具返回错误', true)
  if (result?.structuredContent) result = result.structuredContent as Record<string, unknown>
  else if (Array.isArray(result?.contentItems || result?.content)) {
    const items = (result.contentItems || result.content) as Array<{ type?: string; text?: string }>
    const text = items.find(item => item.type === 'text' || item.type === 'inputText')?.text
    if (text) { try { result = JSON.parse(text) } catch { /* preserve original response */ } }
  }
  return result
}
