import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const INSTALLER_OSS_HOST = 'ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com'
const GITHUB_DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])

export interface LauncherInstallerArtifact {
  url: string
  sha256: string
  size: number
}

export interface LauncherInstallerDownloadProgress {
  receivedBytes: number
  totalBytes: number
}

export interface LauncherInstallerDownloadDependencies {
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  signal?: AbortSignal
}

function secureHttpsUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error('安装器地址必须使用可信 HTTPS 地址')
  return url
}

function installerUrl(artifact: LauncherInstallerArtifact): URL {
  if (!/^[a-f0-9]{64}$/i.test(artifact.sha256)) throw new Error('安装器缺少有效 SHA-256')
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > 2_000_000_000) throw new Error('安装器签名大小无效')
  const url = secureHttpsUrl(artifact.url)
  if (![INSTALLER_OSS_HOST, 'github.com'].includes(url.hostname)) throw new Error('安装器地址不在可信下载域名中')
  return url
}

async function installerResponse(url: URL, fetcher: NonNullable<LauncherInstallerDownloadDependencies['fetch']>, signal: AbortSignal): Promise<Response> {
  let current = url
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    signal.throwIfAborted()
    const response = await fetcher(current.href, {
      redirect: 'manual', signal, headers: { 'User-Agent': 'DeepBlue-DeepSeek-Harness-Launcher' }
    })
    if (!REDIRECT_CODES.has(response.status)) return response
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location) throw new Error('安装器重定向缺少目标地址')
    try {
      const next = secureHttpsUrl(new URL(location, current).href)
      const allowed = url.hostname === 'github.com' ? GITHUB_DOWNLOAD_HOSTS.has(next.hostname) : next.hostname === INSTALLER_OSS_HOST
      if (!allowed) throw new Error('untrusted host')
      current = next
    } catch {
      throw new Error('安装器返回了不安全的重定向')
    }
  }
  throw new Error('安装器重定向次数过多')
}

async function cachedInstallerValid(target: string, artifact: LauncherInstallerArtifact, signal: AbortSignal): Promise<boolean> {
  try {
    const entry = await lstat(target)
    if (!entry.isFile() || entry.size !== artifact.size) return false
    const hasher = createHash('sha256')
    let received = 0
    for await (const chunk of createReadStream(target, { signal })) {
      received += chunk.length
      if (received > artifact.size) return false
      hasher.update(chunk)
    }
    return received === artifact.size && hasher.digest('hex') === artifact.sha256.toLowerCase()
  } catch (error) {
    signal.throwIfAborted()
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Only the complete file named by its signed digest can be returned for installation. */
export async function downloadVerifiedLauncherInstaller(
  artifact: LauncherInstallerArtifact,
  cacheRoot: string,
  onProgress?: (progress: LauncherInstallerDownloadProgress) => void,
  dependencies: LauncherInstallerDownloadDependencies = {}
): Promise<{ path: string; reused: boolean }> {
  const url = installerUrl(artifact)
  const timeout = AbortSignal.timeout(30 * 60_000)
  const signal = dependencies.signal ? AbortSignal.any([dependencies.signal, timeout]) : timeout
  signal.throwIfAborted()
  await mkdir(cacheRoot, { recursive: true })
  const target = path.join(cacheRoot, `${artifact.sha256.toLowerCase()}.exe`)
  if (await cachedInstallerValid(target, artifact, signal)) {
    onProgress?.({ receivedBytes: artifact.size, totalBytes: artifact.size })
    return { path: target, reused: true }
  }
  await rm(target, { force: true })
  const temporary = `${target}.${randomUUID()}.download`
  try {
    const response = await installerResponse(url, dependencies.fetch || fetch, signal)
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error(`安装器下载返回 HTTP ${response.status}`)
    }
    const contentLength = response.headers.get('content-length')
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== artifact.size)) {
      await response.body.cancel()
      throw new Error('安装器下载大小与签名目录不符')
    }
    const hasher = createHash('sha256')
    let received = 0
    const verifyBytes = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        if (received > artifact.size) { callback(new Error('安装器下载大小超出签名目录')); return }
        hasher.update(chunk)
        try {
          onProgress?.({ receivedBytes: received, totalBytes: artifact.size })
          callback(null, chunk)
        } catch (error) { callback(error as Error) }
      }
    })
    await pipeline(
      Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
      verifyBytes,
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      { signal }
    )
    signal.throwIfAborted()
    if (received !== artifact.size) throw new Error('安装器下载大小与签名目录不符')
    if (hasher.digest('hex') !== artifact.sha256.toLowerCase()) throw new Error('安装器 SHA-256 完整性校验失败')
    await rename(temporary, target)
    return { path: target, reused: false }
  } finally {
    await rm(temporary, { force: true })
  }
}

export function installedLauncherRoot(executablePath: string): string | undefined {
  const versionRoot = path.dirname(path.resolve(executablePath))
  const shellsRoot = path.dirname(versionRoot)
  if (path.basename(shellsRoot).toLowerCase() !== 'shells') return undefined
  return path.dirname(shellsRoot)
}

export function silentLauncherUpdateArgs(installRoot: string, parentPid?: number): string[] {
  if (parentPid !== undefined && (!Number.isSafeInteger(parentPid) || parentPid < 1 || parentPid > 0xffffffff)) throw new Error('安装器等待 PID 无效')
  if (/["\r\n]/.test(installRoot)) throw new Error('安装目录路径包含不安全字符')
  // NSIS requires /D to be the final argument and does not accept quotes around it.
  return ['/S', '/AUTOSTART', ...(parentPid === undefined ? [] : ['--force-run', `/WAITPID=${parentPid}`]), `/D=${path.resolve(installRoot)}`]
}

export async function spawnLauncherInstaller(
  installerPath: string,
  installRoot: string,
  options: { parentPid?: number; spawn?: typeof spawn } = {}
): Promise<void> {
  if (/["\r\n]/.test(installerPath)) throw new Error('安装器路径包含不安全字符')
  const child = (options.spawn || spawn)(installerPath, silentLauncherUpdateArgs(installRoot, options.parentPid), {
    // Windows' default argument quoting makes NSIS ignore a spaced /D value.
    // Quote only argv0 so its own GetParameters parser still finds the options.
    detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, argv0: `"${installerPath}"`
  })
  // A process handle alone is insufficient: launch errors arrive asynchronously.
  await once(child, 'spawn')
  child.unref()
}
