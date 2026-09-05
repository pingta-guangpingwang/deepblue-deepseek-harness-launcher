import { safeStorage } from 'electron'
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { access, mkdir, open, readFile, rename, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AgentAdapter, AgentHostAction, AgentHostSnapshot, AgentWorkspaceRequest, LocalAgentBinding } from '../../shared/agent-host'

export const AGENT_HOST_PROTOCOL = 1
type Reply = Record<string, unknown>
interface Binding extends LocalAgentBinding { key: string; executable: string; executableArgs?: string[]; desiredRunning: boolean; pendingCloudBind?: boolean }
interface CommandResult { agentId: string; status: 'completed' | 'failed'; message: string }
interface SavedState {
  version: 1; installationId: string; ownerUserId: string; deviceId: string; deviceKey: string
  enabled: boolean; agents: Binding[]; commands: Record<string, CommandResult & { state: 'running' | 'done' }>
}
export interface AgentHostOptions {
  storageDir: string
  moduleDir: string
  nodePath: string
  launcherVersion: string
  ownerId: () => string | undefined
  request: (request: AgentWorkspaceRequest) => Promise<Reply>
  chooseDirectory: () => Promise<string | undefined>
  onChange: () => void
  fetch?: typeof fetch
}
const ADAPTERS: Record<AgentAdapter, { name: string; command: string }> = {
  codex: { name: 'Codex', command: 'codex' },
  'claude-code': { name: 'Claude Code', command: 'claude' },
  qclaw: { name: 'QClaw / OpenClaw', command: 'openclaw' }
}
const NPM_PACKAGES: Record<AgentAdapter, string> = { codex: '@openai/codex', 'claude-code': '@anthropic-ai/claude-code', qclaw: 'openclaw' }
function errorText(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/(?:adh_live_|agh_live_|sk-)[\w-]+|Bearer\s+\S+/gi, '[凭据已隐藏]').slice(0, 360)
}
export function safeProjectRoot(root: string): boolean {
  return path.isAbsolute(root) && root !== path.parse(root).root && !/[\x00-\x1f]/.test(root)
}
export async function discoverExecutable(command: string): Promise<string | undefined> {
  // Deliberately bounded: no whole-disk search and no cloud-controlled executable.
  for (const directory of (process.env.Path || process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']) {
      const candidate = path.resolve(directory.replace(/^"|"$/g, ''), command + extension)
      if (await stat(candidate).then((row) => row.isFile()).catch(() => false)) return candidate
    }
  }
  return undefined
}
function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
export async function resolveAgentLaunch(adapter: AgentAdapter, nodePath: string): Promise<{ executable: string; args: string[] } | undefined> {
  const executable = await discoverExecutable(ADAPTERS[adapter].command)
  if (!executable) return
  if (!/\.(cmd|bat)$/i.test(executable)) return { executable, args: [] }
  // Never shell-execute npm shims. Resolve only the known adapter package's bin
  // inside its real node_modules directory; renderer/cloud cannot select a script.
  const modulesRoot = await realpath(path.join(path.dirname(executable), 'node_modules')).catch(() => '')
  if (!modulesRoot) return
  const packageRoot = await realpath(path.join(modulesRoot, NPM_PACKAGES[adapter])).catch(() => '')
  if (!packageRoot || !inside(modulesRoot, packageRoot)) return
  try {
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as { name?: string; bin?: string | Record<string, string> }
    if (manifest.name !== NPM_PACKAGES[adapter]) return
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[ADAPTERS[adapter].command]
    if (!bin || path.isAbsolute(bin)) return
    const entry = await realpath(path.resolve(packageRoot, bin))
    if (!inside(packageRoot, entry) || !/\.(?:mjs|cjs|js)$/i.test(entry) || !(await stat(entry)).isFile()) return
    return { executable: nodePath, args: [entry] }
  } catch { return }
}
export class AgentHostService {
  private lastGoodCipher?: Buffer
  private saved: SavedState = { version: 1, installationId: randomUUID(), ownerUserId: '', deviceId: '', deviceKey: '', enabled: false, agents: [], commands: {} }
  private children = new Map<string, ChildProcess>()
  private childEpoch = new Map<string, number>()
  private state: AgentHostSnapshot = { supported: true, enabled: false, deviceName: hostname(), connection: 'unbound', agents: [], discovered: [] }
  private timer?: ReturnType<typeof setTimeout>
  private saveQueue = Promise.resolve()
  private actionQueue = Promise.resolve<unknown>(undefined)
  private polling = false
  private disposed = false
  private leaseId = randomUUID()
  private failures = 0
  private leaseValidUntil = 0
  private boundAgentIds = new Set<string>()
  private leaseRequest?: Promise<Reply>
  private starting = new Map<string, Promise<void>>()
  constructor(private readonly options: AgentHostOptions) {}

  async initialize(): Promise<void> {
    await mkdir(this.options.storageDir, { recursive: true })
    const filename = path.join(this.options.storageDir, 'host-state.enc')
    let found = false
    for (const source of [filename, filename + '.bak']) {
      try {
        const bytes = await readFile(source)
        found = true
        if (!safeStorage.isEncryptionAvailable()) throw new Error('本机系统加密不可用，无法读取设备绑定')
        const saved = JSON.parse(safeStorage.decryptString(bytes)) as SavedState
        if (saved.version !== 1 || !Array.isArray(saved.agents) || !saved.installationId) throw new Error('设备状态格式不兼容')
        this.saved = saved
        this.lastGoodCipher = bytes
        for (const agent of this.saved.agents) { agent.status = 'stopped'; agent.busy = false; agent.runtimeStatus = 'unknown' }
        for (const value of Object.values(this.saved.commands)) {
          if (value.state === 'running') Object.assign(value, { state: 'done', status: 'failed', message: '托管服务在操作中重启，结果需要检查；不会自动重复执行' })
        }
        await this.persist()
        this.schedule(200)
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.state.message = errorText(error)
      }
    }
    if (found) { this.state.connection = 'revoked'; this.state.message = '设备配置无法解密或已损坏。请从网站撤销旧设备后重新绑定；原文件未删除。' }
  }
  snapshot(): AgentHostSnapshot {
    const sameOwner = this.saved.ownerUserId === this.options.ownerId()
    return structuredClone({ ...this.state, enabled: this.saved.enabled && sameOwner,
      deviceId: sameOwner ? this.saved.deviceId || undefined : undefined,
      ownerUserId: sameOwner ? this.saved.ownerUserId : undefined,
      agents: sameOwner ? this.saved.agents.map(({ key: _key, executable: _exe, executableArgs: _args, desiredRunning: _desired, pendingCloudBind: _pending, ...publicBinding }) => publicBinding) : [] })
  }
  isActive(): boolean { return !this.disposed && (this.saved.enabled || this.children.size > 0) }
  isBusy(): boolean { return this.saved.agents.some((agent) => agent.busy) }
  async suspendForSignOut(): Promise<void> {
    this.saved.enabled = false
    this.leaseValidUntil = 0
    this.state.connection = 'offline'
    this.state.message = '账号已退出，远程控制已暂停；运行中的任务安全结束后停止同步'
    this.drainAll()
    if (this.saved.deviceId) await this.persist()
  }
  private changed(): void { this.options.onChange() }
  private assertOwner(owner = this.saved.ownerUserId): void {
    if (!owner || this.options.ownerId() !== owner || (this.saved.ownerUserId && this.saved.ownerUserId !== owner)) {
      this.leaseValidUntil = 0
      this.drainAll()
      throw new Error('账号已切换，远程控制已暂停，请重新确认设备绑定')
    }
  }
  private assertMayStart(binding: Binding): void {
    this.assertOwner()
    if (this.disposed || !this.saved.enabled || !this.saved.deviceKey || this.leaseValidUntil <= Date.now()) throw new Error('设备尚未取得有效连接租约，请恢复托管并等待设备上线')
    if (!this.boundAgentIds.has(binding.id)) throw new Error('网站尚未授权此设备托管这个智能体，请重新绑定')
  }
  private async persist(): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，设备密钥不会以明文保存')
    const bytes = safeStorage.encryptString(JSON.stringify(this.saved))
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => {
      const filename = path.join(this.options.storageDir, 'host-state.enc')
      const atomicWrite = async (target: string, contents: Buffer): Promise<void> => {
        const temporary = target + '.' + randomUUID() + '.tmp'
        const file = await open(temporary, 'wx', 0o600)
        try { await file.writeFile(contents); await file.sync() } finally { await file.close() }
        await rename(temporary, target)
      }
      // Backup only data we have successfully decrypted or persisted. A corrupt
      // primary must never overwrite the good backup used during recovery.
      if (this.lastGoodCipher) await atomicWrite(filename + '.bak', this.lastGoodCipher)
      await atomicWrite(filename, bytes)
      this.lastGoodCipher = bytes
    })
    await this.saveQueue
  }
  action(input: AgentHostAction): Promise<AgentHostSnapshot> {
    const operation = this.actionQueue.catch(() => {}).then(() => this.perform(input))
    this.actionQueue = operation
    return operation
  }
  private async perform(input: AgentHostAction): Promise<AgentHostSnapshot> {
    if (!input || typeof input.action !== 'string') throw new Error('托管操作无效')
    if (input.action === 'discover') {
      this.state.discovered = await Promise.all((Object.keys(ADAPTERS) as AgentAdapter[]).map(async (adapter) => {
        const found = await resolveAgentLaunch(adapter, this.options.nodePath)
        return { adapter, name: ADAPTERS[adapter].name, available: !!found, message: found ? '发现本地命令；绑定后检查登录与会话状态' : '未发现命令，请先安装并完成智能体自身登录' }
      }))
      return this.snapshot()
    }
    const owner = this.options.ownerId()
    if (!owner) throw new Error('请先登录 AI历史书账号，再绑定这台电脑')
    if (this.saved.ownerUserId && owner !== this.saved.ownerUserId) throw new Error('这台电脑绑定了另一账号，请切回原账号解除绑定后重试')
    if (input.action === 'bind_device') {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('本机系统加密暂不可用，不能安全保存设备绑定')
      if (!this.saved.deviceId) {
        // Persist the registration identity before sending it. If the server
        // commits but its response is lost, retrying proves possession of the
        // same key and returns the same device rather than creating a duplicate.
        this.saved.ownerUserId = owner
        this.saved.deviceKey ||= 'adh_live_' + randomBytes(32).toString('base64url')
        await this.persist()
        this.assertOwner(owner)
        const result = await this.options.request({ scope: 'devices', method: 'POST', action: 'register', body: { name: hostname(), installationId: this.saved.installationId, platform: process.platform, launcherVersion: this.options.launcherVersion, registrationKey: this.saved.deviceKey } })
        this.assertOwner(owner)
        if (!result.deviceKey || !(result.device as Reply)?.id) throw new Error('设备绑定未返回有效凭据')
        if (result.deviceKey !== this.saved.deviceKey) throw new Error('设备注册凭据不匹配，请更新服务器设备接口后重试')
        this.saved.deviceId = String((result.device as Reply).id)
        this.saved.deviceKey = String(result.deviceKey)
        this.saved.ownerUserId = owner
      }
      this.saved.enabled = true
    } else if (input.action === 'pause') {
      if (this.isBusy()) throw new Error('还有任务运行中，请等完成后暂停托管')
      this.saved.enabled = false
      this.leaseValidUntil = 0
      await this.stopAll()
      this.state.connection = 'offline'
      this.state.message = '托管已暂停，手机暂时无法启动本机智能体'
    } else if (input.action === 'resume') {
      if (!this.saved.deviceKey) throw new Error('请先绑定这台电脑')
      this.saved.enabled = true
    } else if (input.action === 'revoke_device') {
      if (this.isBusy()) throw new Error('请先等待当前任务完成再解除设备绑定')
      await this.options.request({ scope: 'devices', method: 'POST', action: 'revoke', body: { deviceId: this.saved.deviceId } })
      this.saved.enabled = false
      this.leaseValidUntil = 0
      await this.stopAll()
      this.saved.deviceKey = ''; this.saved.deviceId = ''; this.saved.ownerUserId = ''; this.saved.agents = []; this.saved.commands = {}; this.saved.installationId = randomUUID()
      this.state.connection = 'unbound'
    } else if (input.action === 'add_agent') {
      if (!this.saved.deviceKey) throw new Error('请先绑定这台电脑')
      await this.ensureLease(true)
      if (!Object.hasOwn(ADAPTERS, input.adapter)) throw new Error('当前版本不支持这个适配器')
      if (this.saved.agents.length >= 12) throw new Error('每台电脑最多托管 12 个智能体实例')
      const launch = await resolveAgentLaunch(input.adapter, this.options.nodePath)
      if (!launch) throw new Error('没有找到可直接运行的智能体。请安装官方原生程序或官方 npm 包；不支持任意 cmd/bat 启动脚本')
      const root = await this.chooseProject()
      if (!root) return this.snapshot()
      this.assertOwner(owner)
      const result = await this.options.request({ scope: 'hub', method: 'POST', action: 'add_agent', body: { adapterCode: input.adapter, displayName: (input.name || ADAPTERS[input.adapter].name).slice(0, 80) } })
      this.assertOwner(owner)
      const instance = (result.instance || result.agent) as Reply
      const key = String(result.interactionKey || '')
      if (!/^[A-Za-z0-9_-]{16,80}$/.test(String(instance?.id || '')) || !/^agh_live_[A-Za-z0-9_-]{32,}$/.test(key)) throw new Error('智能体绑定返回无效，请刷新网站实例列表检查')
      const binding: Binding = { id: String(instance.id), name: String(instance.displayName || instance.name || input.name || ADAPTERS[input.adapter].name), adapter: input.adapter, key, executable: launch.executable, executableArgs: launch.args, projectRoots: [root], autoStart: true, desiredRunning: true, status: 'stopped', runtimeStatus: 'unknown', busy: false, pendingCloudBind: true }
      // Persist the one-time key before a second network call can fail.
      this.saved.agents.push(binding)
      await this.persist()
      await this.completePendingBinding(binding)
      await this.ensureLease(true)
      await this.startAgent(binding)
    } else if ('agentId' in input) {
      const binding = this.saved.agents.find((agent) => agent.id === input.agentId)
      if (!binding) throw new Error('这个智能体不属于当前设备')
      if (['stop', 'restart', 'remove_agent', 'add_project'].includes(input.action) && binding.busy) throw new Error('智能体还有任务运行，请等完成后操作')
      if (input.action === 'add_project') {
        const root = await this.chooseProject()
        this.assertOwner(owner)
        if (root && !binding.projectRoots.some((old) => old.toLowerCase() === root.toLowerCase())) {
          if (binding.projectRoots.length >= 60) throw new Error('最多授权 60 个项目')
          binding.projectRoots.push(root)
          if (this.children.has(binding.id)) { await this.stopAgent(binding); await this.startAgent(binding) }
        }
      } else if (input.action === 'remove_agent') {
        await this.options.request({ scope: 'devices', method: 'POST', action: 'unbind', body: { deviceId: this.saved.deviceId, agentId: binding.id } })
        await this.stopAgent(binding)
        this.saved.agents = this.saved.agents.filter((agent) => agent !== binding)
      } else {
        if (!['start', 'stop', 'restart'].includes(input.action)) throw new Error('不支持的托管操作')
        binding.desiredRunning = input.action !== 'stop'
        if (input.action !== 'start') await this.stopAgent(binding)
        if (input.action !== 'stop') await this.startAgent(binding)
      }
    } else throw new Error('不支持的托管操作')
    await this.persist()
    this.schedule(100)
    this.changed()
    return this.snapshot()
  }
  private async chooseProject(): Promise<string | undefined> {
    const selected = await this.options.chooseDirectory()
    if (!selected) return
    const root = await realpath(selected)
    if (!safeProjectRoot(root) || !await stat(root).then((row) => row.isDirectory())) throw new Error('请选择具体项目文件夹，不能授权整个磁盘')
    return root
  }
  private async startAgent(binding: Binding): Promise<void> {
    const existing = this.starting.get(binding.id)
    if (existing) return existing
    const operation = this.startAgentReady(binding)
    this.starting.set(binding.id, operation)
    try { await operation } finally { if (this.starting.get(binding.id) === operation) this.starting.delete(binding.id) }
  }
  private async completePendingBinding(binding: Binding): Promise<void> {
    if (!binding.pendingCloudBind) return
    this.assertOwner()
    if (!this.saved.enabled || !this.saved.deviceId) throw new Error('设备托管已暂停')
    try {
      await this.options.request({ scope: 'devices', method: 'POST', action: 'bind', body: { deviceId: this.saved.deviceId, agentId: binding.id } })
      this.assertOwner()
      if (!this.saved.enabled) throw new Error('设备托管已暂停')
      binding.pendingCloudBind = false
      await this.persist()
    } catch (error) {
      binding.status = 'failed'; binding.desiredRunning = false
      binding.message = '实例已保留，网站绑定尚未完成；点击启动重试绑定，不要重复添加'
      this.changed()
      throw new Error(`${binding.message}：${errorText(error)}`)
    }
  }
  private async startAgentReady(binding: Binding): Promise<void> {
    await this.ensureLease()
    // Only an explicit local start/add reaches an unresolved binding. Background
    // reconciliation deliberately skips it: a web-side unbind must never be
    // silently undone after an ambiguous network response.
    if (binding.pendingCloudBind) { await this.completePendingBinding(binding); await this.ensureLease(true); binding.desiredRunning = true }
    this.assertMayStart(binding)
    if (this.children.has(binding.id)) {
      if (binding.status === 'failed') throw new Error('旧连接服务正在安全退出，请等退出后重试')
      return
    }
    const entry = path.join(this.options.moduleDir, 'connector', 'host-child.mjs')
    await access(entry).catch(() => { throw new Error('缺少智能体托管模块，请在版本管理中更新或安装最新版启动器') })
    const stateDirectory = path.join(this.options.storageDir, 'instances', binding.id)
    await mkdir(stateDirectory, { recursive: true })
    this.assertMayStart(binding)
    binding.status = 'starting'; binding.message = '正在连接本地智能体与网站'
    const epoch = (this.childEpoch.get(binding.id) || 0) + 1
    this.childEpoch.set(binding.id, epoch)
    const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    delete (environment as NodeJS.ProcessEnv).SHENLAN_AGENT_INTERACTION_KEY
    let child: ChildProcess
    try { child = fork(entry, [], { execPath: this.options.nodePath, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, env: environment, cwd: this.options.storageDir } as ForkOptions & { windowsHide: boolean }) }
    catch (error) { binding.status = 'failed'; binding.desiredRunning = false; throw error }
    this.children.set(binding.id, child)
    child.stdout?.resume(); child.stderr?.resume()
    child.on('message', (message: unknown) => {
      if (this.childEpoch.get(binding.id) !== epoch || !message || typeof message !== 'object') return
      const data = message as Reply
      if (data.type !== 'status') return
      binding.busy = Number(data.runningTasks || 0) > 0 || data.phase === 'busy'
      binding.status = data.phase === 'failed' ? 'failed' : data.phase === 'stopped' ? 'stopped' : data.phase === 'starting' ? 'starting' : data.connected === true ? 'online' : 'reconnecting'
      binding.runtimeStatus = binding.busy ? 'busy' : data.runtimeReady === true ? 'ready' : data.phase === 'failed' ? 'error' : 'unknown'
      binding.message = data.error ? errorText(data.error) : undefined
      this.changed()
    })
    child.on('error', (error) => { if (this.childEpoch.get(binding.id) !== epoch) return; binding.status = 'failed'; binding.desiredRunning = false; binding.message = errorText(error); if (!child.pid || child.exitCode !== null) this.children.delete(binding.id); this.changed() })
    child.on('exit', (code) => {
      if (this.childEpoch.get(binding.id) !== epoch) return
      this.children.delete(binding.id); binding.busy = false; binding.status = code ? 'failed' : 'stopped'; binding.runtimeStatus = 'stopped'
      if (code) binding.desiredRunning = false
      if (code) binding.message = `连接服务退出（${code}），请检查智能体登录或点击重新启动`
      this.changed()
    })
    // Distinct stable loopback ports for separately authorized Codex instances.
    const port = 24000 + parseInt(createHash('sha256').update(binding.id).digest('hex').slice(0, 4), 16) % 30000
    const startMessage = { type: 'start', instanceId: binding.id, authorizedProjectRoots: binding.projectRoots, config: {
      serverUrl: 'https://ailishishu.com/ailishishu-stats/api/agent-connector.php', interactionKey: binding.key,
      adapterCode: binding.adapter, runtimeLabel: hostname(), runtimeExecutable: binding.executable,
      runtimeExecutableArgs: binding.executableArgs || [],
      stateFile: path.join(stateDirectory, 'connector-state.json'), sandbox: 'workspace-write',
      projects: binding.projectRoots.map((root) => ({ name: path.basename(root), path: root, enabled: true })),
      projectDiscovery: { enabled: true, roots: binding.projectRoots, maxProjects: 60, maxSessionsPerProject: 100 },
      codexHost: { enabled: binding.adapter === 'codex', manageProcess: true, endpoint: `ws://127.0.0.1:${port}` }
    } }
    await new Promise<void>((resolve, reject) => {
      let sent = false
      let finished = false
      const cleanup = (): void => { clearTimeout(timer); child.off('message', onMessage); child.off('error', onError); child.off('exit', onExit) }
      const finish = (error?: Error): void => {
        if (finished) return
        finished = true; cleanup()
        if (error) {
          binding.status = 'failed'; binding.desiredRunning = false; binding.message = errorText(error)
          if (child.connected) child.send({ type: 'stop' }, () => {})
          if (!child.pid || child.exitCode !== null) this.children.delete(binding.id)
          this.changed(); reject(error)
        } else resolve()
      }
      const onError = (error: Error): void => finish(error)
      const onExit = (): void => finish(new Error('连接服务在就绪前退出，请检查本机智能体环境与登录状态'))
      const onMessage = (value: unknown): void => {
        if (!value || typeof value !== 'object') return
        const data = value as Reply
        if (data.type === 'ready' && !sent) {
          if (data.protocolVersion !== AGENT_HOST_PROTOCOL) { finish(new Error('托管模块协议不兼容，请更新启动器')); return }
          try { this.assertMayStart(binding) } catch (error) { finish(error as Error); return }
          sent = true
          child.send(startMessage, (error) => { if (error) finish(error) })
        } else if (data.type === 'status' && sent && data.instanceId === binding.id) {
          if (data.phase === 'failed' || data.phase === 'stopped') finish(new Error(String(data.error || '本机智能体未能完成连接')))
          else if (['ready', 'busy'].includes(String(data.phase)) && data.connected === true) {
            try { this.assertMayStart(binding); finish() } catch (error) { finish(error as Error) }
          }
        }
      }
      const timer = setTimeout(() => finish(new Error('连接服务 35 秒内未就绪，已请求安全停止；请检查环境后重试')), 35000)
      child.on('message', onMessage); child.once('error', onError); child.once('exit', onExit)
    })
  }
  private async stopAgent(binding: Binding): Promise<void> {
    const child = this.children.get(binding.id)
    if (!child) { binding.status = 'stopped'; return }
    if (binding.busy) throw new Error('任务运行中，不能中断或切换托管模块')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.off('exit', finished); reject(new Error('智能体仍在安全退出，请稍后重试；未强制终止任务')) }, 15000)
      const finished = (): void => { clearTimeout(timer); resolve() }
      child.once('exit', finished)
      child.send({ type: 'stop' }, (error) => { if (error && child.exitCode !== null) finished() })
    })
  }
  private async stopAll(): Promise<void> { for (const binding of this.saved.agents) await this.stopAgent(binding) }
  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.disposed) return
    this.timer = setTimeout(() => { void this.tick() }, delay)
    this.timer.unref()
  }
  async tick(): Promise<void> {
    if (this.polling || this.disposed) return
    this.polling = true
    let delay = 15000
    try {
      if (!this.saved.enabled || !this.saved.deviceKey) return
      if (this.saved.ownerUserId !== this.options.ownerId()) {
        this.state.connection = 'offline'; this.state.message = '请登录绑定这台电脑的账号，远程控制已暂停'
        this.leaseValidUntil = 0
        this.drainAll()
        return
      }
      const payload = await this.ensureLease(true)
      this.assertOwner()
      this.failures = 0; this.state.connection = 'online'; this.state.lastHeartbeatAt = new Date().toISOString(); this.state.message = '设备已连接；电脑需保持开机、不休眠，关闭窗口后可在托盘继续托管'
      delay = Math.min(15000, Math.max(5000, Number(payload.heartbeatSeconds || 15) * 1000))
      for (const command of (Array.isArray(payload.commands) ? payload.commands : []).slice(0, 12)) {
        const operation = this.actionQueue.catch(() => {}).then(() => this.executeCommand(command))
        this.actionQueue = operation
        await operation
      }
      // Reconcile desired state only after a successful lease; a competing host
      // cannot start any agent before the server has accepted this device.
      for (const binding of this.saved.agents) {
        if (!binding.pendingCloudBind && this.boundAgentIds.has(binding.id) && binding.desiredRunning && binding.status === 'stopped' && !this.children.has(binding.id)) await this.startAgent(binding)
        const child = this.children.get(binding.id)
        if (child?.connected) child.send({ type: 'status' }, () => {})
      }
    } catch (error) {
      this.failures += 1; this.state.connection = this.state.connection === 'revoked' ? 'revoked' : 'offline'; this.state.message = errorText(error)
      delay = Math.min(60000, 3000 * 2 ** Math.min(5, this.failures)) + Math.floor(Math.random() * 1000)
    } finally { this.polling = false; this.changed(); this.schedule(delay) }
  }
  private ensureLease(force = false): Promise<Reply> {
    this.assertOwner()
    if (this.disposed || !this.saved.enabled || !this.saved.deviceKey) return Promise.reject(new Error('设备托管已暂停，请先恢复托管'))
    if (!force && this.leaseValidUntil > Date.now()) return Promise.resolve({ boundAgentIds: [...this.boundAgentIds], commands: [] })
    if (this.leaseRequest) return this.leaseRequest
    const operation = this.deviceRequest({ action: 'heartbeat', agents: this.saved.agents.map((agent) => ({ agentId: agent.id, status: agent.status === 'failed' ? 'error' : agent.status === 'reconnecting' ? 'offline' : agent.status, runtimeStatus: agent.runtimeStatus, busy: agent.busy, message: agent.message || '' })) }).then(async (payload) => {
      this.assertOwner()
      if (this.disposed || !this.saved.enabled || !Array.isArray(payload.boundAgentIds)) throw new Error('设备授权状态已变更或响应不完整，请重试')
      this.leaseValidUntil = Date.now() + Math.min(60, Math.max(1, Number(payload.leaseSeconds) || 60)) * 1000
      this.boundAgentIds = new Set(payload.boundAgentIds.filter((id): id is string => typeof id === 'string'))
      let resolvedPending = false
      for (const binding of this.saved.agents) {
        if (binding.pendingCloudBind) {
          if (this.boundAgentIds.has(binding.id)) { binding.pendingCloudBind = false; resolvedPending = true }
          else { binding.desiredRunning = false; binding.message = '网站绑定尚未完成；点击启动重试绑定，已保存的实例不会重复创建'; continue }
        }
        if (this.boundAgentIds.has(binding.id)) continue
        binding.desiredRunning = false
        binding.message = '网站已解除此设备授权，正在安全停止同步'
        const child = this.children.get(binding.id)
        if (child?.connected) child.send({ type: 'stop' }, () => {})
      }
      if (resolvedPending) await this.persist()
      return payload
    }).catch((error) => {
      // The expiry remains an upper bound during a temporary network failure.
      if (this.leaseValidUntil <= Date.now()) this.drainAll()
      throw error
    }).finally(() => { if (this.leaseRequest === operation) this.leaseRequest = undefined })
    this.leaseRequest = operation
    return operation
  }
  private async deviceRequest(body: Reply): Promise<Reply> {
    const owner = this.saved.ownerUserId
    const deviceId = this.saved.deviceId
    const deviceKey = this.saved.deviceKey
    this.assertOwner(owner)
    const response = await (this.options.fetch || fetch)('https://ailishishu.com/ailishishu-stats/api/agent-device-connector.php', {
      method: 'POST', signal: AbortSignal.timeout(12000), headers: { authorization: `Bearer ${deviceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, deviceId, leaseId: this.leaseId })
    })
    this.assertOwner(owner)
    if (this.disposed || this.saved.deviceId !== deviceId || this.saved.deviceKey !== deviceKey || !this.saved.enabled) throw new Error('设备绑定已变更，已忽略旧连接响应')
    const result = await response.json().catch(() => ({})) as Reply
    this.assertOwner(owner)
    if (response.status === 401 || response.status === 403 || result.error === 'device_lease_active') {
      this.leaseValidUntil = 0
      this.drainAll()
      if (response.status === 401 || response.status === 403) { this.saved.enabled = false; this.state.connection = 'revoked'; await this.persist() }
    }
    if (!response.ok || result.ok !== true) throw new Error(String(result.message || result.error || '设备心跳连接失败'))
    return result
  }
  private async executeCommand(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') return
    const command = raw as Reply
    const id = String(command.id || '')
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(id)) return
    let result = this.saved.commands[id]
    if (!result) {
      const binding = this.saved.agents.find((agent) => agent.id === command.agentId)
      result = { agentId: String(command.agentId || ''), state: 'running', status: 'failed', message: '操作中断，结果需要检查' }
      this.saved.commands[id] = result
      await this.persist() // durable intent before a side effect
      try {
        if (!binding || !['start', 'stop', 'restart', 'refresh'].includes(String(command.command))) throw new Error('指令不在本机授权范围内')
        this.assertMayStart(binding)
        if (command.expiresAt && Date.parse(String(command.expiresAt)) < Date.now()) throw new Error('远程指令已经过期')
        if (binding.busy && ['stop', 'restart'].includes(String(command.command))) throw new Error('智能体正在执行任务，已拒绝中断')
        if (command.command === 'start' || command.command === 'restart') binding.desiredRunning = true
        if (command.command === 'stop') binding.desiredRunning = false
        if (command.command === 'stop' || command.command === 'restart') await this.stopAgent(binding)
        if (command.command === 'start' || command.command === 'restart') await this.startAgent(binding)
        if (command.command === 'refresh') { const child = this.children.get(binding.id); if (child?.connected) child.send({ type: 'status' }, () => {}) }
        result.status = 'completed'; result.message = command.command === 'start' || command.command === 'restart' ? '启动请求已交给本机，连接就绪状态以智能体心跳为准' : '本机操作已完成'
      } catch (error) { result.message = errorText(error) }
      result.state = 'done'
      const entries = Object.entries(this.saved.commands)
      if (entries.length > 500) this.saved.commands = Object.fromEntries(entries.slice(-500))
      await this.persist()
    }
    await this.deviceRequest({ action: 'ack', commandId: id, status: result.status, message: result.message })
  }
  async dispose(): Promise<void> {
    if (this.isBusy() || this.starting.size) throw new Error('智能体正在执行任务或启动中，请等空闲后切换托管模块')
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    await this.stopAll()
    await this.saveQueue
  }
  private drainAll(): void {
    for (const child of this.children.values()) if (child.connected) child.send({ type: 'stop' }, () => {})
  }
}
