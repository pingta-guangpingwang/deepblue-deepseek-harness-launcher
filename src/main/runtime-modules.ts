import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import path from 'node:path'
import { spawn } from 'node:child_process'
import * as tar from 'tar'
import type { RuntimeModuleArtifact, RuntimeModuleId, RuntimeModuleRelease } from '../shared/types'

const MODULE_STATE_SCHEMA_VERSION = 1
const MAX_ARCHIVE_BYTES = 2_000_000_000
const MAX_REDIRECTS = 5
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1_000
const DOWNLOAD_STALL_TIMEOUT_MS = 15_000
const SAFE_ENTRY_PATH = /^(?![A-Za-z]:)(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[0-9A-Za-z@+._/-]+$/
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/
const MODULE_IDS = new Set<RuntimeModuleId>(['node-runtime', 'harness-core', 'package-manager', 'terminal-native', 'launcher-ui'])

interface RuntimeModuleState {
  schemaVersion: 1
  active: Partial<Record<RuntimeModuleId, string>>
  previous: Partial<Record<RuntimeModuleId, string>>
  installed: Partial<Record<RuntimeModuleId, string[]>>
}

interface RuntimeModuleReceipt {
  schemaVersion: 1
  id: RuntimeModuleId
  version: string
  artifactSha256: string
  installedAt: string
}

export interface RuntimeModuleInstallProgress {
  moduleId: RuntimeModuleId
  phase: 'source-check' | 'source-ready' | 'source-fallback' | 'download' | 'verify' | 'extract' | 'probe' | 'activate'
  receivedBytes: number
  totalBytes: number
  mirrorId?: string
  latencyMs?: number
  message?: string
}

export interface RuntimeModuleInstallResult {
  moduleId: RuntimeModuleId
  version: string
  root: string
  reused: boolean
  mirrorId?: string
}

function emptyState(): RuntimeModuleState {
  return { schemaVersion: MODULE_STATE_SCHEMA_VERSION, active: {}, previous: {}, installed: {} }
}

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function sha256File(target: string): Promise<string> {
  const digest = createHash('sha256')
  const stream = createReadStream(target)
  stream.on('data', (chunk) => digest.update(chunk))
  await once(stream, 'end')
  return digest.digest('hex')
}

function moduleDirectory(root: string, id: RuntimeModuleId, version: string): string {
  return path.join(root, 'modules', id, version)
}

function artifactFile(root: string, module: RuntimeModuleRelease, artifact: RuntimeModuleArtifact): string {
  return path.join(root, 'downloads', `${module.id}-${module.version}-${artifact.sha256}.tar.gz`)
}

async function readState(target: string): Promise<RuntimeModuleState> {
  try {
    const parsed = JSON.parse(await readFile(target, 'utf8')) as Partial<RuntimeModuleState>
    if (parsed.schemaVersion !== MODULE_STATE_SCHEMA_VERSION) return emptyState()
    const clean = emptyState()
    for (const id of MODULE_IDS) {
      const active = parsed.active?.[id]
      const previous = parsed.previous?.[id]
      const installed = parsed.installed?.[id]
      if (typeof active === 'string' && SAFE_VERSION.test(active)) clean.active[id] = active
      if (typeof previous === 'string' && SAFE_VERSION.test(previous)) clean.previous[id] = previous
      if (Array.isArray(installed)) clean.installed[id] = installed.filter((version): version is string => typeof version === 'string' && SAFE_VERSION.test(version)).slice(0, 20)
    }
    return {
      schemaVersion: MODULE_STATE_SCHEMA_VERSION,
      active: clean.active,
      previous: clean.previous,
      installed: clean.installed
    }
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return emptyState()
    throw error
  }
}

async function writeState(target: string, state: RuntimeModuleState): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.next`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, target)
}

async function validReceipt(root: string, module: RuntimeModuleRelease, artifact: RuntimeModuleArtifact): Promise<boolean> {
  try {
    const receipt = JSON.parse(await readFile(path.join(root, 'module-receipt.json'), 'utf8')) as RuntimeModuleReceipt
    return receipt.schemaVersion === 1 && receipt.id === module.id && receipt.version === module.version && receipt.artifactSha256 === artifact.sha256
  } catch {
    return false
  }
}

function redirectHostAllowed(mirrorId: RuntimeModuleArtifact['mirrors'][number]['id'], hostname: string): boolean {
  if (mirrorId === 'github') return ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'].includes(hostname)
  if (mirrorId === 'gitee') return hostname === 'gitee.com' || hostname.endsWith('.gitee.com')
  return hostname === 'ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com'
}

async function responseFollowingRedirects(
  url: string,
  mirrorId: RuntimeModuleArtifact['mirrors'][number]['id'],
  offset: number,
  signal: AbortSignal,
  method: 'GET' | 'HEAD' = 'GET'
): Promise<Response> {
  let current = url
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(current, {
      method,
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': 'DeepBlue-DeepSeek-Harness-Launcher',
        ...(offset > 0 ? { Range: `bytes=${offset}-` } : {})
      }
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    if (!location) return response
    const next = new URL(location, current)
    if (next.protocol !== 'https:' || next.username || next.password || !redirectHostAllowed(mirrorId, next.hostname)) {
      throw new Error('模块镜像返回了不安全的重定向')
    }
    current = next.href
  }
  throw new Error('模块镜像重定向次数过多')
}

async function probeMirror(
  module: RuntimeModuleRelease,
  artifact: RuntimeModuleArtifact,
  mirror: RuntimeModuleArtifact['mirrors'][number],
  onProgress?: (progress: RuntimeModuleInstallProgress) => void
): Promise<boolean> {
  onProgress?.({
    moduleId: module.id,
    phase: 'source-check',
    receivedBytes: 0,
    totalBytes: artifact.size,
    mirrorId: mirror.id,
    message: `正在检测 ${mirror.id}`
  })
  const startedAt = Date.now()
  try {
    const response = await responseFollowingRedirects(mirror.url, mirror.id, 0, AbortSignal.timeout(5_000), 'HEAD')
    const latencyMs = Date.now() - startedAt
    const available = response.ok
    const message = available ? `${mirror.id} 可用（${latencyMs}ms）` : `${mirror.id} 返回 HTTP ${response.status}`
    onProgress?.({
      moduleId: module.id,
      phase: available ? 'source-ready' : 'source-fallback',
      receivedBytes: 0,
      totalBytes: artifact.size,
      mirrorId: mirror.id,
      latencyMs,
      message
    })
    return available
  } catch (error) {
    const message = `${mirror.id} 不可用：${error instanceof Error ? error.message : String(error)}`
    onProgress?.({
      moduleId: module.id,
      phase: 'source-fallback',
      receivedBytes: 0,
      totalBytes: artifact.size,
      mirrorId: mirror.id,
      message
    })
    return false
  }
}

/** Rejects one stalled body read so the caller can cancel this source and try the next mirror. */
export async function readRuntimeDownloadChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = DOWNLOAD_STALL_TIMEOUT_MS
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const stalled = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`持续 ${Math.ceil(timeoutMs / 1_000)} 秒无下载进度`)), timeoutMs)
  })
  try {
    return await Promise.race([reader.read(), stalled])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function downloadArtifact(
  root: string,
  module: RuntimeModuleRelease,
  artifact: RuntimeModuleArtifact,
  onProgress?: (progress: RuntimeModuleInstallProgress) => void
): Promise<{ file: string; mirrorId?: string }> {
  await mkdir(path.join(root, 'downloads'), { recursive: true })
  const finalFile = artifactFile(root, module, artifact)
  if (await exists(finalFile)) {
    const info = await stat(finalFile)
    if (info.size === artifact.size && await sha256File(finalFile) === artifact.sha256) return { file: finalFile }
    await rm(finalFile, { force: true })
  }
  const partialFile = `${finalFile}.part`
  let lastFailure = '没有可用的模块镜像'
  for (const mirror of artifact.mirrors) {
    if (!await probeMirror(module, artifact, mirror, onProgress)) continue
    try {
      let offset = 0
      try {
        offset = (await stat(partialFile)).size
        if (offset > artifact.size) {
          await rm(partialFile, { force: true })
          offset = 0
        }
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      const response = await responseFollowingRedirects(mirror.url, mirror.id, offset, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS))
      if (offset > 0 && response.status === 200) {
        await rm(partialFile, { force: true })
        offset = 0
      } else if (offset > 0 && response.status !== 206) {
        throw new Error(`断点续传返回 HTTP ${response.status}`)
      } else if (offset === 0 && response.status !== 200) {
        throw new Error(`下载返回 HTTP ${response.status}`)
      }
      if (!response.body) throw new Error('下载响应没有内容')
      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > artifact.size - offset) throw new Error('下载响应超过签名清单大小')
      const output = createWriteStream(partialFile, { flags: offset > 0 ? 'a' : 'w', mode: 0o600 })
      const outputClosed = new Promise<void>((resolve, reject) => {
        output.once('close', resolve)
        output.once('error', reject)
      })
      let received = offset
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await readRuntimeDownloadChunk(reader)
          if (done) break
          received += value.byteLength
          if (received > artifact.size || received > MAX_ARCHIVE_BYTES) throw new Error('下载内容超过签名清单大小')
          if (!output.write(value)) await once(output, 'drain')
          onProgress?.({ moduleId: module.id, phase: 'download', receivedBytes: received, totalBytes: artifact.size, mirrorId: mirror.id })
        }
      } catch (error) {
        await reader.cancel(error instanceof Error ? error.message : String(error)).catch(() => undefined)
        throw error
      } finally {
        output.end()
        await outputClosed
      }
      if (received !== artifact.size) throw new Error(`下载大小不匹配：${received}/${artifact.size}`)
      onProgress?.({ moduleId: module.id, phase: 'verify', receivedBytes: received, totalBytes: artifact.size, mirrorId: mirror.id })
      if (await sha256File(partialFile) !== artifact.sha256) {
        await rm(partialFile, { force: true })
        throw new Error('SHA-256 校验失败')
      }
      await rename(partialFile, finalFile)
      return { file: finalFile, mirrorId: mirror.id }
    } catch (error) {
      lastFailure = `${mirror.id}: ${error instanceof Error ? error.message : String(error)}`
      onProgress?.({
        moduleId: module.id,
        phase: 'source-fallback',
        receivedBytes: 0,
        totalBytes: artifact.size,
        mirrorId: mirror.id,
        message: `${lastFailure}，自动尝试下一渠道`
      })
    }
  }
  throw new Error(lastFailure)
}

async function extractArtifact(archive: string, destination: string, unpackedLimit: number): Promise<void> {
  let unpackedBytes = 0
  let rejection: Error | undefined
  await mkdir(destination, { recursive: true })
  await tar.x({
    cwd: destination,
    file: archive,
    gzip: true,
    preservePaths: false,
    strict: true,
    filter: (entryPath, entry) => {
      // Throwing from tar's synchronous filter is emitted as an uncaught stream
      // error by some tar versions. Reject the entry, finish the stream cleanly,
      // and surface the recorded error after extraction instead.
      if (rejection) return false
      if (!SAFE_ENTRY_PATH.test(entryPath)) {
        rejection = new Error(`模块包包含不安全路径：${entryPath}`)
        return false
      }
      if (!('type' in entry) || !['File', 'Directory'].includes(entry.type)) return false
      unpackedBytes += Number(entry.size) || 0
      if (unpackedBytes > unpackedLimit) {
        rejection = new Error('模块解压大小超过签名清单限制')
        return false
      }
      return true
    }
  })
  if (rejection) throw rejection
}

async function runProbe(module: RuntimeModuleRelease, root: string): Promise<void> {
  if (!module.probe) return
  const executable = path.resolve(root, module.probe.path)
  const relative = path.relative(root, executable)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('模块探针越过安装目录')
  await access(executable)
  const child = spawn(executable, module.probe.args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const timeout = setTimeout(() => child.kill(), module.probe.timeoutMs)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  }).finally(() => clearTimeout(timeout))
  if (code !== 0 || !new RegExp(module.probe.expectedPattern, 'u').test(output.trim())) throw new Error(`模块探针失败：${module.id}`)
}

/** Installs immutable signed runtime modules and atomically advances only their active pointers. */
export class RuntimeModuleStore {
  private readonly stateFile: string

  constructor(private readonly root: string) {
    this.stateFile = path.join(root, 'modules', 'state.json')
  }

  async activeRoot(id: RuntimeModuleId): Promise<string | undefined> {
    const state = await readState(this.stateFile)
    const version = state.active[id]
    if (!version) return undefined
    const root = moduleDirectory(this.root, id, version)
    return await exists(root) ? root : undefined
  }

  async versions(id: RuntimeModuleId): Promise<{ active?: string; previous?: string; installed: string[] }> {
    const state = await readState(this.stateFile)
    return {
      active: state.active[id],
      previous: state.previous[id],
      installed: [...(state.installed[id] || [])]
    }
  }

  async install(
    target: RuntimeModuleRelease,
    catalog: RuntimeModuleRelease[],
    platform = process.platform,
    arch = process.arch,
    onProgress?: (progress: RuntimeModuleInstallProgress) => void,
    installing = new Set<RuntimeModuleId>()
  ): Promise<RuntimeModuleInstallResult> {
    if (installing.has(target.id)) throw new Error(`模块依赖循环：${target.id}`)
    installing.add(target.id)
    try {
      for (const dependencyId of target.dependencies) {
        const dependency = catalog.find((module) => module.id === dependencyId)
        if (!dependency) throw new Error(`模块缺少依赖：${dependencyId}`)
        await this.install(dependency, catalog, platform, arch, onProgress, installing)
      }
      const artifact = target.artifacts.find((candidate) => candidate.platform === platform && candidate.arch === arch)
      if (!artifact) throw new Error(`模块不支持当前系统：${target.id} ${platform}-${arch}`)
      const finalRoot = moduleDirectory(this.root, target.id, target.version)
      if (await exists(finalRoot)) {
        if (!await validReceipt(finalRoot, target, artifact)) throw new Error(`模块目录缺少可信安装凭据：${target.id} ${target.version}`)
        onProgress?.({ moduleId: target.id, phase: 'probe', receivedBytes: artifact.size, totalBytes: artifact.size })
        await runProbe(target, finalRoot)
        await this.activate(target.id, target.version)
        onProgress?.({ moduleId: target.id, phase: 'activate', receivedBytes: artifact.size, totalBytes: artifact.size })
        return { moduleId: target.id, version: target.version, root: finalRoot, reused: true }
      }
      const downloaded = await downloadArtifact(this.root, target, artifact, onProgress)
      const stagingRoot = path.join(this.root, 'modules', '.staging', `${target.id}-${target.version}-${randomUUID()}`)
      try {
        onProgress?.({ moduleId: target.id, phase: 'extract', receivedBytes: artifact.size, totalBytes: artifact.size, mirrorId: downloaded.mirrorId })
        await extractArtifact(downloaded.file, stagingRoot, artifact.unpackedSize)
        const receipt: RuntimeModuleReceipt = {
          schemaVersion: 1,
          id: target.id,
          version: target.version,
          artifactSha256: artifact.sha256,
          installedAt: new Date().toISOString()
        }
        await writeFile(path.join(stagingRoot, 'module-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
        onProgress?.({ moduleId: target.id, phase: 'probe', receivedBytes: artifact.size, totalBytes: artifact.size, mirrorId: downloaded.mirrorId })
        await runProbe(target, stagingRoot)
        await mkdir(path.dirname(finalRoot), { recursive: true })
        await rename(stagingRoot, finalRoot)
      } finally {
        await rm(stagingRoot, { recursive: true, force: true })
      }
      onProgress?.({ moduleId: target.id, phase: 'activate', receivedBytes: artifact.size, totalBytes: artifact.size, mirrorId: downloaded.mirrorId })
      await this.activate(target.id, target.version)
      return { moduleId: target.id, version: target.version, root: finalRoot, reused: false, mirrorId: downloaded.mirrorId }
    } finally {
      installing.delete(target.id)
    }
  }

  async rollback(id: RuntimeModuleId): Promise<string> {
    const state = await readState(this.stateFile)
    const previous = state.previous[id]
    if (!previous || !await exists(moduleDirectory(this.root, id, previous))) throw new Error(`模块没有可回滚版本：${id}`)
    const active = state.active[id]
    state.active[id] = previous
    if (active) state.previous[id] = active
    await writeState(this.stateFile, state)
    return moduleDirectory(this.root, id, previous)
  }

  private async activate(id: RuntimeModuleId, version: string): Promise<void> {
    const state = await readState(this.stateFile)
    const current = state.active[id]
    if (current && current !== version) state.previous[id] = current
    state.active[id] = version
    const installed = new Set(state.installed[id] || [])
    installed.add(version)
    state.installed[id] = [...installed].sort()
    await writeState(this.stateFile, state)
  }
}
