import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

type Json = Record<string, any>
const FRAME_LIMIT = 512 * 1024 * 1024
const VIEW_LIMIT = 8 * 1024 * 1024
const HEAD_LIMIT = 64 * 1024
const STRING_LIMIT = 16 * 1024
const OVERSIZED_RETRY_MS = 60_000
export const TRUNCATED_NATIVE_VALUE = '\u0000shenlan-native-value-too-large\u0000'

/** Stream frames without retaining large embedded history/images. Unknown or
 * oversized approval fields are marked, never silently approved after cropping.
 * Frames above the view budget are drained: only a bounded head prefix is kept
 * so the caller can attribute them, and the channel survives for other threads. */
export class DesktopFrameReader {
  private header = Buffer.alloc(4)
  private headerBytes = 0
  private remaining = 0
  private decoder = new StringDecoder('utf8')
  private output = ''
  private value = ''
  private inString = false
  private escaped = false
  private unicode = 0
  private truncated = false
  private lastToken = ''
  private keyCandidate = ''
  private property = ''
  private isValue = false
  private oversized = false
  private oversizedSize = 0
  private oversizedHead = ''
  constructor(private receive: (message: Json) => void) {}
  private append(value: string): void {
    this.output += value
    if (this.output.length > VIEW_LIMIT) throw new Error('原生状态超过安全读取限制')
  }
  private parse(text: string): void {
    for (const ch of text) {
      if (!this.inString) {
        if (ch === '"') {
          this.inString = true; this.value = '"'; this.isValue = this.lastToken === ':'
          this.truncated = this.isValue && ['text', 'output', 'aggregatedOutput', 'stdout', 'stderr', 'image_url', 'imageUrl', 'preview', 'body', 'bodyText', 'data'].includes(this.property)
        } else {
          if (ch === ':') this.property = this.keyCandidate
          if (!/\s/.test(ch)) this.lastToken = ch
          this.append(ch)
        }
        continue
      }
      if (this.unicode) { if (!/[0-9a-f]/i.test(ch)) throw new Error('原生 JSON 转义无效'); this.unicode-- }
      else if (this.escaped) { if (!'"\\/bfnrtu'.includes(ch)) throw new Error('原生 JSON 转义无效'); this.unicode = ch === 'u' ? 4 : 0; this.escaped = false }
      else if (ch === '\\') this.escaped = true
      else if (ch === '"') {
        if (!this.isValue) this.keyCandidate = !this.truncated && this.value.length < 260 ? JSON.parse(this.value + '"') : ''
        this.append(this.truncated ? JSON.stringify(TRUNCATED_NATIVE_VALUE) : this.value + '"')
        this.lastToken = '"'; this.inString = false; this.value = ''; continue
      } else if (ch.charCodeAt(0) < 32) throw new Error('原生 JSON 字符无效')
      if (!this.truncated) { this.value += ch; if (this.value.length > STRING_LIMIT) { this.value = ''; this.truncated = true } }
    }
  }
  feed(chunk: Buffer): void {
    let offset = 0
    while (offset < chunk.length) {
      if (!this.remaining) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset)
        chunk.copy(this.header, this.headerBytes, offset, offset + count); offset += count; this.headerBytes += count
        if (this.headerBytes < 4) return
        this.remaining = this.header.readUInt32LE(); this.headerBytes = 0
        if (!this.remaining || this.remaining > FRAME_LIMIT) throw new Error('原生状态帧过大或无效')
        this.oversized = this.remaining > VIEW_LIMIT
        this.oversizedSize = this.remaining
        this.oversizedHead = ''
        this.output = ''; this.lastToken = ''; this.keyCandidate = ''; this.property = ''; this.decoder = new StringDecoder('utf8')
      }
      const count = Math.min(this.remaining, chunk.length - offset)
      if (this.oversized) {
        // 超大帧只保留有界头部用于归属判断，其余字节直接排空，不进入解析状态
        if (this.oversizedHead.length < HEAD_LIMIT) this.oversizedHead += this.decoder.write(chunk.subarray(offset, offset + Math.min(count, HEAD_LIMIT - this.oversizedHead.length)))
      } else {
        this.parse(this.decoder.write(chunk.subarray(offset, offset + count)))
      }
      offset += count; this.remaining -= count
      if (!this.remaining) {
        if (this.oversized) {
          this.oversized = false
          const size = this.oversizedSize, head = this.oversizedHead
          this.oversizedSize = 0; this.oversizedHead = ''
          this.receive({ __shenlanOversizedFrame: true, size, head })
        } else {
          this.parse(this.decoder.end())
          if (this.inString || this.escaped || this.unicode) throw new Error('原生状态未完整写入')
          const result = JSON.parse(this.output); this.output = ''
          this.receive(result)
        }
      }
    }
  }
}

export function applyDesktopPatches(state: Json, patches: unknown): void {
  if (!Array.isArray(patches) || patches.length > 2000) throw new Error('原生增量无效')
  for (const patch of patches) {
    if (!Array.isArray(patch.path) || !patch.path.length || patch.path.length > 30 || patch.path.some((key: unknown) => !['string', 'number'].includes(typeof key) || ['__proto__', 'constructor', 'prototype'].includes(String(key)))) throw new Error('原生增量路径无效')
    if (!['add', 'replace', 'remove'].includes(patch.op)) throw new Error('原生增量操作无效')
    let parent: any = state
    for (const key of patch.path.slice(0, -1)) { if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('原生增量版本已变化'); parent = parent[key] }
    if (!parent || typeof parent !== 'object') throw new Error('原生增量目标无效')
    const key = patch.path.at(-1)
    if (Array.isArray(parent)) {
      if (!Number.isSafeInteger(key) || key < 0 || key > parent.length) throw new Error('原生增量下标无效')
      if (patch.op === 'remove') parent.splice(key, 1)
      else if (patch.op === 'add') parent.splice(key, 0, patch.value)
      else { if (key >= parent.length) throw new Error('原生增量下标已变化'); parent[key] = patch.value }
    } else if (patch.op === 'remove') delete parent[key]
    else parent[key] = patch.value
  }
}

interface Watched { owner: string; revision: number; state?: Json; updatedAt: number; stale?: boolean; staleReason?: string; retryAt?: number }
/** Version-gated follower transport. Never starts/replaces the native router,
 * claims thread ownership, opens a new thread, or answers unsolicited prompts. */
export class DesktopApprovalIpc {
  private protocolError = ''
  private socket?: net.Socket
  private connecting?: Promise<void>
  private clientId = 'initializing-client'
  private pending = new Map<string, { method: string; resolve(value: Json): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private watched = new Map<string, Watched>()
  private reading = new Map<string, Promise<Watched>>()
  private waiters = new Map<string, Set<{ resolve(): void; reject(error: Error): void }>>()
  constructor(private changed: () => void = () => {}, private endpoint = '\\\\.\\pipe\\codex-ipc') {}
  private send(value: Json): void {
    if (!this.socket?.writable) throw new Error('Codex 桌面审批通道未连接')
    const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4)
    if (body.length > 64 * 1024) throw new Error('审批请求超过安全大小')
    header.writeUInt32LE(body.length); this.socket.write(Buffer.concat([header, body]))
  }
  private fail(): void {
    this.clientId = 'initializing-client'; this.socket = undefined
    const error = new Error(this.protocolError || 'Codex 桌面审批通道已断开，未自动重发决定')
    for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(error) }; this.pending.clear()
    for (const values of this.waiters.values()) for (const value of values) value.reject(error)
    this.waiters.clear(); this.watched.clear(); this.changed()
  }
  /** 超大快照无法在安全预算内解析：只做归属判断，标记该线程受限并快速拒绝其等待者，
   * 不影响通道上其他线程。60 秒冷却避免轮询反复触发 100MB+ 快照重传。 */
  private receiveOversized(message: Json): void {
    const head = typeof message.head === 'string' ? message.head : ''
    const pick = (pattern: RegExp): string | null => head.match(pattern)?.[1] ?? null
    if (pick(/"method"\s*:\s*"([^"]+)"/) !== 'thread-stream-state-changed') return
    const thread = pick(/"conversationId"\s*:\s*"([^"]+)"/)
    if (!thread) return
    const watched = this.watched.get(thread)
    if (!watched) return
    const sourceClientId = pick(/"sourceClientId"\s*:\s*"([^"]+)"/)
    if (sourceClientId && sourceClientId !== watched.owner) return
    const targets = pick(/"targetClientIds"\s*:\s*(\[[^[\]]*\])/)
    if (targets && !targets.includes(this.clientId)) return
    watched.stale = true
    watched.staleReason = '原生会话状态超过安全读取限制，未执行决定'
    watched.retryAt = Date.now() + OVERSIZED_RETRY_MS
    for (const waiter of this.waiters.get(thread) || []) waiter.reject(new Error(watched.staleReason))
    this.waiters.delete(thread)
    this.changed()
  }
  private receive(message: Json): void {
    if (message.__shenlanOversizedFrame === true) { this.receiveOversized(message); return }
    if (message.type === 'client-discovery-request') { this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } }); return }
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId); if (!pending) return
      this.pending.delete(message.requestId); clearTimeout(pending.timer)
      if (message.resultType !== 'success' || message.method !== pending.method) pending.reject(new Error('原生审批请求未被确认'))
      else pending.resolve(message)
      return
    }
    if (message.type !== 'broadcast' || message.method !== 'thread-stream-state-changed') return
    const thread = message.params?.conversationId, watched = this.watched.get(thread)
    if (!watched || message.sourceClientId !== watched.owner || message.params?.hostId !== 'local' || message.targetClientIds && !message.targetClientIds.includes(this.clientId)) return
    if (message.version !== 11) {
      watched.stale = true; watched.staleReason = '原生审批版本无法识别，未执行决定'; watched.retryAt = Date.now() + OVERSIZED_RETRY_MS
      for (const waiter of this.waiters.get(thread) || []) waiter.reject(new Error(watched.staleReason))
      this.waiters.delete(thread); this.changed(); return
    }
    const change = message.params.change
    try {
      if (change?.type === 'snapshot' && change.conversationState?.id === thread) { watched.state = change.conversationState; watched.revision = change.revision; watched.stale = false }
      else if (change?.type === 'patches' && watched.state && change.baseRevision === watched.revision) { applyDesktopPatches(watched.state, change.patches); watched.revision = change.revision }
      else { watched.stale = true; return }
      watched.updatedAt = Date.now()
      if (change.type === 'snapshot') { for (const waiter of this.waiters.get(thread) || []) waiter.resolve(); this.waiters.delete(thread) }
      this.changed()
    } catch { watched.stale = true; this.changed() }
  }
  async connect(): Promise<void> {
    if (this.socket?.writable && this.clientId !== 'initializing-client') return
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      this.protocolError = ''
      const socket = net.connect(this.endpoint); this.socket = socket
      const reader = new DesktopFrameReader(message => this.receive(message))
      socket.on('data', chunk => { try { reader.feed(chunk) } catch (error) { this.protocolError = error instanceof Error ? error.message : '原生协议无法识别'; socket.destroy() } })
      socket.on('error', () => socket.destroy()); socket.once('close', () => { if (this.socket === socket) this.fail() })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('Codex 桌面审批通道不可用')) }, 5000)
        socket.once('connect', () => { clearTimeout(timer); resolve() }); socket.once('error', () => { clearTimeout(timer); reject(new Error('Codex 桌面审批通道不可用')) })
      })
      const response = await this.request('initialize', { clientType: 'shenlan-native-approval-follower' }, 0)
      if (typeof response.result?.clientId !== 'string') throw new Error('Codex 审批通道版本无法识别')
      this.clientId = response.result.clientId
    })().finally(() => { this.connecting = undefined })
    return this.connecting
  }
  private request(method: string, params: Json, version: number, targetClientId?: string): Promise<Json> {
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Codex 审批回执超时，不能确认结果')) }, 8000)
      this.pending.set(requestId, { method, resolve, reject, timer })
      try { this.send({ type: 'request', requestId, sourceClientId: this.clientId, version, method, params, targetClientId, timeoutMs: 7000 }) }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error) }
    })
  }
  async read(threadId: string, force = false): Promise<Watched> {
    while (this.reading.has(threadId)) {
      const pending = this.reading.get(threadId)!
      const result = await pending
      if (!force) return result
    }
    const operation = this.readInternal(threadId, force)
    this.reading.set(threadId, operation)
    try { return await operation }
    finally { if (this.reading.get(threadId) === operation) this.reading.delete(threadId) }
  }
  private async readInternal(threadId: string, force = false): Promise<Watched> {
    if (!/^[a-f0-9-]{36}$/i.test(threadId)) throw new Error('原生会话编号无效')
    await this.connect()
    const previous = this.watched.get(threadId)
    if (previous?.staleReason && (previous.retryAt || 0) > Date.now()) throw new Error(previous.staleReason)
    if (!force && previous?.state && !previous.stale) return previous
    if (!previous && this.watched.size >= 8) this.unwatch(this.watched.keys().next().value!)
    const owner = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, 1)
    if (typeof owner.handledByClientId !== 'string') throw new Error('没有找到原会话的桌面拥有者')
    const watched: Watched = { owner: owner.handledByClientId, revision: 0, updatedAt: 0 }
    this.watched.set(threadId, watched)
    await new Promise<void>((resolve, reject) => {
      const values = this.waiters.get(threadId) || new Set(), entry = { resolve: () => { clearTimeout(timer); resolve() }, reject: (error: Error) => { clearTimeout(timer); reject(error) } }
      const timer = setTimeout(() => { values.delete(entry); reject(new Error('原生审批状态未及时返回，未执行决定')) }, 12000)
      values.add(entry); this.waiters.set(threadId, values)
      try { this.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1, sourceClientId: this.clientId, targetClientIds: [watched.owner], params: { hostId: 'local', conversationId: threadId, following: true } }) }
      catch (error) { values.delete(entry); entry.reject(error as Error) }
    })
    if (!watched.state || watched.stale) throw new Error('原生审批状态版本不兼容')
    return watched
  }
  async decide(threadId: string, owner: string, method: string, requestId: string | number, approved: boolean, permissions?: Json): Promise<void> {
    const methods: Record<string, string> = { 'item/commandExecution/requestApproval': 'thread-follower-command-approval-decision', 'item/fileChange/requestApproval': 'thread-follower-file-approval-decision', 'item/permissions/requestApproval': 'thread-follower-permissions-request-approval-response' }
    const route = methods[method]
    if (!route || this.watched.get(threadId)?.owner !== owner) throw new Error('审批不属于当前原生会话')
    const reply = await this.request(route, { conversationId: threadId, requestId, ...(method === 'item/permissions/requestApproval' ? { response: { permissions: approved ? permissions || {} : {}, scope: 'turn' } } : { decision: approved ? 'accept' : 'decline' }) }, 1, owner)
    if (reply.result?.ok !== true && !(reply.result?.method === route && reply.result?.result?.ok === true)) throw new Error('原生界面没有确认接收审批决定')
  }
  unwatch(thread: string): void {
    const watched = this.watched.get(thread)
    if (watched && this.socket?.writable) this.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1, sourceClientId: this.clientId, targetClientIds: [watched.owner], params: { hostId: 'local', conversationId: thread, following: false } })
    this.watched.delete(thread)
  }
  close(): void { for (const thread of this.watched.keys()) this.unwatch(thread); this.socket?.destroy(); this.fail() }
}
