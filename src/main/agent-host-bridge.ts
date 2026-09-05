import { createRequire } from 'node:module'
import path from 'node:path'
import type { AgentHostService, AgentHostOptions } from './agent-host/service'
import type { AgentHostAction, AgentHostSnapshot } from '../shared/agent-host'
import type { RuntimeModuleStore } from './runtime-modules'

/** Stable shell boundary. Modules are downloaded and verified by the existing
 * signed module store; renderer cannot supply a replacement executable path. */
export class AgentHostBridge {
  private service?: AgentHostService
  constructor(private store: RuntimeModuleStore, private readonly options: Omit<AgentHostOptions, 'moduleDir'>, private readonly bundledDir: string) {}
  async initialize(recoverStartup = true): Promise<void> {
    try { await this.loadActive() }
    catch (error) {
      if (!recoverStartup) throw error
      const active = await this.store.activeRoot('agent-host')
      if (!active) throw error
      const versions = await this.store.versions('agent-host')
      await this.service?.dispose().catch(() => {})
      if (versions.previous) {
        try {
          await this.store.rollback('agent-host')
          await this.loadActive()
          return
        } catch { await this.service?.dispose().catch(() => {}) }
      }
      // A previous downloaded version may also be incomplete. Keep its files for
      // diagnosis, clear only the active pointer and try the bundled baseline.
      await this.store.deactivate('agent-host')
      await this.loadDirectory(this.bundledDir)
    }
  }
  private async loadActive(): Promise<void> {
    const directory = await this.store.activeRoot('agent-host') || this.bundledDir
    await this.loadDirectory(directory)
  }
  private async loadDirectory(directory: string): Promise<void> {
    const require = createRequire(path.join(directory, 'host-service.cjs'))
    const file = path.join(directory, 'host-service.cjs')
    delete require.cache[require.resolve(file)]
    const module = require(file) as { AGENT_HOST_PROTOCOL: number; AgentHostService: typeof import('./agent-host/service').AgentHostService }
    if (module.AGENT_HOST_PROTOCOL !== 1 || typeof module.AgentHostService !== 'function') throw new Error('托管模块协议不兼容，请升级启动器')
    this.service = new module.AgentHostService({ ...this.options, moduleDir: directory })
    await this.service.initialize()
  }
  snapshot(): AgentHostSnapshot {
    return this.service?.snapshot() || { supported: false, enabled: false, connection: 'unbound', deviceName: '本机', agents: [], discovered: [], message: '托管模块尚未加载，请检查模块更新' }
  }
  async action(action: AgentHostAction): Promise<AgentHostSnapshot> {
    if (!this.service) throw new Error('托管模块未加载，请更新启动器')
    return this.service.action(action)
  }
  isActive(): boolean { return this.service?.isActive() === true }
  isBusy(): boolean { return this.service?.isBusy() === true }
  async suspendForSignOut(): Promise<void> { await this.service?.suspendForSignOut() }
  async reload(): Promise<void> {
    if (this.isBusy()) throw new Error('智能体正在执行任务，请等完成后更新托管模块')
    await this.dispose()
    await this.initialize(false)
  }
  async dispose(): Promise<void> { await this.service?.dispose() }
  async relocate(store: RuntimeModuleStore, storageDir: string, nodePath: string): Promise<void> {
    await this.dispose()
    this.store = store
    this.options.storageDir = storageDir
    this.options.nodePath = nodePath
    await this.initialize()
  }
}
