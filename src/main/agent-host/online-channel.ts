import { randomUUID } from 'node:crypto'
type Data = Record<string, any>
interface Options {
  ticket(channel: string): Promise<Data>
  request(command: string, input: Data, id: string): Promise<Data>
  current(): boolean
  changed(connected: boolean): void
}
/** Outbound online channel. Tokens and live file URLs never enter renderer state. */
export class LocalOnlineChannel {
  readonly channel = randomUUID().replaceAll('-', '')
  private controller?: AbortController
  private renewTimer?: ReturnType<typeof setInterval>
  private ticketValue?: Data
  private running = false
  private active = new Set<AbortController>()
  constructor(private options: Options) {}
  start(): void {
    if (this.running || !this.options.current()) return
    this.running = true; this.controller = new AbortController()
    void this.connect(this.controller).catch(() => {}).finally(() => { this.running = false; this.options.changed(false); clearInterval(this.renewTimer); this.renewTimer = undefined; for (const operation of this.active) operation.abort(); this.active.clear() })
  }
  private async freshTicket(): Promise<Data> {
    const value = await this.options.ticket(this.channel), url = new URL(value.relayUrl)
    if (url.origin !== 'https://ailishishu.com' || !url.pathname.endsWith('/v2/local') || url.search || url.username || url.password || typeof value.token !== 'string' || !this.options.current()) throw new Error('在线通道不可用')
    this.ticketValue = value; return value
  }
  private async connect(controller: AbortController): Promise<void> {
    const ticket = await this.freshTicket()
    const response = await fetch(ticket.relayUrl + '/connect', { headers: { authorization: `Bearer ${ticket.token}` }, redirect: 'error', signal: controller.signal })
    if (!response.ok || !response.body || !this.options.current()) throw new Error('在线通道未连接')
    this.options.changed(true)
    let renewing = false
    this.renewTimer = setInterval(() => {
      if (!this.options.current()) { this.stop(); return }
      if (renewing) return; renewing = true
      void this.freshTicket().then(async value => {
        const renew = await fetch(value.relayUrl + '/renew', { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${value.token}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) })
        if (!renew.ok) this.stop()
      }).catch(() => this.stop()).finally(() => { renewing = false })
    }, 20000)
    const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = ''
    try {
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read(); if (done) break
        pending += decoder.decode(value, { stream: true }); if (pending.length > 3 * 1024 * 1024) throw new Error('在线请求过大')
        let boundary: number
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2)
          if (!frame.startsWith('event: request\n')) continue
          const request = JSON.parse(frame.slice(frame.indexOf('data: ') + 6))
          void this.respond(request, controller.signal).catch(() => {})
        }
      }
    } finally { await reader.cancel().catch(() => {}) }
  }
  private async respond(request: Data, channelSignal: AbortSignal): Promise<void> {
    if (!this.options.current() || !this.ticketValue || !/^[a-f0-9]{32}$/.test(request.id || '') || this.active.size >= 8) return
    const controller = new AbortController(); this.active.add(controller)
    const signal = AbortSignal.any([controller.signal, channelSignal, AbortSignal.timeout(request.command === 'stream_file' ? 10 * 60 * 1000 : 35000)])
    let body: BodyInit | ReadableStream<Uint8Array>, headers: Record<string, string>, status = 200
    try {
      try {
        if (request.command === 'stream_file') {
          const file = await this.options.request('preview_file', request.input, request.requestId)
          const url = new URL(file.url)
          if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\/file\/[\w-]{43}$/.test(url.pathname)) throw new Error('文件通道无效')
          const source = await fetch(file.url, { headers: request.input.range ? { range: String(request.input.range) } : {}, signal, redirect: 'error' })
          if (!source.ok || !source.body) throw new Error('本地文件不可用')
          status = source.status; body = source.body; headers = {}
          for (const key of ['content-type', 'content-length', 'content-range', 'etag', 'accept-ranges', 'content-disposition']) { const value = source.headers.get(key); if (value) headers[key] = value }
          headers['x-local-sha256'] = file.file.sha256
          if (request.input.download) headers['content-disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(file.file.name)
        } else {
          const allowed = ['snapshot', 'create_room', 'read_room', 'read_event', 'send_room', 'cancel_run', 'reconcile_run', 'accept_run', 'preflight_merge', 'set_permission', 'decide_approval']
          if (!allowed.includes(request.command)) throw new Error('网页不支持此操作')
          const result = await this.options.request(request.command, request.input, request.requestId)
          body = JSON.stringify({ ok: true, result }); headers = { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(body)) }
        }
      } catch { status = 409; body = JSON.stringify({ ok: false, error: 'local_request_rejected', message: '本地未确认此操作，请检查当前房间、权限及原生状态' }); headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } }
      if (!this.options.current() || !this.ticketValue) return
      await fetch(this.ticketValue.relayUrl + '/respond/' + request.id, { method: 'POST', body, headers: { ...headers, authorization: `Bearer ${this.ticketValue.token}`, 'x-local-status': String(status) }, redirect: 'error', signal, duplex: 'half' } as RequestInit)
    } finally { this.active.delete(controller) }
  }
  stop(): void { this.controller?.abort(); clearInterval(this.renewTimer); this.ticketValue = undefined; this.options.changed(false); for (const operation of this.active) operation.abort() }
}
