import path from 'node:path'
import { createHash } from 'node:crypto'
import { readFile, realpath, stat, copyFile, access } from 'node:fs/promises'
import type { AgentAdapter } from '../../shared/agent-host'

export const LEGACY_ADAPTERS = ['codex', 'claude-code', 'qclaw', 'workbuddy', 'codebuddy', 'trae'] as const
const inside = (root: string, file: string): boolean => { const r = path.relative(root, file); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r) }
export interface LegacyBindingConfig {
  adapter: AgentAdapter; sourceFile: string; stateFile: string; key: string
  executable: string; executableArgs: string[]; projectRoots: string[]
  settings: { qclawStateDir: string; qclawConfigPath: string; qclawAgentId: string }
}

export function legacyStateMayHandoff(state: { pendingCommands?: Array<{ _localStatus?: string }> }): boolean {
  return !(state.pendingCommands || []).some(command => ['preparing', 'running'].includes(command._localStatus || ''))
}

export async function prepareLegacyHandoff(legacy: Omit<LegacyBindingConfig, 'key'>, destination: string, requestHandoff?: (pid: number) => Promise<{ sha256: string }>): Promise<void> {
  // Once copied, never overwrite the new host's advanced lease/history with an
  // older independent service snapshot, including after a failed first start.
  const destinationExists = await access(destination).then(() => true).catch(() => false)
  const readState = async (allowBusy = false) => {
    if ((await stat(legacy.stateFile)).size > 32 * 1024 * 1024) throw new Error('旧同步状态过大，请先整理待同步队列')
    const state = JSON.parse(await readFile(legacy.stateFile, 'utf8'))
    if (!allowBusy && !legacyStateMayHandoff(state)) throw new Error('旧同步服务有任务正在执行，请等任务完成后启动托管')
    return state
  }
  const lock = await readFile(path.join(path.dirname(legacy.sourceFile), 'sync-service.lock'), 'utf8').then(JSON.parse).catch(() => undefined)
  let active = false
  if (Number.isSafeInteger(lock?.pid) && lock.pid > 0) {
    // A snapshot showing zero running tasks is not an atomic drain: the old
    // process could claim work immediately afterwards. Never force-kill it.
    active = true
    try { process.kill(lock.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') active = false }
    if (active && destinationExists) throw new Error('旧服务和托管状态同时存在，请先处理旧服务；不会覆盖任一任务队列')
  }
  // Once the acknowledged state exists and no old process is alive, later
  // starts must no longer depend on files the user is free to archive/remove.
  if (destinationExists) return
  await readState(true)
  if (active) {
      if (!requestHandoff) throw new Error('旧同步服务仍在运行，需先完成平滑交接；原任务、绑定和回复均已保留，不会强制终止')
      const receipt = await requestHandoff(lock.pid)
      const stateHash = createHash('sha256').update(await readFile(legacy.stateFile)).digest('hex')
      if (!/^[a-f0-9]{64}$/.test(receipt.sha256) || receipt.sha256 !== stateHash) throw new Error('旧同步服务交接状态已变化，不会使用不一致的任务队列')
      await access(path.join(path.dirname(legacy.sourceFile), 'sync-service.handed-off.json')).catch(() => { throw new Error('旧服务未确认停用自动启动，交接未完成') })
  }
  await readState()
  await copyFile(legacy.stateFile, destination, 1)
}
// Fixed per-user service directory only. Cloud and renderer cannot choose a file
// or executable, and this structure must never be returned through IPC.
export async function readLegacyBinding(adapter: AgentAdapter, base = path.join(process.env.LOCALAPPDATA || '', 'ShenlanAI', 'AgentSync')): Promise<LegacyBindingConfig> {
  if (!(LEGACY_ADAPTERS as readonly AgentAdapter[]).includes(adapter) || !path.isAbsolute(base)) throw new Error('不支持的本机连接配置')
  const root = await realpath(path.join(base, adapter))
  const sourceFile = await realpath(path.join(root, 'sync-service.json'))
  if (!inside(base, root) || !inside(root, sourceFile)) throw new Error('连接配置超出本机服务目录')
  if ((await stat(sourceFile)).size > 256 * 1024) throw new Error('本机配置过大')
  const raw = JSON.parse(await readFile(sourceFile, 'utf8'))
  if (raw.adapterCode !== adapter || raw.serverUrl !== 'https://ailishishu.com/ailishishu-stats/api/agent-connector.php') throw new Error('连接配置来源不匹配')
  if (!/^agh_live_[A-Za-z0-9_-]{32,128}$/.test(String(raw.interactionKey || ''))) throw new Error('旧连接器没有有效本机授权，请重新授权')
  const executable = await realpath(String(raw.runtimeExecutable || ''))
  if (!(await stat(executable)).isFile()) throw new Error('智能体运行文件不存在')
  const stateFile = await realpath(String(raw.stateFile || ''))
  if (!inside(root, stateFile) || path.basename(stateFile) !== 'sync-state.json') throw new Error('旧同步状态不在本机服务目录')
  const projectRoots: string[] = []
  for (const project of Array.isArray(raw.projects) ? raw.projects : []) {
    if (project.enabled === false) continue
    const directory = await realpath(String(project.path || ''))
    if (directory === path.parse(directory).root || !(await stat(directory)).isDirectory()) throw new Error('旧连接器项目授权无效')
    if (!projectRoots.includes(directory)) projectRoots.push(directory)
  }
  if (!projectRoots.length || projectRoots.length > 60) throw new Error('请选择有效授权项目')
  const args = raw.runtimeExecutableArgs || []
  if (!Array.isArray(args) || args.length > 32 || args.some(arg => typeof arg !== 'string' || arg.length > 2000 || /[\r\n\0]/.test(arg) || /bypass|dangerously|skip-permissions|yolo/i.test(arg))) throw new Error('旧启动参数包含不支持的权限设置')
  return { adapter, sourceFile, stateFile, key: raw.interactionKey, executable, executableArgs: args, projectRoots,
    settings: { qclawStateDir: String(raw.qclawStateDir || ''), qclawConfigPath: String(raw.qclawConfigPath || ''), qclawAgentId: String(raw.qclawAgentId || 'main') } }
}
