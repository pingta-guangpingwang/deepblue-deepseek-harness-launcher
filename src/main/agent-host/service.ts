import { safeStorage, dialog, shell } from 'electron'
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { access, mkdir, open, readFile, readdir, rename, realpath, stat, copyFile, lstat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentAdapter, AgentHostAction, AgentHostSnapshot, AgentWorkspaceRequest, LocalAgentBinding, LocalCatalog, LocalTask } from '../../shared/agent-host'
import { desktopRelayRequest } from './desktop-relay'
import { updateExistingDesktopRelay } from './desktop-relay-update'
import { readLocalModels, mergeLocalModels, sameLocalPath } from './local-models'
import { resolveBuiltinDshHost, type DshHostSettings } from './dsh-launcher'
import { readLegacyBinding, prepareLegacyHandoff, LEGACY_ADAPTERS, type LegacyBindingConfig } from './legacy-bindings'
import { LocalControlBridge } from './local-control'
import { LocalAssociations } from './local-association'
import { NativeApprovals, type ApprovalContext } from './native-approvals'
import type { LocalRuntimeDescriptor } from '../../shared/local-control'
import { AGENT_CATALOG } from '../../shared/agent-catalog'

export const AGENT_HOST_PROTOCOL = 1
type Reply = Record<string, unknown>
interface Binding extends LocalAgentBinding { key: string; executable: string; executableArgs?: string[]; desiredRunning: boolean; pendingCloudBind?: boolean; legacy?: Omit<LegacyBindingConfig, 'key'> }
interface CommandResult { agentId: string; status: 'completed' | 'failed'; message: string }
interface SavedState {
  deviceName?: string
  manuallyPaused?: boolean
  desktopTasks?: LocalTask[]
  cliTasks?: LocalTask[]
  localConversations?: Record<string, { projectId: string; projectPath: string; adapter: AgentAdapter; runtimeSessionId: string; status: 'ready' | 'running' | 'unconfirmed' }>
  localProjects?: Array<{ id: string; adapter: AgentAdapter; name: string; path: string }>
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
  resolveDshHost?: () => Promise<DshHostSettings>
}
const ADAPTERS: Record<AgentAdapter, { name: string; command: string }> = {
  'deepseek-harness': { name: 'DeepSeek Harness（内置）', command: 'dsh' },
  cursor: { name: 'Cursor（官方 Agent CLI）', command: 'cursor-agent' },
  codex: { name: 'Codex', command: 'codex' },
  'claude-code': { name: 'Claude Code', command: 'claude' },
  qclaw: { name: 'QClaw / OpenClaw', command: 'openclaw' },
  workbuddy: { name: 'WorkBuddy', command: 'workbuddy' },
  codebuddy: { name: 'CodeBuddy', command: 'codebuddy' },
  trae: { name: 'TRAE', command: 'trae-cn' }
}
const NPM_PACKAGES: Partial<Record<AgentAdapter, string>> = { codex: '@openai/codex', 'claude-code': '@anthropic-ai/claude-code', qclaw: 'openclaw' }
const LOCAL_EXECUTION_ADAPTERS = new Set(AGENT_CATALOG.filter(item => item.execution).map(item => item.id))
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
  if (adapter === 'deepseek-harness') return undefined // Requires the owning Launcher profile; never pick a random PATH installation.
  if (adapter === 'cursor' && process.platform === 'win32') {
    const configuredRoot = path.join(process.env.LOCALAPPDATA || '', 'cursor-agent', 'versions')
    if (!path.isAbsolute(configuredRoot)) return undefined
    // Packaged Windows parents can redirect LocalAppData. Compare canonical
    // paths on both sides, while retaining the same bounded official root.
    const root = await realpath(configuredRoot).catch(() => '')
    if (!root) return undefined
    const versions = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory() && /^\d{4}\.\d{2}\.\d{2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(entry.name)).sort((a,b) => b.name.localeCompare(a.name))
    for (const version of versions.slice(0, 20)) {
      const base = await realpath(path.join(root, version.name)).catch(() => '')
      if (!base || !inside(root, base)) continue
      const executable = await realpath(path.join(base, 'node.exe')).catch(() => '')
      const entry = await realpath(path.join(base, 'index.js')).catch(() => '')
      if (executable && entry && inside(base, executable) && inside(base, entry) && (await stat(executable)).isFile() && (await stat(entry)).isFile()) return { executable, args: [entry] }
    }
    return undefined // The IDE's cursor.cmd alone is not the Agent CLI.
  }
  if (adapter === 'codex' && process.platform === 'win32' && process.env.USERPROFILE) {
    // The desktop updater owns this bounded directory. Prefer its matching CLI
    // over a stale npm shim that cannot read the desktop's newer model cache.
    const desktopRoot = path.join(process.env.USERPROFILE, 'AppData/Local/OpenAI/Codex/bin')
    const versions = await readdir(desktopRoot, { withFileTypes: true }).catch(() => [])
    const candidates = await Promise.all(versions.filter(entry => entry.isDirectory() && /^[a-f0-9]{16,64}$/i.test(entry.name)).slice(0, 20).map(async entry => {
      const file = path.join(desktopRoot, entry.name, 'codex.exe')
      const resolved = await realpath(file).catch(() => '')
      if (!resolved || !inside(desktopRoot, resolved)) return undefined
      const info = await stat(resolved).catch(() => undefined)
      return info?.isFile() ? { file: resolved, modified: info.mtimeMs } : undefined
    }))
    const latest = candidates.filter((candidate): candidate is { file: string; modified: number } => Boolean(candidate)).sort((a,b) => b.modified - a.modified)[0]
    if (latest) return { executable: latest.file, args: [] }
  }
  const executable = await discoverExecutable(ADAPTERS[adapter].command)
  // Existing Connector configurations must use discover_existing/import_existing
  // so the original cloud instance, project grants and adapter settings remain
  // intact. A normal Add operation must never consume legacy credentials and
  // silently create a duplicate instance.
  if (!executable) return
  if (!/\.(cmd|bat)$/i.test(executable)) return { executable, args: [] }
  const packageName = NPM_PACKAGES[adapter]
  if (!packageName) return
  // Never shell-execute npm shims. Resolve only the known adapter package's bin
  // inside its real node_modules directory; renderer/cloud cannot select a script.
  const modulesRoot = await realpath(path.join(path.dirname(executable), 'node_modules')).catch(() => '')
  if (!modulesRoot) return
  const packageRoot = await realpath(path.join(modulesRoot, packageName)).catch(() => '')
  if (!packageRoot || !inside(modulesRoot, packageRoot)) return
  try {
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as { name?: string; bin?: string | Record<string, string> }
    if (manifest.name !== packageName) return
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[ADAPTERS[adapter].command]
    if (!bin || path.isAbsolute(bin)) return
    const entry = await realpath(path.resolve(packageRoot, bin))
    if (!inside(packageRoot, entry) || !(await stat(entry)).isFile()) return
    // Current official Claude npm packages expose a native Windows executable,
    // not cli.js. Keep the same package/root allowlist and never run the shim.
    if (process.platform === 'win32' && adapter === 'claude-code' && /\.exe$/i.test(entry)) return { executable: entry, args: [] }
    if (!/\.(?:mjs|cjs|js)$/i.test(entry)) return
    return { executable: nodePath, args: [entry] }
  } catch { return }
}
export class AgentHostService {
  private lastGoodCipher?: Buffer
  private saved: SavedState = { version: 1, installationId: randomUUID(), ownerUserId: '', deviceId: '', deviceKey: '', enabled: false, agents: [], commands: {} }
  private children = new Map<string, ChildProcess>()
  private childEpoch = new Map<string, number>()
  private state: AgentHostSnapshot = { supported: true, enabled: false, deviceName: hostname(), connection: 'unbound', agents: [], discovered: [] }
  private autoConnectedOwner?: string
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
  private observer?: ChildProcess
  private localChildren = new Map<string, ChildProcess>()
  private localFiles = new Map<string, { path: string; name: string; byteSize: number; mediaKind: string }>()
  private observerPending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private connectionCheckedAt = 0
  private connectionOwner?: string
  private connectionCheck?: Promise<void>
  private localControl?: LocalControlBridge
  private localControlResult?: Record<string, unknown>
  private localControlResultOwner?: string
  private associations: LocalAssociations
  private nativeApprovals: NativeApprovals
  private remoteApprovalOwner?: string
  constructor(private readonly options: AgentHostOptions) {
    this.associations = new LocalAssociations(path.join(options.storageDir, 'agent-associations'), options.nodePath, process.execPath)
    this.nativeApprovals = new NativeApprovals(path.join(options.storageDir, 'native-approvals'))
  }

  private async checkAssociations(retryInvalid = false): Promise<void> {
    // Never replace a runtime while it owns a task or a native read request.
    if (this.localChildren.size || this.observerPending.size || this.saved.agents.some(agent => agent.busy) || this.localControl?.isBusy()) return
    if (await this.associations.check(retryInvalid)) {
      this.observer?.disconnect(); this.observer = undefined
      for (const association of this.associations.snapshot().filter(item => item.status === 'verified')) {
        const item = { adapter: association.adapter, name: ADAPTERS[association.adapter].name, available: true, message: association.message }
        this.state.discovered = [...this.state.discovered.filter(row => row.adapter !== item.adapter), item]
      }
    }
    this.state.associations = this.associations.snapshot()
  }

  private dshHostSettings(): Promise<DshHostSettings> {
    return this.options.resolveDshHost ? this.options.resolveDshHost() : resolveBuiltinDshHost(this.options.storageDir)
  }
  private async resolveLaunch(adapter: AgentAdapter): Promise<{ executable: string; args: string[] } | undefined> {
    const registered = this.associations.launch(adapter)
    if (registered) return registered
    if (adapter !== 'deepseek-harness') return resolveAgentLaunch(adapter, this.options.nodePath)
    await this.dshHostSettings()
    // DSH executes through its already-running local RPC host, not a new CLI.
    return { executable: this.options.nodePath, args: [] }
  }

  async initialize(): Promise<void> {
    await mkdir(this.options.storageDir, { recursive: true })
    await this.associations.initialize()
    this.state.associations = this.associations.snapshot()
    try {
      if (await updateExistingDesktopRelay(this.options.moduleDir) === 'updated') this.state.desktopRelay = { ready: false, message: '桌面桥接代码已更新；若未就绪，请重启 Codex。原配置和请求记录保留。' }
    } catch { this.state.desktopRelay = { ready: false, message: '桌面桥接代码更新未完成，原配置和代码备份保留，请检查目录权限。' } }
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
        this.state.localTasks = [...(Array.isArray(saved.desktopTasks) ? saved.desktopTasks.slice(-50) : []), ...(Array.isArray(saved.cliTasks) ? saved.cliTasks.slice(-50) : [])]
        for (const task of this.state.localTasks) if (task.backend !== 'desktop' && task.status === 'running') { task.status = 'unconfirmed'; task.summary = '上次本机执行被中断，结果尚未确认；不会自动重发'; if (task.conversationId && this.saved.localConversations?.[task.conversationId]) this.saved.localConversations[task.conversationId]!.status = 'unconfirmed' }
        this.lastGoodCipher = bytes
        for (const agent of this.saved.agents) {
          agent.status = 'stopped'; agent.busy = false; agent.runtimeStatus = 'unknown'
          if (agent.adapter === 'trae') {
            agent.runtimeStatus = 'unavailable'; agent.desiredRunning = false; agent.autoStart = false
            agent.message = 'TRAE 远程交互暂不支持：原窗口发送接口拒绝当前账号。保留项目与历史，请使用其他已就绪智能体。'
          }
        }
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
    this.schedule(200)
  }
  private async checkConnection(force = false): Promise<void> {
    const owner = this.options.ownerId()
    if (!owner) {
      this.connectionOwner = undefined; this.connectionCheckedAt = 0
      this.state.accountConnection = { status: 'signed_out' }; this.state.cloudAgents = []
      return
    }
    if (this.connectionCheck) return this.connectionCheck
    if (!force && this.connectionOwner === owner && Date.now() - this.connectionCheckedAt < 60000) return
    this.state.accountConnection = { status: 'checking' }
    if (this.connectionOwner !== owner) this.state.cloudAgents = []
    this.changed()
    const operation = (async () => {
      try {
        const result = await this.options.request({ scope: 'hub', method: 'GET', action: 'bootstrap' })
        if (this.options.ownerId() !== owner) return
        if (result.ok === false || !Array.isArray(result.agents)) throw new Error('账号连接未确认，请重新登录或重试')
        this.state.cloudAgents = result.agents.filter((row): row is Reply => !!row && typeof row === 'object').map(row => ({ id: String(row.id || ''), name: String(row.display_name || row.displayName || row.adapter_code || '智能体'), adapter: String(row.adapter_code || ''), reportedStatus: String(row.status || 'unknown') })).filter(row => /^[a-zA-Z0-9_-]{16,80}$/.test(row.id))
        this.state.accountConnection = { status: 'connected', checkedAt: new Date().toISOString() }
      } catch (error) {
        if (this.options.ownerId() === owner) this.state.accountConnection = { status: 'failed', checkedAt: new Date().toISOString(), message: errorText(error) }
      } finally {
        if (this.options.ownerId() === owner) { this.connectionOwner = owner; this.connectionCheckedAt = Date.now() }
        this.changed()
      }
    })()
    this.connectionCheck = operation
    try { await operation } finally { if (this.connectionCheck === operation) this.connectionCheck = undefined }
  }
  snapshot(): AgentHostSnapshot {
    const sameOwner = this.saved.ownerUserId === this.options.ownerId()
    return structuredClone({ ...this.state, localConversationContinuity: true, localControl: { ...(this.localControl?.snapshot() || { supported: true, protocol: 1, version: 0, rooms: [], catalog: [], busy: false }), lastResult: this.localControlResultOwner === this.options.ownerId() ? this.localControlResult : undefined }, deviceName: sameOwner ? this.saved.deviceName || hostname() : hostname(), enabled: this.saved.enabled && sameOwner,
      cloudAgents: this.connectionOwner === this.options.ownerId() ? this.state.cloudAgents : [],
      remoteNativeApprovals: this.remoteApprovalOwner === this.options.ownerId() ? this.state.remoteNativeApprovals : undefined,
      accountConnection: this.connectionOwner === this.options.ownerId() ? this.state.accountConnection : { status: this.options.ownerId() ? 'checking' : 'signed_out' },
      deviceId: sameOwner ? this.saved.deviceId || undefined : undefined,
      ownerUserId: sameOwner ? this.saved.ownerUserId : undefined,
      legacyCandidates: sameOwner ? this.state.legacyCandidates : [],
      agents: sameOwner ? this.saved.agents.map(({ key: _key, executable: _exe, executableArgs: _args, desiredRunning: _desired, pendingCloudBind: _pending, legacy: _legacy, ...publicBinding }) => publicBinding) : [] })
  }
  isActive(): boolean { return !this.disposed && (this.saved.enabled || this.children.size > 0 || this.localChildren.size > 0 || this.localControl?.isActive() === true) }
  isBusy(): boolean { return this.saved.agents.some((agent) => agent.busy) || this.localChildren.size > 0 || this.localControl?.isBusy() === true || this.nativeApprovals.isBusy() }
  async suspendForSignOut(): Promise<void> {
    const message = '账号已退出，远程控制已暂停；运行中的任务安全结束后停止同步'
    const changed = this.saved.enabled || this.leaseValidUntil !== 0 || this.state.connection !== 'offline' || this.state.message !== message
    const shouldDrain = this.children.size > 0
    this.autoConnectedOwner = undefined
    this.saved.enabled = false
    this.leaseValidUntil = 0
    this.state.connection = 'offline'
    this.state.message = message
    if (shouldDrain) this.drainAll()
    if (changed && this.saved.deviceId) await this.persist()
    if (changed) this.changed()
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
    if (input.action === 'remote_native_approvals') {
      const owner = this.options.ownerId()
      if (!owner) throw new Error('请先登录，再读取远程审批')
      if (![input.deviceId, input.agentId].every(id => /^[a-f0-9]{32}$/.test(id)) || !/^[a-f0-9-]{36}$/i.test(input.runtimeSessionId)) throw new Error('远程审批归属无效')
      if (input.decision && (typeof input.decision.approved !== 'boolean' || !/^[a-f0-9]{64}$/.test(input.decision.id) || !/^[a-f0-9]{64}$/.test(input.decision.requestHash))) throw new Error('审批决定无效')
      const ticket = await this.options.request({ scope: 'devices', method: 'POST', action: 'native_ticket', body: { deviceId: input.deviceId } })
      const url = new URL(String(ticket.relayUrl || ''))
      if (url.origin !== 'https://ailishishu.com' || !url.pathname.endsWith('/v2/local') || url.username || url.password || url.search || url.hash || typeof ticket.token !== 'string' || ticket.token.length > 4096 || owner !== this.options.ownerId()) throw new Error('在线审批通道无效')
      const response = await (this.options.fetch || fetch)(url.href + '/request', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${ticket.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ command: input.decision ? 'native_decide' : 'native_approvals', input: { agentId: input.agentId, runtimeSessionId: input.runtimeSessionId, ...input.decision }, requestId: randomUUID().replaceAll('-', '') }) })
      const result = await response.json() as { ok?: boolean; result?: import('../../shared/native-approvals').NativeApprovalSnapshot; message?: string }
      if (owner !== this.options.ownerId() || this.disposed) throw new Error('账号已切换，忽略旧审批响应')
      if (!response.ok || !result.ok || result.result?.sessionId !== input.runtimeSessionId) throw new Error(result.message || '远程审批结果未确认，不会自动重发决定')
      this.state.remoteNativeApprovals = { deviceId: input.deviceId, agentId: input.agentId, snapshot: result.result }
      this.remoteApprovalOwner = owner
      return this.snapshot()
    }
    if (input.action === 'read_native_approvals' || input.action === 'decide_native_approval') {
      const owner = this.options.ownerId(), context = await this.approvalContext(input.sessionId)
      const authorize = (): void => { if (owner !== this.options.ownerId() || this.disposed) throw new Error('账号或运行环境已变化，请重新核对审批') }
      authorize()
      if (input.action === 'decide_native_approval') {
        if (typeof input.approved !== 'boolean' || !/^[a-f0-9]{64}$/.test(input.id) || !/^[a-f0-9]{64}$/.test(input.requestHash)) throw new Error('审批决定无效')
        this.state.nativeApprovals = await this.nativeApprovals.decide(context, input, authorize)
      } else this.state.nativeApprovals = await this.nativeApprovals.read(context)
      authorize(); this.changed(); return this.snapshot()
    }
    if (input.action === 'local_control') { await this.performLocalControl(input); return this.snapshot() }
    if (input.action === 'check_connection') { await this.checkConnection(true); return this.snapshot() }
    if (input.action === 'choose_local_files') {
      const result = await dialog.showOpenDialog({ title: '交给本机智能体的文件（不会上传网站）', properties: ['openFile', 'multiSelections'] })
      if (result.canceled) return this.snapshot()
      this.localFiles.clear()
      for (const file of result.filePaths) {
        const actual = await realpath(file), metadata = await stat(actual)
        if (!metadata.isFile()) continue
        const extension = path.extname(actual).toLowerCase()
        const mediaKind = /\.(png|jpg|jpeg|webp|gif)$/.test(extension) ? 'image' : /\.(mp3|wav|m4a|ogg)$/.test(extension) ? 'audio' : /\.(mp4|mov|webm|mkv)$/.test(extension) ? 'video' : 'file'
        this.localFiles.set(randomUUID(), { path: actual, name: path.basename(actual), byteSize: metadata.size, mediaKind })
      }
      this.state.localFiles = [...this.localFiles].map(([id, { path: _path, ...file }]) => ({ id, ...file }))
      return this.snapshot()
    }
    if (input.action === 'send_local') { await this.sendLocal(input); return this.snapshot() }
    if (input.action === 'refresh_local_models') {
      const models = await readLocalModels(this.associations.launch('codex')?.runtimeHome).catch(() => undefined)
      if (!models) throw new Error('本机模型目录暂时不可读，请先在 Codex 打开模型选择后重试；保留当前列表')
      if (this.state.localCatalog) this.state.localCatalog.models = mergeLocalModels(this.state.localCatalog.models || [], models)
      this.changed(); return this.snapshot()
    }
    if (input.action === 'cancel_local') { this.localChildren.get(input.taskId)?.send({ type: 'cancel' }); return this.snapshot() }
    if (input.action === 'scan_local') {
      const previousModels = this.state.localCatalog?.models || []
      this.state.localCatalog = await this.observe({ type: 'scan' }) as LocalCatalog
      this.mergeGrantedLocalProjects()
      this.state.localCatalog.models = mergeLocalModels(previousModels, this.state.localCatalog.models || [])
      this.state.desktopRelay = await desktopRelayRequest({ action: 'status' }).then(reply => ({ ready: reply.ready === true, message: reply.ready ? 'Codex 桌面直连已就绪' : '请重新启动 Codex，使桌面桥接生效' })).catch(error => ({ ready: false, message: errorText(error) }))
      this.changed()
      return this.snapshot()
    }
    if (input.action === 'read_local_history') {
      const selectedSessionId = input.sessionId
      this.state.localHistory = await this.observe({ type: 'history', sessionId: input.sessionId }) as AgentHostSnapshot['localHistory']
      const session = this.state.localCatalog?.sessions.find(item => item.id === selectedSessionId)
      if (session?.adapter === 'codex' && this.state.desktopRelay?.ready) {
        const reply = await desktopRelayRequest({ action: 'read', targetThreadId: session.runtimeSessionId }).catch(() => undefined)
        const current = (reply?.result?.thread as { model?: string } | undefined)?.model
        if (current && /^[a-zA-Z0-9._:/-]{1,120}$/.test(current) && this.state.localCatalog) this.state.localCatalog.models = mergeLocalModels(this.state.localCatalog.models || [], [{ id: current, name: current, adapter: 'codex' }])
      }
      await this.refreshDesktopTasks(input.sessionId)
      return this.snapshot()
    }
    let observedRoot: string | undefined
    if (input.action === 'begin_association') {
      await this.associations.begin(input.adapter)
      this.state.associations = this.associations.snapshot(); this.changed(); return this.snapshot()
    }
    if (input.action === 'check_associations') {
      await this.checkAssociations(true); this.changed(); return this.snapshot()
    }
    if (input.action === 'discover') {
      this.state.discovered = await Promise.all((Object.keys(ADAPTERS) as AgentAdapter[]).map(async (adapter) => {
        try {
          const found = await this.resolveLaunch(adapter)
          return { adapter, name: ADAPTERS[adapter].name, available: !!found, message: adapter === 'deepseek-harness' ? '使用内置 DSH；请先在首页启动 Harness，再绑定项目并启动同步' : found ? '发现本地命令；绑定后检查登录与会话状态' : '未发现命令，请先安装并完成智能体自身登录' }
        } catch (error) { return { adapter, name: ADAPTERS[adapter].name, available: false, message: errorText(error) } }
      }))
      return this.snapshot()
    }
    const owner = this.options.ownerId()
    if (!owner) throw new Error('请先登录 AI历史书账号，再绑定这台电脑')
    if (this.saved.ownerUserId && owner !== this.saved.ownerUserId) throw new Error('这台电脑绑定了另一账号，请切回原账号解除绑定后重试')
    if (input.action === 'discover_existing') {
      await this.checkConnection(true)
      this.state.legacyCandidates = await Promise.all(LEGACY_ADAPTERS.map(async adapter => {
        try { const existing = await readLegacyBinding(adapter); return { adapter, available: true, projectRoots: existing.projectRoots, message: '发现已授权的旧连接器，可关联原网站实例；关联后需主动启动' } }
        catch (error) { return { adapter, available: false, projectRoots: [], message: errorText(error) } }
      }))
      return this.snapshot()
    }
    if (input.action === 'import_existing') {
      await this.checkConnection(true)
      const selectedAgentId = input.agentId
      const cloud = this.state.cloudAgents?.find(agent => agent.id === selectedAgentId)
      if (!cloud || !(LEGACY_ADAPTERS as readonly AgentAdapter[]).includes(cloud.adapter as AgentAdapter)) throw new Error('当前账号中没有这个受支持的智能体')
      if (this.saved.agents.some(agent => agent.id === cloud.id)) return this.snapshot()
      if (this.saved.agents.length >= 12) throw new Error('每台电脑最多托管 12 个智能体实例')
      const legacy = await readLegacyBinding(cloud.adapter as AgentAdapter)
      if (!this.saved.deviceId) await this.perform({ action: 'bind_device' })
      const resolved = await this.options.request({ scope: 'devices', method: 'POST', action: 'resolve_legacy', body: { deviceId: this.saved.deviceId, interactionKey: legacy.key } })
      this.assertOwner(owner)
      if (resolved.agentId !== cloud.id || resolved.adapter !== cloud.adapter) throw new Error('本机配置与所选网站智能体不匹配，不会覆盖原绑定')
      const { key, ...privateLegacy } = legacy
      const unavailable = legacy.adapter === 'trae'
      const binding: Binding = { id: cloud.id, name: cloud.name, adapter: legacy.adapter, projectRoots: legacy.projectRoots, projectScope: 'all_native', key, executable: legacy.executable, executableArgs: legacy.executableArgs,
        legacy: privateLegacy, autoStart: false, desiredRunning: false, status: 'stopped', runtimeStatus: unavailable ? 'unavailable' : 'unknown', busy: false, pendingCloudBind: true,
        message: unavailable ? 'TRAE 远程交互暂不支持：保留原项目和历史，请使用其他已就绪智能体。' : '已关联原网站实例；点击启动后接管旧同步服务，原项目和会话保留' }
      this.saved.agents.push(binding)
      await this.persist()
      await this.completePendingBinding(binding)
      await this.persist()
      this.changed()
      return this.snapshot()
    }
    if (input.action === 'bind_local_project') {
      const projectId = input.projectId
      const project = this.state.localCatalog?.projects.find(item => item.id === projectId)
      if (!project) throw new Error('请先刷新本机项目，再选择需要同步的目录')
      observedRoot = await realpath(project.path)
      if (!safeProjectRoot(observedRoot)) throw new Error('不能托管磁盘根目录')
      if (!this.saved.deviceId) await this.perform({ action: 'bind_device' })
      const existing = this.saved.agents.find(agent => agent.adapter === project.adapter)
      if (existing) {
        if (existing.busy) throw new Error('智能体正在运行任务，请完成后开启同步')
        if (existing.projectScope !== 'all_native') {
          existing.projectScope = 'all_native'
          await this.persist()
          if (this.children.has(existing.id)) await this.stopAgent(existing)
        }
        existing.desiredRunning = true
        await this.startAgent(existing)
        await this.persist()
        return this.snapshot()
      }
      input = { action: 'add_agent', adapter: project.adapter, name: ADAPTERS[project.adapter].name }
    }
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
        const result = await this.options.request({ scope: 'devices', method: 'POST', action: 'register', body: { name: this.saved.deviceName || hostname(), installationId: this.saved.installationId, platform: process.platform, launcherVersion: this.options.launcherVersion, registrationKey: this.saved.deviceKey } })
        this.assertOwner(owner)
        if (!result.deviceKey || !(result.device as Reply)?.id) throw new Error('设备绑定未返回有效凭据')
        if (result.deviceKey !== this.saved.deviceKey) throw new Error('设备注册凭据不匹配，请更新服务器设备接口后重试')
        this.saved.deviceId = String((result.device as Reply).id)
        this.saved.deviceName = String((result.device as Reply).name || this.saved.deviceName || hostname())
        this.saved.deviceKey = String(result.deviceKey)
        this.saved.ownerUserId = owner
      }
      this.saved.enabled = true
    } else if (input.action === 'rename_device') {
      const name = input.name.trim()
      if (!name || [...name].length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('设备名称需为 1–80 个字符，不能包含控制字符')
      const result = await this.options.request({ scope: 'devices', method: 'POST', action: 'rename', body: { deviceId: this.saved.deviceId, name } })
      this.assertOwner(owner)
      if ((result.device as Reply)?.id !== this.saved.deviceId || (result.device as Reply)?.name !== name) throw new Error('设备名称尚未同步，请重试')
      this.saved.deviceName = name
    } else if (input.action === 'pause') {
      if (this.isBusy()) throw new Error('还有任务运行中，请等完成后暂停托管')
      this.saved.enabled = false
      this.saved.manuallyPaused = true
      this.leaseValidUntil = 0
      await this.stopAll()
      this.state.connection = 'offline'
      this.state.message = '托管已暂停，手机暂时无法启动本机智能体'
    } else if (input.action === 'resume') {
      if (!this.saved.deviceKey) throw new Error('请先绑定这台电脑')
      this.saved.enabled = true
      this.saved.manuallyPaused = false
    } else if (input.action === 'revoke_device') {
      if (this.isBusy()) throw new Error('请先等待当前任务完成再解除设备绑定')
      await this.options.request({ scope: 'devices', method: 'POST', action: 'revoke', body: { deviceId: this.saved.deviceId } })
      this.saved.enabled = false
      this.leaseValidUntil = 0
      await this.stopAll()
      this.saved.deviceKey = ''; this.saved.deviceId = ''; this.saved.ownerUserId = ''; this.saved.agents = []; this.saved.commands = {}
      // Keep this installation's identity; an explicit later login may register
      // it again, but removal must not be undone by the current heartbeat.
      this.autoConnectedOwner = owner
      this.state.connection = 'unbound'
    } else if (input.action === 'add_agent') {
      if (!this.saved.deviceKey) throw new Error('请先绑定这台电脑')
      await this.ensureLease(true)
      if (!Object.hasOwn(ADAPTERS, input.adapter)) throw new Error('当前版本不支持这个适配器')
      if (input.adapter === 'trae') throw new Error('TRAE 远程交互暂不支持；可以保留原网站记录，但不能新建可执行绑定')
      if (this.saved.agents.length >= 12) throw new Error('每台电脑最多托管 12 个智能体实例')
      const launch = await this.resolveLaunch(input.adapter)
      if (!launch) throw new Error('没有找到可直接运行的智能体。请安装官方原生程序或官方 npm 包；不支持任意 cmd/bat 启动脚本')
      this.assertOwner(owner)
      const result = await this.options.request({ scope: 'hub', method: 'POST', action: 'add_agent', body: { adapterCode: input.adapter, displayName: (input.name || ADAPTERS[input.adapter].name).slice(0, 80) } })
      this.assertOwner(owner)
      const instance = (result.instance || result.agent) as Reply
      const key = String(result.interactionKey || '')
      if (!/^[A-Za-z0-9_-]{16,80}$/.test(String(instance?.id || '')) || !/^agh_live_[A-Za-z0-9_-]{32,}$/.test(key)) throw new Error('智能体绑定返回无效，请刷新网站实例列表检查')
      const binding: Binding = { id: String(instance.id), name: String(instance.displayName || instance.name || input.name || ADAPTERS[input.adapter].name), adapter: input.adapter, key, executable: launch.executable, executableArgs: launch.args, projectRoots: [], projectScope: 'all_native', autoStart: false, desiredRunning: false, status: 'stopped', runtimeStatus: 'unknown', busy: false, pendingCloudBind: true }
      // Persist the one-time key before a second network call can fail.
      this.saved.agents.push(binding)
      await this.persist()
      await this.completePendingBinding(binding)
      await this.ensureLease(true)
      binding.message = '已完成绑定，请主动点击启动后再交互'
      if (observedRoot) {
        binding.desiredRunning = true
        await this.startAgent(binding)
      }
    } else if ('agentId' in input) {
      const binding = this.saved.agents.find((agent) => agent.id === input.agentId)
      if (!binding) throw new Error('这个智能体不属于当前设备')
      if (['stop', 'restart', 'remove_agent', 'add_project', 'authorize_agent'].includes(input.action) && binding.busy) throw new Error('智能体还有任务运行，请等完成后操作')
      if (input.action === 'authorize_agent') {
        if (binding.projectScope !== 'all_native') {
          binding.projectScope = 'all_native'
          await this.persist()
          if (this.children.has(binding.id)) { await this.stopAgent(binding); await this.startAgent(binding) }
        }
      } else if (input.action === 'add_project') {
        throw new Error('项目由智能体自动同步，无需逐个添加；请先连接并授权这个智能体')
      } else if (input.action === 'refresh') {
        await this.refreshAgent(binding)
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
  // Selecting a new workspace for a local task is separate from agent sync.
  private async chooseProject(): Promise<string | undefined> {
    const selected = await this.options.chooseDirectory()
    if (!selected) return
    const root = await realpath(selected)
    if (!safeProjectRoot(root) || !await stat(root).then(row => row.isDirectory())) throw new Error('请选择具体项目文件夹，不能使用整个磁盘')
    return root
  }
  private mergeGrantedLocalProjects(): void {
    this.state.localCatalog ||= { scannedAt: new Date().toISOString(), projects: [], sessions: [], errors: [] }
    for (const project of this.saved.localProjects || []) {
      if (!LOCAL_EXECUTION_ADAPTERS.has(project.adapter) || this.state.localCatalog.projects.some(row => row.adapter === project.adapter && sameLocalPath(row.path, project.path))) continue
      this.state.localCatalog.projects.unshift({ ...project, id: createHash('sha256').update(`${project.adapter}:${project.path.toLowerCase()}`).digest('hex'), lastActivityAt: '' })
    }
  }
  private async createEmptyProject(adapter: AgentAdapter, requestId: string | undefined): Promise<string> {
    if (!requestId || !/^[a-f0-9]{32}$/.test(requestId)) throw new Error('空白项目请求编号无效')
    const storage = await realpath(this.options.storageDir)
    const parent = path.join(storage, 'local-projects')
    await mkdir(parent, { recursive: true })
    if ((await lstat(parent)).isSymbolicLink() || !sameLocalPath(await realpath(parent), parent)) throw new Error('空白项目存储目录被重定向，已停止')
    const target = path.join(parent, `${adapter}-${requestId}`)
    try { await mkdir(target) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const info = await lstat(target)
      if (info.isSymbolicLink() || !info.isDirectory() || !(this.saved.localProjects || []).some(project => project.adapter === adapter && sameLocalPath(project.path, target))) throw new Error('该请求目录已经存在且归属未确认，不会覆盖或授权')
    }
    return realpath(target)
  }
  private async localRuntimeDescriptors(): Promise<LocalRuntimeDescriptor[]> {
    const descriptors: LocalRuntimeDescriptor[] = []
    for (const binding of this.saved.agents) {
      if (binding.adapter === 'trae' || this.saved.ownerUserId !== this.options.ownerId()) continue
      const projects = []
      const roots = binding.projectScope === 'all_native'
        ? [...new Set([...binding.projectRoots, ...(this.state.localCatalog?.projects.filter(project => project.adapter === binding.adapter).map(project => project.path) || []), ...(this.saved.localProjects || []).filter(project => project.adapter === binding.adapter).map(project => project.path)])]
        : [...new Set([...binding.projectRoots, ...(this.saved.localProjects || []).filter(project => project.adapter === binding.adapter).map(project => project.path)])]
      for (const root of roots) {
        const actual = await realpath(root).catch(() => '')
        if (!actual || !safeProjectRoot(actual)) continue
        projects.push({ id: createHash('sha256').update(binding.adapter + ':' + actual.toLowerCase()).digest('hex').slice(0, 32), name: path.basename(actual), path: actual, cloudAllowed: true })
      }
      if (!projects.length) continue
      const runtime: Record<string, unknown> = { executable: binding.executable, executableArgs: binding.executableArgs || [] }
      if (binding.adapter === 'deepseek-harness') { try { runtime.dshHost = await this.dshHostSettings() } catch { continue } }
      if (binding.legacy) for (const key of ['qclawStateDir', 'qclawConfigPath', 'qclawAgentId'] as const) if (binding.legacy.settings[key]) runtime[key] = binding.legacy.settings[key]
      descriptors.push({ id: binding.id, name: binding.name, adapter: binding.adapter, projects, runtime, capabilities: { localExecution: true, approvalControl: ['codex', 'cursor', 'deepseek-harness'].includes(binding.adapter), richEvents: ['codex', 'cursor', 'deepseek-harness'].includes(binding.adapter) } })
    }
    const local = [...(this.state.localCatalog?.projects || []), ...(this.saved.localProjects || [])]
    for (const adapter of AGENT_CATALOG.filter(item => item.execution).map(item => item.id)) {
      const remaining = local.filter(project => project.adapter === adapter && !descriptors.some(row => row.adapter === adapter && row.projects.some(item => sameLocalPath(item.path, project.path))))
      if (!remaining.length) continue
      const launch = adapter === 'deepseek-harness' ? { executable: this.options.nodePath, args: [] } : await this.resolveLaunch(adapter); if (!launch) continue
      const runtime: Record<string, unknown> = { executable: launch.executable, executableArgs: launch.args }
      if (adapter === 'deepseek-harness') { try { runtime.dshHost = await this.dshHostSettings() } catch { continue } }
      descriptors.push({ id: 'local:' + adapter, name: ADAPTERS[adapter].name + '（本机）', adapter, projects: remaining.filter((row, index, rows) => rows.findIndex(item => item.id === row.id) === index).map(row => ({ id: row.id, name: row.name, path: row.path, cloudAllowed: false })), runtime, capabilities: { localExecution: true, approvalControl: adapter !== 'claude-code', richEvents: adapter !== 'claude-code' } })
    }
    return descriptors
  }
  private async performLocalControl(action: Extract<AgentHostAction, { action: 'local_control' }>): Promise<void> {
    const requestOwner = this.options.ownerId()
    const allowed = ['snapshot', 'create_room', 'read_room', 'read_event', 'send_room', 'cancel_run', 'reconcile_run', 'accept_run', 'preflight_merge', 'set_permission', 'decide_approval', 'choose_files', 'preview_file', 'open_file', 'save_file', 'refresh_catalog', 'authorize_project']
    if (!allowed.includes(action.command)) throw new Error('本地总控操作无效')
    this.localControl ||= new LocalControlBridge({ storageDir: this.options.storageDir, moduleDir: this.options.moduleDir, nodePath: this.options.nodePath, ownerId: this.options.ownerId, descriptors: () => this.localRuntimeDescriptors(), nativeRequest: (command, input) => this.nativeOnlineRequest(command, input), onChange: () => this.changed() })
    if (action.command === 'authorize_project') {
      const adapter = String(action.input?.adapter || '') as AgentAdapter
      if (!LOCAL_EXECUTION_ADAPTERS.has(adapter)) throw new Error('该智能体暂未打通本地执行与主动连接')
      const selected = action.input?.createEmpty === true ? await this.createEmptyProject(adapter, action.requestId) : await this.chooseProject()
      if (requestOwner !== this.options.ownerId()) throw new Error('选择目录期间账号已切换，未保存授权')
      if (!selected) {
        this.localControlResultOwner = requestOwner
        this.localControlResult = { requestId: action.requestId, result: { cancelled: true } }
        this.changed()
        return
      }
      if (selected) { const id = createHash('sha256').update(adapter + ':' + selected.toLowerCase()).digest('hex').slice(0, 32); this.saved.localProjects ||= []; if (!this.saved.localProjects.some(row => row.id === id)) this.saved.localProjects.push({ id, adapter, name: path.basename(selected), path: selected }); await this.persist() }
      this.mergeGrantedLocalProjects()
      await this.localControl.refreshContext()
    }
    if (action.command === 'refresh_catalog') {
      this.state.localCatalog = await this.observe({ type: 'scan' }) as LocalCatalog
      this.mergeGrantedLocalProjects()
      await this.localControl.refreshContext()
    }
    let result: Record<string, unknown>
    if (action.command === 'choose_files') {
      const selected = await dialog.showOpenDialog({ title: '附加本地文件版本（不会立即上传）', properties: ['openFile', 'multiSelections'] })
      result = selected.canceled ? { cancelled: true } : await this.localControl.request('attach_files', { roomId: action.input?.roomId, paths: selected.filePaths }, action.requestId)
    } else result = await this.localControl.request(['refresh_catalog', 'authorize_project'].includes(action.command) ? 'snapshot' : action.command === 'save_file' ? 'open_file' : action.command, action.input, action.requestId)
    if (action.command === 'save_file' && result.localPath) {
      const file = result.file as { name: string }
      const selected = await dialog.showSaveDialog({ title: '另存此文件版本', defaultPath: path.basename(file.name) })
      if (!selected.canceled && selected.filePath) await copyFile(String(result.localPath), selected.filePath)
      result = { saved: !selected.canceled, file: result.file }
    }
    if (action.command === 'open_file' && result.localPath) {
      const file = result.file as { id: string; name: string }
      if (!/\.(?:pdf|png|jpe?g|webp|gif|txt|md|csv|json|docx|xlsx|pptx|mp4|webm|mp3|wav|ogg|dwg|dxf|step|stp)$/i.test(file.name)) throw new Error('此类型不自动启动本地程序；请使用预览或自行检查文件')
      const directory = path.join(this.options.storageDir, 'local-control', 'opened', file.id)
      await mkdir(directory, { recursive: true })
      if ((await lstat(directory)).isSymbolicLink()) throw new Error('文件打开目录不安全')
      const destination = path.join(directory, path.basename(file.name))
      if (await lstat(destination).then(row => row.isSymbolicLink()).catch(() => false)) throw new Error('文件打开路径不安全')
      await copyFile(String(result.localPath), destination)
      const error = await shell.openPath(destination); if (error) throw new Error('本地应用未能打开文件，请检查文件关联')
      result = { opened: true, file: result.file }
    }
    await this.localControl.request('snapshot')
    if (['snapshot', 'refresh_catalog', 'authorize_project'].includes(action.command) && result.supported === true) result = { ...result, emptyProjectCreation: true }
    if (requestOwner !== this.options.ownerId()) { this.localControlResult = undefined; throw new Error('账号已切换，已忽略旧操作的界面结果') }
    this.localControlResultOwner = requestOwner; this.localControlResult = { requestId: action.requestId, result }; this.changed()
  }
  private observe(message: Reply): Promise<unknown> {
    if (!this.observer?.connected) {
      const child = fork(path.join(this.options.moduleDir, 'connector/local-observer.mjs'), [], { execPath: this.options.nodePath, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, env: { ...process.env, ...this.associations.environment(), ELECTRON_RUN_AS_NODE: '1' } } as ForkOptions)
      this.observer = child
      const fail = (): void => { if (this.observer === child) this.observer = undefined; for (const pending of this.observerPending.values()) { clearTimeout(pending.timer); pending.reject(new Error('本机读取服务已退出，请重新刷新')) }; this.observerPending.clear() }
      child.on('error', fail); child.on('exit', fail)
      child.on('message', (raw: unknown) => {
        const reply = raw as Reply
        const requestId = String(reply?.requestId || '')
        const pending = this.observerPending.get(requestId)
        if (!pending) return
        clearTimeout(pending.timer); this.observerPending.delete(requestId)
        if (reply.error) pending.reject(new Error(errorText(reply.error))); else pending.resolve(reply.result)
      })
    }
    return new Promise((resolve, reject) => {
      const requestId = randomUUID()
      const timer = setTimeout(() => { this.observerPending.delete(requestId); reject(new Error('本机目录读取超时，保留上次结果，请重试')) }, 60000)
      this.observerPending.set(requestId, { resolve, reject, timer })
      this.observer!.send({ ...message, requestId }, error => { if (error) { clearTimeout(timer); this.observerPending.delete(requestId); reject(new Error('本机读取连接已中断，请重试')) } })
    })
  }
  private async sendLocal(input: Extract<AgentHostAction, { action: 'send_local' }>): Promise<void> {
    if (!/^[a-f0-9-]{36}$/i.test(input.requestId)) throw new Error('本机任务请求编号无效')
    if (this.state.localTasks?.some(task => task.requestId === input.requestId)) return
    const project = this.state.localCatalog?.projects.find(item => item.id === input.projectId)
    if (!project) throw new Error('请刷新并选择本机项目')
    if (!['codex', 'claude-code'].includes(project.adapter)) throw new Error('此智能体暂未接通本机直接发送，请使用原生界面')
    const session = input.sessionId ? this.state.localCatalog?.sessions.find(item => item.id === input.sessionId && item.projectId === project.id) : undefined
    if (input.sessionId && !session) throw new Error('会话不属于所选本机项目')
    if (input.conversationId && (input.sessionId || !/^[a-f0-9]{32}$/.test(input.conversationId))) throw new Error('本机新会话标识无效')
    if (this.state.localTasks?.some(task => ['running', 'awaiting_approval', 'delivered'].includes(task.status) && task.projectId === project.id && (task.sessionId || '') === (input.sessionId || '') && (task.conversationId || '') === (input.conversationId || ''))) throw new Error('此对话已有任务运行或等待桌面处理，请等待完成后发送')
    const instruction = String(input.instruction || '').trim()
    if (!instruction || instruction.length > 12000) throw new Error('请输入任务内容，单次内容请保持在 12000 字符以内；长资料请添加文件')
    if (input.model && !this.state.localCatalog?.models?.some(model => model.adapter === project.adapter && model.id === input.model)) throw new Error('所选模型不在本机智能体目录中，请刷新或使用默认模型')
    const root = await realpath(project.path)
    if (!safeProjectRoot(root)) throw new Error('请选择具体项目目录')
    const knownConversation = input.conversationId ? this.saved.localConversations?.[input.conversationId] : undefined
    if (knownConversation && (knownConversation.projectId !== project.id || knownConversation.adapter !== project.adapter || !sameLocalPath(knownConversation.projectPath, root))) throw new Error('本机会话不属于当前项目')
    if (knownConversation && knownConversation.status !== 'ready') throw new Error('此本机会话仍在执行或结果未确认，请先核对原生状态，不会新建替代会话')
    const files = (input.fileIds || []).map(id => { const file = this.localFiles.get(id); if (!file) throw new Error('附件选择已失效，请重新选择'); return file })
    if (project.adapter === 'codex' && session) {
      const status = await desktopRelayRequest({ action: 'status' })
      if (!status.ready) throw new Error('桌面直连未就绪，草稿已保留。请重新启动 Codex 后刷新本机；不会另开 CLI 或新建替代对话')
      const before = await desktopRelayRequest({ action: 'read', targetThreadId: session.runtimeSessionId })
      const native = before.result as { thread?: { id?: string; cwd?: string }; turns?: Array<{ id: string; items?: Array<{ id?: string }> }> } | undefined
      const nativeRoot = native?.thread?.cwd ? await realpath(native.thread.cwd).catch(() => '') : ''
      if (!before.ok || native?.thread?.id !== session.runtimeSessionId || !sameLocalPath(nativeRoot, root)) throw new Error('原对话与本机项目映射未通过校验，草稿已保留，请刷新目录')
      const prompt = instruction + (files.length ? '\n\n用户为此任务选择的本机附件（只在本机读取）：\n' + files.map(file => JSON.stringify(file.path)).join('\n') : '')
      const task: LocalTask = { id: randomUUID(), requestId: input.requestId, projectId: project.id, sessionId: input.sessionId, status: 'running', backend: 'desktop', instruction, deliveryPrompt: prompt, baselineTurnId: native.turns?.[0]?.id, summary: '正在发送到桌面原对话', startedAt: new Date().toISOString() }
      task.baselineItemIds = native.turns?.flatMap(turn => (turn.items || []).map(item => item.id).filter((id): id is string => !!id)) || []
      this.state.localTasks = [...(this.state.localTasks || []).slice(-49), task]; this.changed()
      await this.persistDesktopTasks()
      try {
        const reply = await desktopRelayRequest({ action: 'send', requestId: input.requestId, targetThreadId: session.runtimeSessionId, message: prompt, model: input.model || '', baselineTurnId: task.baselineTurnId })
        task.status = reply.status || 'unconfirmed'
        task.summary = reply.status === 'delivered' ? '已送达桌面原对话，等待执行状态同步' : reply.error || '发送结果未确认，请检查原对话，不要重复发送'
      } catch (error) { task.status = 'unconfirmed'; task.summary = errorText(error) }
      await this.persistDesktopTasks(); this.changed(); return
    }
    const launch = await this.resolveLaunch(project.adapter)
    if (!launch) throw new Error('没有检测到该智能体的本机命令，请先安装并登录原生智能体')
    const id = randomUUID()
    const task: LocalTask = { id, requestId: input.requestId, projectId: project.id, sessionId: input.sessionId, conversationId: input.conversationId, status: 'running', instruction, summary: knownConversation?.runtimeSessionId ? '继续本机原生会话' : '正在启动本机智能体', startedAt: new Date().toISOString() }
    this.state.localTasks = [...(this.state.localTasks || []).slice(-49), task]
    const conversation = input.conversationId ? knownConversation || { projectId: project.id, projectPath: root, adapter: project.adapter, runtimeSessionId: '', status: 'ready' as const } : undefined
    if (conversation && input.conversationId) { this.saved.localConversations ||= {}; conversation.status = 'running'; this.saved.localConversations[input.conversationId] = conversation }
    await this.persistDesktopTasks()
    const localTaskRoot = path.join(this.options.storageDir, 'local-tasks')
    const child = fork(path.join(this.options.moduleDir, 'connector/local-runner.mjs'), [], { execPath: this.options.nodePath, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, env: { ...process.env, ...this.associations.environment(), ELECTRON_RUN_AS_NODE: '1', SHENLAN_LOCAL_TASK_ROOT: localTaskRoot } } as ForkOptions)
    this.localChildren.set(id, child)
    const update = (values: Reply): void => { Object.assign(task, values); this.changed() }
    child.on('message', (raw: unknown) => {
      const message = raw as Reply
      if (message?.type === 'progress') update({ summary: String((message.progress as Reply)?.summary || '本机执行中') })
      if (message?.type === 'result') {
        const result = message.result as Reply
        const nativeId = typeof result.sessionId === 'string' && /^[A-Za-z0-9._:-]{1,191}$/.test(result.sessionId) ? result.sessionId : ''
        if (conversation) {
          if (nativeId && conversation.runtimeSessionId && nativeId !== conversation.runtimeSessionId) { conversation.status = 'unconfirmed'; update({ status: 'unconfirmed', summary: '原生会话编号意外变化，已停止自动续聊' }); void this.persistDesktopTasks().catch(() => {}); return }
          if (nativeId) conversation.runtimeSessionId = nativeId
          conversation.status = conversation.runtimeSessionId ? 'ready' : 'unconfirmed'
          task.runtimeSessionId = conversation.runtimeSessionId || undefined
          if (!conversation.runtimeSessionId) { update({ status: 'unconfirmed', reply: String(result.finalReply || ''), summary: '原生会话编号未确认，请查看原生记录；不会另开替代对话' }); void this.persistDesktopTasks().catch(() => {}); return }
        }
        const diagnostic = String(result.diagnostic || '')
        const failure = /active writer|thread-store conflict/i.test(diagnostic) ? '该会话被桌面 Codex 占用，消息未发送。请复制下面的原任务在桌面窗口继续；启动器不会抢锁或自动重发。' : errorText(diagnostic || '智能体执行失败，请检查原生登录与权限')
        update({ status: result.cancelled ? 'cancelled' : result.exitCode === 0 ? 'completed' : 'failed', reply: String(result.finalReply || ''), summary: result.exitCode === 0 ? '本机任务完成' : failure })
        void this.persistDesktopTasks().catch(() => { if (conversation) conversation.status = 'unconfirmed'; update({ status: 'unconfirmed', summary: '本机结果保存未确认，请核对原生会话' }) })
      }
    })
    child.on('error', error => { if (conversation) conversation.status = 'unconfirmed'; update({ status: 'unconfirmed', summary: errorText(error) }); void this.persistDesktopTasks().catch(() => {}) })
    child.on('exit', () => { this.localChildren.delete(id); if (task.status === 'running') { if (conversation) conversation.status = 'unconfirmed'; update({ status: 'unconfirmed', summary: '本机进程退出，未收到完成确认；不会自动重复执行' }); void this.persistDesktopTasks().catch(() => {}) } this.changed() })
    child.send({ type: 'start', adapter: project.adapter, project: { path: root }, executable: launch.executable, executableArgs: launch.args, outputDirectory: path.join(localTaskRoot, id), instruction, resumeSessionId: conversation?.runtimeSessionId || session?.runtimeSessionId || '', files, model: input.model || '' })
  }
  private async approvalContext(sessionId: string, nativeId = false): Promise<ApprovalContext> {
    if (typeof sessionId !== 'string' || sessionId.length > 160) throw new Error('会话编号无效')
    if (nativeId && !/^[a-f0-9-]{36}$/i.test(sessionId)) throw new Error('原生会话编号无效')
    if (!this.state.localCatalog?.sessions.some(session => (nativeId ? session.runtimeSessionId : session.id) === sessionId)) {
      this.state.localCatalog = await this.observe({ type: 'scan' }) as LocalCatalog
      this.mergeGrantedLocalProjects()
    }
    const session = this.state.localCatalog?.sessions.find(session => (nativeId ? session.runtimeSessionId : session.id) === sessionId && session.adapter === 'codex')
    const project = this.state.localCatalog?.projects.find(project => project.id === session?.projectId && project.adapter === 'codex')
    if (!session || !project) throw new Error('当前会话没有可核实的 Codex 原生审批通道')
    return { sessionId, threadId: session.runtimeSessionId, projectPath: await realpath(project.path) }
  }
  private async nativeOnlineRequest(command: string, input: Record<string, any>): Promise<Record<string, any>> {
    if (!['native_approvals', 'native_decide'].includes(command)) throw new Error('不支持的原生操作')
    const owner = this.options.ownerId()
    const binding = this.saved.agents.find(binding => binding.id === input.agentId && binding.adapter === 'codex')
    const authorize = (): void => {
      this.assertOwner(owner)
      if (!owner || !binding || !this.saved.enabled || this.disposed || !this.boundAgentIds.has(binding.id) || this.leaseValidUntil <= Date.now() || !this.saved.agents.includes(binding)) throw new Error('设备或智能体授权已经失效')
    }
    authorize()
    const context = await this.approvalContext(input.runtimeSessionId, true)
    authorize()
    if (binding!.projectScope !== 'all_native' && !binding!.projectRoots.some(root => inside(root, context.projectPath))) throw new Error('会话不在这个智能体的同步范围内')
    if (command === 'native_approvals') { const result = await this.nativeApprovals.read(context); authorize(); return result }
    if (typeof input.approved !== 'boolean' || !/^[a-f0-9]{64}$/.test(input.id) || !/^[a-f0-9]{64}$/.test(input.requestHash)) throw new Error('审批决定无效')
    return this.nativeApprovals.decide(context, input as { id: string; requestHash: string; approved: boolean }, authorize)
  }
  private async refreshDesktopTasks(sessionId: string): Promise<void> {
    const pending = this.state.localTasks?.filter(task => task.backend === 'desktop' && task.sessionId === sessionId && ['running', 'awaiting_approval', 'delivered', 'unconfirmed'].includes(task.status)) || []
    if (!pending.length) return
    const session = this.state.localCatalog?.sessions.find(item => item.id === sessionId)
    if (!session) return
    try {
      const reply = await desktopRelayRequest({ action: 'read', targetThreadId: session.runtimeSessionId })
      const native = reply.result as { turns?: Array<{ id: string; status: string; items?: Array<{ id?: string; type: string; text?: string; phase?: string; content?: Array<{ text?: string }> }> }> } | undefined
      if (!reply.ok) return
      for (const task of pending) {
        const turn = native?.turns?.find(turn => task.deliveryTurnId ? turn.id === task.deliveryTurnId : turn.items?.some(item => item.type === 'userMessage' && (!item.id || !task.baselineItemIds?.includes(item.id)) && item.content?.map(part => part.text || '').join('\n') === task.deliveryPrompt))
        if (!turn) continue
        task.deliveryTurnId = turn.id
        if (turn.status === 'completed') {
          task.status = 'completed'; task.summary = '桌面原对话任务已完成'
          task.reply = turn.items?.filter(item => item.type === 'agentMessage' && item.phase === 'final_answer').map(item => item.text).join('\n')
        } else if (turn.status === 'failed' || turn.status === 'interrupted') { task.status = 'failed'; task.summary = '桌面原对话执行失败或已中断，请查看原对话' }
        else {
          const approvals = await this.nativeApprovals.read({ sessionId, threadId: session.runtimeSessionId, projectPath: this.state.localCatalog?.projects.find(project => project.id === session.projectId)?.path || '' })
          const waiting = approvals.requests.some(request => request.turnId === turn.id && request.state === 'pending')
          task.status = waiting ? 'awaiting_approval' : 'running'
          task.summary = waiting ? '原对话等待审批，可在下方批准一次或拒绝' : approvals.status === 'ready' ? '原对话正在执行，审批将同步到此处' : '原对话正在执行；审批通道暂不可用，状态不会被当作审批成功'
        }
      }
      await this.persistDesktopTasks()
    } catch { /* Read failures do not imply send failures and never trigger resend. */ }
  }
  private async persistDesktopTasks(): Promise<void> {
    this.saved.desktopTasks = this.state.localTasks?.filter(task => task.backend === 'desktop').slice(-50)
    this.saved.cliTasks = this.state.localTasks?.filter(task => task.backend !== 'desktop').slice(-50)
    await this.persist()
  }
  private async refreshAgent(binding: Binding): Promise<void> {
    this.assertMayStart(binding)
    const child = this.children.get(binding.id)
    if (!child?.connected) throw new Error('本机同步进程尚未启动，请先启动智能体')
    const requestId = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit) }
      const onExit = (): void => { cleanup(); reject(new Error('同步进程已退出')) }
      const onMessage = (raw: unknown): void => {
        const reply = raw as Reply
        if (reply?.type !== 'refresh_result' || reply.requestId !== requestId) return
        cleanup(); reply.error ? reject(new Error(errorText(reply.error))) : resolve()
      }
      const timer = setTimeout(() => { cleanup(); reject(new Error('本机同步尚未确认，请稍后检查同步时间，不要重复提交任务')) }, 45000)
      child.on('message', onMessage); child.once('exit', onExit)
      child.send({ type: 'refresh', requestId }, error => { if (error) { cleanup(); reject(new Error('无法通知本机同步进程')) } })
    })
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
    if (binding.adapter === 'trae') {
      binding.runtimeStatus = 'unavailable'; binding.desiredRunning = false
      binding.message = 'TRAE 远程交互暂不支持：原窗口发送接口拒绝当前账号。保留项目与历史，请使用其他已就绪智能体。'
      this.changed()
      throw new Error(binding.message)
    }
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
    const registered = !binding.legacy && this.associations.launch(binding.adapter)
    if (registered) { binding.executable = registered.executable; binding.executableArgs = registered.args }
    const dshHost = binding.adapter === 'deepseek-harness' ? await this.dshHostSettings() : undefined
    const entry = path.join(this.options.moduleDir, 'connector', 'host-child.mjs')
    await access(entry).catch(() => { throw new Error('缺少智能体托管模块，请在版本管理中更新或安装最新版启动器') })
    const stateDirectory = path.join(this.options.storageDir, 'instances', binding.id)
    await mkdir(stateDirectory, { recursive: true })
    if (binding.legacy) {
      const legacy = binding.legacy
      await prepareLegacyHandoff(legacy, path.join(stateDirectory, 'connector-state.json'), async (pid) => {
        const control = await import(pathToFileURL(path.join(this.options.moduleDir, 'connector', 'service-control.mjs')).href)
        return control.requestServiceHandoff(legacy.sourceFile, binding.key, pid)
      })
    }
    this.assertMayStart(binding)
    binding.status = 'starting'; binding.message = '正在连接本地智能体与网站'
    const epoch = (this.childEpoch.get(binding.id) || 0) + 1
    this.childEpoch.set(binding.id, epoch)
    const environment = { ...process.env, ...(!binding.legacy ? this.associations.environment(binding.adapter) : {}), ELECTRON_RUN_AS_NODE: '1', SHENLAN_DESKTOP_RUNNER: path.join(this.options.moduleDir, 'native-task-runner.mjs'), SHENLAN_LOCAL_CONTROL_ROOT: path.join(this.options.storageDir, 'local-control') }
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
      binding.runtimeStatus = binding.busy ? 'busy' : data.runtimeReady === true ? 'ready' : data.phase === 'failed' || data.runtimeReady === false ? 'error' : 'unknown'
      binding.lastCatalogAt = typeof data.lastCatalogAt === 'string' ? data.lastCatalogAt : binding.lastCatalogAt
      binding.lastSyncedAt = typeof data.lastSyncedAt === 'string' ? data.lastSyncedAt : binding.lastSyncedAt
      binding.message = data.error ? errorText(data.error) : data.runtimeReady === false ? '同步服务已连接，但智能体尚未通过本机检查；请确认应用登录与网关状态，可直接停止或重启服务' : undefined
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
    const startMessage = { type: 'start', instanceId: binding.id, authorizedProjectRoots: binding.projectRoots, authorizedNativeProjects: binding.projectScope === 'all_native', config: {
      serverUrl: 'https://ailishishu.com/ailishishu-stats/api/agent-connector.php', interactionKey: binding.key,
      adapterCode: binding.adapter, runtimeLabel: hostname(), runtimeExecutable: binding.executable,
      runtimeExecutableArgs: binding.executableArgs || [],
      ...(dshHost ? { dshHost } : {}),
      ...(binding.legacy?.settings || {}),
      stateFile: path.join(stateDirectory, 'connector-state.json'), sandbox: 'workspace-write',
      projects: binding.projectRoots.map((root) => ({ name: path.basename(root), path: root, enabled: true })),
      projectDiscovery: { enabled: true, roots: binding.projectScope === 'all_native' ? [] : binding.projectRoots, maxProjects: 200, maxSessionsPerProject: 100,
        ...(this.associations.launch(binding.adapter)?.runtimeHome ? { runtimeHome: this.associations.launch(binding.adapter)!.runtimeHome } : {}) },
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
  private async connectSignedInDevice(): Promise<void> {
    const owner = this.options.ownerId()
    if (!owner) { this.autoConnectedOwner = undefined; return }
    if (this.autoConnectedOwner === owner || this.state.accountConnection?.status !== 'connected') return
    // Registration needs the signed-in user's token; a revoked device key can
    // never recreate a device by itself. Check only once per login/startup.
    if (this.saved.ownerUserId && this.saved.ownerUserId !== owner) return
    const result = await this.options.request({ scope: 'devices', method: 'GET', action: 'list' })
    this.assertOwner(owner)
    if (!Array.isArray(result.devices)) throw new Error('设备列表尚未确认，暂不自动登记')
    const existing = result.devices.find((value): value is Reply => !!value && typeof value === 'object' && (value as Reply).id === this.saved.deviceId)
    if (existing) {
      this.saved.deviceName = String(existing.name || this.saved.deviceName || hostname())
      if (!this.saved.manuallyPaused) this.saved.enabled = true
    } else {
      if (this.isBusy() || this.children.size) throw new Error('请等待原托管任务安全结束后重新登记设备')
      const keepPaused = this.saved.manuallyPaused === true
      const removedDevice = Boolean(this.saved.deviceId)
      this.saved.deviceId = ''
      // Keep an in-flight registration key for response-loss idempotency.
      // A known removed device rotates its key after this account-authenticated lookup.
      if (removedDevice) this.saved.deviceKey = ''
      for (const binding of this.saved.agents) { binding.pendingCloudBind = true; binding.desiredRunning = false }
      await this.perform({ action: 'bind_device' })
      for (const binding of this.saved.agents) await this.completePendingBinding(binding)
      if (keepPaused) this.saved.enabled = false
    }
    this.assertOwner(owner)
    await this.persist()
    this.autoConnectedOwner = owner
  }
  async tick(): Promise<void> {
    if (this.polling || this.disposed) return
    this.polling = true
    let delay = 15000
    try {
      await this.checkAssociations()
      await this.checkConnection()
      if (!this.options.ownerId()) { await this.suspendForSignOut(); return }
      const autoConnect = this.actionQueue.catch(() => {}).then(() => this.connectSignedInDevice())
      this.actionQueue = autoConnect
      await autoConnect
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
      const owner = this.options.ownerId(), deviceId = this.saved.deviceId
      this.localControl ||= new LocalControlBridge({ storageDir: this.options.storageDir, moduleDir: this.options.moduleDir, nodePath: this.options.nodePath, ownerId: this.options.ownerId, descriptors: () => this.localRuntimeDescriptors(), nativeRequest: (command, input) => this.nativeOnlineRequest(command, input), onChange: () => this.changed() })
      void this.localControl.connectOnline(channel => this.deviceRequest({ action: 'local_ticket', channel }), () => !this.disposed && this.saved.enabled && this.options.ownerId() === owner && this.saved.deviceId === deviceId).catch(() => {})
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
        if (command.command === 'refresh') await this.refreshAgent(binding)
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
    this.nativeApprovals.close()
    await this.localControl?.close()
    this.observer?.disconnect()
    if (this.timer) clearTimeout(this.timer)
    await this.stopAll()
    await this.saveQueue
  }
  private drainAll(): void {
    this.localControl?.stopOnline()
    for (const child of this.children.values()) if (child.connected) child.send({ type: 'stop' }, () => {})
  }
}
