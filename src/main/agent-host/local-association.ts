import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, realpath, lstat, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import type { AgentAdapter, AgentAssociation } from '../../shared/agent-host'

export interface AssociationLaunch { executable: string; args: string[]; runtimeHome?: string }
interface Request { adapter: AgentAdapter; requestId: string; expiresAt: number; acceptedHash?: string }
const commands: Record<AgentAdapter, string[]> = { codex: ['codex'], 'claude-code': ['claude'], qclaw: ['openclaw'], workbuddy: ['codebuddy'], codebuddy: ['codebuddy'], cursor: ['cursor-agent', 'agent'], trae: [], 'deepseek-harness': [] }
const packages: Partial<Record<AgentAdapter, string[]>> = { codex: ['@openai/codex'], 'claude-code': ['@anthropic-ai/claude-code'], qclaw: ['openclaw'] }
const homeVariables: Partial<Record<AgentAdapter, string>> = { codex: 'CODEX_HOME', 'claude-code': 'CLAUDE_CONFIG_DIR', qclaw: 'OPENCLAW_STATE_DIR' }
const contained = (root: string, target: string): boolean => { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
function localPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || !path.isAbsolute(value) || /^[\\/]{2}/.test(value) || /[\x00-\x1f]/.test(value) || value === path.parse(value).root) throw new Error('请填写本机绝对路径，不能使用网络共享、磁盘根目录或命令参数')
  return value
}
export async function validateAssociationLaunch(adapter: AgentAdapter, raw: Record<string, unknown>, nodePath: string): Promise<AssociationLaunch> {
  const runtimeHome = raw.runtimeHome ? await realpath(localPath(raw.runtimeHome)) : undefined
  if (runtimeHome && !(await stat(runtimeHome)).isDirectory()) throw new Error('智能体数据目录不存在')
  let executable = '', args: string[] = []
  if (raw.packageRoot) {
    if (raw.executablePath || raw.entryPoint) throw new Error('官方 npm 包目录与可执行文件路径只能填写一种')
    const root = await realpath(localPath(raw.packageRoot))
    const manifestPath = path.join(root, 'package.json')
    if ((await stat(manifestPath)).size > 256 * 1024) throw new Error('npm 包清单过大')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (!packages[adapter]?.includes(manifest.name)) throw new Error('该目录不是对应智能体的受支持官方 npm 包')
    const bin = typeof manifest.bin === 'string' ? manifest.bin : commands[adapter].map(command => manifest.bin?.[command]).find(Boolean)
    if (typeof bin !== 'string' || path.isAbsolute(bin)) throw new Error('官方 npm 包未提供可用入口')
    const entry = await realpath(path.resolve(root, bin))
    if (!contained(root, entry) || !(await stat(entry)).isFile()) throw new Error('npm 入口超出包目录')
    if (/\.(mjs|cjs|js)$/i.test(entry)) { executable = nodePath; args = [entry] }
    else if (/\.exe$/i.test(entry)) executable = entry
    else throw new Error('不支持该 npm 入口类型')
  } else {
    executable = await realpath(localPath(raw.executablePath))
    if (!(await stat(executable)).isFile()) throw new Error('CLI 文件不存在')
    const name = path.basename(executable).toLowerCase().replace(/\.exe$/, '')
    if (adapter === 'cursor' && raw.entryPoint) {
      const entry = await realpath(localPath(raw.entryPoint))
      if (name !== 'node' || path.basename(entry) !== 'index.js' || path.dirname(entry) !== path.dirname(executable) || !(await stat(entry)).isFile()) throw new Error('Cursor 需填写官方 Agent CLI 同一目录下的 node.exe 和 index.js')
      args = [entry]
    } else if (raw.entryPoint || !commands[adapter].includes(name)) throw new Error('请提供对应智能体的实际 CLI，不是 IDE 主程序、快捷方式或脚本')
    if (/\.(cmd|bat|ps1|sh|js|mjs|cjs)$/i.test(executable)) throw new Error('不执行命令脚本；npm 安装请填写 packageRoot')
  }
  return { executable, args, runtimeHome }
}
export function probeAssociationLaunch(launch: AssociationLaunch, adapter: AgentAdapter): Promise<void> {
  return new Promise((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    const homeKey = homeVariables[adapter]
    if (homeKey && launch.runtimeHome) environment[homeKey] = launch.runtimeHome
    execFile(launch.executable, [...launch.args, '--version'], { windowsHide: true, shell: false, timeout: 12000, maxBuffer: 16 * 1024, env: environment }, (error, stdout) => {
      if (error || !/\d+\.\d+/.test(stdout)) reject(new Error('CLI 未通过版本握手；请检查路径和依赖，然后修正配置。不会自动安装或登录'))
      else resolve()
    })
  })
}
export class LocalAssociations {
  private requests = new Map<AgentAdapter, Request>()
  private statuses = new Map<AgentAdapter, AgentAssociation>()
  private hashes = new Map<AgentAdapter, string>()
  private launches = new Map<AgentAdapter, AssociationLaunch>()
  private polling = false
  private saveQueue = Promise.resolve()
  constructor(private root: string, private nodePath: string, private launcherPath: string,
    private probe = probeAssociationLaunch) {}
  snapshot(): AgentAssociation[] { return [...this.statuses.values()].map(item => ({ ...item })) }
  launch(adapter: AgentAdapter): AssociationLaunch | undefined { return this.launches.get(adapter) }
  environment(selected?: AgentAdapter): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = {}
    for (const [adapter, launch] of this.launches) if ((!selected || selected === adapter) && homeVariables[adapter] && launch.runtimeHome) result[homeVariables[adapter]!] = launch.runtimeHome
    return result
  }
  private async directory(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('关联配置目录不能是链接')
  }
  private configPath(adapter: AgentAdapter): string { return path.join(this.root, adapter + '.json') }
  private async saveRequests(): Promise<void> {
    const operation = this.saveQueue.catch(() => {}).then(async () => {
      const target = path.join(this.root, 'requests.json'), temporary = target + '.' + randomUUID() + '.tmp'
      await writeFile(temporary, JSON.stringify([...this.requests.values()]), { flag: 'wx', mode: 0o600 })
      await rename(temporary, target)
    })
    this.saveQueue = operation
    await operation
  }
  async initialize(): Promise<void> {
    try {
      const file = path.join(this.root, 'requests.json')
      if ((await lstat(file)).isSymbolicLink() || (await stat(file)).size > 32 * 1024) return
      const values = JSON.parse(await readFile(file, 'utf8'))
      if (!Array.isArray(values)) return
      for (const value of values.slice(0, 8)) if (Object.hasOwn(commands, value?.adapter) && /^[a-f0-9-]{36}$/.test(value.requestId) && Number.isFinite(value.expiresAt)) {
        this.requests.set(value.adapter, value); this.statuses.set(value.adapter, this.describe(value))
      }
    } catch { /* A new computer has no association requests yet. */ }
  }
  private describe(request: Request): AgentAssociation {
    const configPath = this.configPath(request.adapter)
    const sample = { schemaVersion: 1, requestId: request.requestId, adapter: request.adapter, executablePath: '<实际 CLI 绝对路径>', runtimeHome: '<可选：原生数据目录；无则删除此字段>' }
    const prompt = `请将你所在电脑的 ${request.adapter} 接入深蓝启动器，仅登记本机运行路径并进行 --version 检查，不发送任务、不复制凭据、不授权任何项目。\n启动器程序：${this.launcherPath}\n启动器 Node：${this.nodePath}\n请写入：${configPath}\n有效期至：${new Date(request.expiresAt).toISOString()}\nJSON 格式：\n${JSON.stringify(sample, null, 2)}\n先确认当前用户实际安装路径和原生数据目录；不要填写示例占位符，不要将 IDE 主程序误当 CLI。npm 安装可删除 executablePath，改填 packageRoot（官方包目录，仅支持 Codex、Claude Code、OpenClaw）。Cursor Windows 官方 Agent CLI 可填同目录 node.exe 为 executablePath、index.js 为 entryPoint；不接受任意参数、脚本或环境变量。WorkBuddy 请填随应用安装的 CLI codebuddy，不是 WorkBuddy.exe。TRAE 当前暂不支持远程执行，不能假报成功。\n只写上述接入 JSON（推荐同目录临时文件写完再重命名），不要修改启动器其他文件、原生智能体配置或全局设置，不要下载或安装软件。找不到受支持的 CLI 时直接告知用户。不要写 API Key、Cookie、Token、登录信息和项目授权。\n启动器约每 15 秒校验变更；CLI 握手通过只代表接口可用，原生登录、网站绑定和执行就绪需在启动器中确认。连接智能体时只授权一次，之后自动同步该智能体全部原生项目及新增项目，无需逐项目授权。`
    return { adapter: request.adapter, requestId: request.requestId, status: commands[request.adapter].length ? 'waiting' : 'unsupported', message: commands[request.adapter].length ? '等待智能体写入接入配置（约 15 秒检查一次）' : request.adapter === 'trae' ? 'TRAE 暂不支持远程执行，不能通过路径登记解除限制' : '内置 DSH 不需要外部关联，请在首页启动 Harness', prompt, configPath, launcherPath: this.launcherPath }
  }
  async begin(adapter: AgentAdapter): Promise<void> {
    if (!Object.hasOwn(commands, adapter)) throw new Error('不支持的智能体')
    await this.directory()
    const request = { adapter, requestId: randomUUID(), expiresAt: Date.now() + 24 * 60 * 60 * 1000 }
    this.requests.set(adapter, request); this.hashes.delete(adapter)
    this.statuses.set(adapter, this.describe(request)); await this.saveRequests()
  }
  async check(retryInvalid = false): Promise<boolean> {
    if (this.polling) return false
    this.polling = true
    let changed = false
    try {
      for (const [adapter, request] of this.requests) {
        if (!commands[adapter].length) continue
        const status = this.statuses.get(adapter)!
        if (retryInvalid && status.status === 'invalid') this.hashes.delete(adapter)
        try {
          if ((await lstat(this.root)).isSymbolicLink()) throw new Error('关联配置目录不能是链接')
          const filename = this.configPath(adapter), metadata = await lstat(filename).catch(() => undefined)
          if (!metadata) continue
          if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 16 * 1024) throw new Error('接入配置必须是小于 16KB 的普通 JSON 文件')
          const content = await readFile(filename, 'utf8'), hash = createHash('sha256').update(content).digest('hex')
          if (this.hashes.get(adapter) === hash) continue
          if (request.expiresAt < Date.now() && request.acceptedHash !== hash) { status.status = 'expired'; status.message = '关联请求已过期，请重新生成提示词'; continue }
          this.hashes.set(adapter, hash)
          const raw = JSON.parse(content)
          if (!raw || Array.isArray(raw) || raw.schemaVersion !== 1 || raw.requestId !== request.requestId || raw.adapter !== adapter) throw new Error('请求编号或智能体不匹配，请复制最新提示词重新写入')
          if (Object.keys(raw).some(key => !['schemaVersion', 'requestId', 'adapter', 'executablePath', 'runtimeHome', 'packageRoot', 'entryPoint'].includes(key))) throw new Error('配置包含不支持的字段；不接受参数、凭据、环境变量或项目授权')
          status.status = 'checking'; status.message = '正在校验本机 CLI 接口'
          const launch = await validateAssociationLaunch(adapter, raw, this.nodePath)
          await this.probe(launch, adapter)
          // Do not accept a replaced file or a newly-issued request after a slow probe.
          if (this.requests.get(adapter)?.requestId !== request.requestId || createHash('sha256').update(await readFile(filename, 'utf8')).digest('hex') !== hash) { this.hashes.delete(adapter); continue }
          request.acceptedHash = hash
          await this.saveRequests()
          this.launches.set(adapter, launch)
          status.status = 'verified'; status.message = 'CLI 接口已验证；请确认原生登录，连接这个智能体后启动托管。尚不代表远程执行就绪'
          changed = true
        } catch (error) {
          status.status = 'invalid'
          status.message = error instanceof SyntaxError ? 'JSON 尚未写完整或格式错误；修正保存后将重新检查' : (error as NodeJS.ErrnoException).code ? '路径不可访问，请检查当前用户的安装位置和文件权限' : String((error as Error).message).slice(0, 240)
        }
        status.checkedAt = new Date().toISOString()
      }
    } finally { this.polling = false }
    return changed
  }
}
