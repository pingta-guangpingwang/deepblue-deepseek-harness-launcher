import { app } from 'electron'
import { createHash, verify } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { launcherDataPaths } from './config'
import { downloadTimeoutMs, mirrorCandidates } from './asset-mirrors'
import { fetchTrustedStoreKey } from './store-trust'
import type {
  ExternalSkinCatalogItem,
  ExternalSkinCatalogPayload,
  ExternalSkinSource,
  ExternalSkinState,
  SignedExternalSkinCatalogManifest,
  SignedSkinCatalogManifest,
  SkinAsset,
  SkinCatalogItem,
  SkinCatalogPayload,
  SkinStoreState
} from '../shared/types'

const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_VIDEO_BYTES = 80 * 1024 * 1024
const ALLOWED_MIME = new Set<SkinAsset['mime']>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm'
])

interface ActiveSkinConfig {
  schemaVersion: 1
  skinId: string
  mediaKind: SkinCatalogItem['mediaKind']
  mediaPath: string
  posterPath?: string
  presentation: SkinCatalogItem['presentation']
  /** Provenance record only; the wallpaper plugin does not read this field. */
  license: { name: string; url: string; author: string; sourceUrl: string; attribution?: string }
}

function publicKeyCandidates(): string[] {
  return [
    path.join(process.resourcesPath, 'resources', 'skin-catalog-public-key.pem'),
    path.join(app.getAppPath(), 'resources', 'skin-catalog-public-key.pem')
  ]
}

async function readPublicKey(): Promise<string | undefined> {
  for (const candidate of publicKeyCandidates()) {
    try {
      return await readFile(candidate, 'utf8')
    } catch {
      // Development source trees may not yet contain a production key.
    }
  }
  return undefined
}

export function verifySkinCatalog(manifest: SignedSkinCatalogManifest, publicKey: string): boolean {
  if (manifest.algorithm !== 'ed25519' || manifest.payload.schemaVersion !== 1 || manifest.payload.pageSize !== 20) return false
  try {
    return verify(null, Buffer.from(JSON.stringify(manifest.payload)), publicKey, Buffer.from(manifest.signature, 'base64'))
  } catch {
    return false
  }
}

export function verifyExternalSkinCatalog(manifest: SignedExternalSkinCatalogManifest, publicKey: string): boolean {
  if (manifest.algorithm !== 'ed25519' || manifest.payload.schemaVersion !== 1 || manifest.payload.pageSize !== 20) return false
  try {
    return verify(null, Buffer.from(JSON.stringify(manifest.payload)), publicKey, Buffer.from(manifest.signature, 'base64'))
  } catch {
    return false
  }
}

function assertAsset(asset: SkinAsset): void {
  const url = new URL(asset.url)
  if (url.protocol !== 'https:') throw new Error('皮肤资源必须使用 HTTPS')
  if (!/^[a-f0-9]{64}$/i.test(asset.sha256)) throw new Error('皮肤资源 SHA-256 无效')
  if (!ALLOWED_MIME.has(asset.mime)) throw new Error(`不支持的皮肤资源类型：${asset.mime}`)
  const limit = asset.mime.startsWith('video/') ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > limit) throw new Error('皮肤资源大小超出安全限制')
}

function assertCatalog(payload: SkinCatalogPayload): void {
  if (payload.schemaVersion !== 1 || payload.pageSize !== 20 || !Array.isArray(payload.items)) throw new Error('皮肤目录版本不兼容')
  const ids = new Set<string>()
  for (const item of payload.items) {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(item.id) || ids.has(item.id)) throw new Error(`皮肤 ID 无效或重复：${item.id}`)
    ids.add(item.id)
    if (item.contentRating !== 'everyone') throw new Error(`皮肤 ${item.id} 的内容分级不受支持`)
    assertAsset(item.thumbnail)
    assertAsset(item.media)
    if (item.poster) assertAsset(item.poster)
    if (item.mediaKind === 'video' && !item.media.mime.startsWith('video/')) throw new Error(`皮肤 ${item.id} 的媒体类型不匹配`)
    if (item.mediaKind !== 'video' && !item.media.mime.startsWith('image/')) throw new Error(`皮肤 ${item.id} 的媒体类型不匹配`)
    assertPresentation(item.id, item.presentation)
  }
}

function assertPresentation(id: string, presentation: SkinCatalogItem['presentation']): void {
  if (presentation.blurPx < 0 || presentation.blurPx > 24) throw new Error(`皮肤 ${id} 的模糊参数无效`)
  if (presentation.surfaceOpacity < 0.2 || presentation.surfaceOpacity > 0.98) throw new Error(`皮肤 ${id} 的界面透明度无效`)
  const position = presentation.position.match(/^(\d{1,3})% (\d{1,3})%$/)
  if (!position || Number(position[1]) > 100 || Number(position[2]) > 100) throw new Error(`皮肤 ${id} 的焦点参数无效`)
  const overlay = presentation.overlay.match(/^rgba\((\d{1,3}), (\d{1,3}), (\d{1,3}), (0|1|0?\.\d+)\)$/)
  if (!overlay || overlay.slice(1, 4).some(value => Number(value) > 255) || Number(overlay[4]) > 1) {
    throw new Error(`皮肤 ${id} 的遮罩参数无效`)
  }
}

const EXTERNAL_LICENSE_STATUS = new Set<ExternalSkinSource['licenseStatus']>(['redistributable', 'copyleft', 'undeclared'])
const EXTERNAL_PREVIEW_HOSTS = new Set(['cdn.statically.io', 'cdn.jsdelivr.net', 'raw.githubusercontent.com'])

/**
 * External assets must still be served by the upstream repository. Rejecting
 * any other host is what keeps this catalog a list of links rather than a
 * redistribution channel.
 */
function assertUpstreamAsset(id: string, repo: string, asset: SkinAsset): void {
  assertAsset(asset)
  const url = new URL(asset.url)
  if (url.hostname !== 'raw.githubusercontent.com') throw new Error(`外部皮肤 ${id} 的媒体必须由上游仓库提供`)
  if (!url.pathname.startsWith(`/${repo}/`)) throw new Error(`外部皮肤 ${id} 的媒体不属于声明的上游仓库`)
}

function assertExternalCatalog(payload: ExternalSkinCatalogPayload): void {
  if (payload.schemaVersion !== 1 || payload.pageSize !== 20 || !Array.isArray(payload.items) || !Array.isArray(payload.sources)) {
    throw new Error('外部皮肤目录版本不兼容')
  }
  const repos = new Set<string>()
  for (const source of payload.sources) {
    if (!/^[\w.-]{1,39}\/[\w.-]{1,100}$/.test(source.repo) || repos.has(source.repo)) throw new Error(`外部来源无效或重复：${source.repo}`)
    const repoUrl = new URL(source.repoUrl)
    if (repoUrl.protocol !== 'https:' || repoUrl.hostname !== 'github.com') throw new Error(`外部来源地址无效：${source.repo}`)
    if (!EXTERNAL_LICENSE_STATUS.has(source.licenseStatus)) throw new Error(`外部来源许可证状态无效：${source.repo}`)
    repos.add(source.repo)
  }
  const ids = new Set<string>()
  for (const item of payload.items) {
    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(item.id) || ids.has(item.id)) throw new Error(`外部皮肤 ID 无效或重复：${item.id}`)
    ids.add(item.id)
    if (item.contentRating !== 'everyone') throw new Error(`外部皮肤 ${item.id} 的内容分级不受支持`)
    if (!repos.has(item.origin.repo)) throw new Error(`外部皮肤 ${item.id} 的来源未在来源列表中声明`)
    if (!EXTERNAL_LICENSE_STATUS.has(item.origin.licenseStatus)) throw new Error(`外部皮肤 ${item.id} 的许可证状态无效`)
    if (!item.origin.notice.trim()) throw new Error(`外部皮肤 ${item.id} 缺少权利说明`)
    const preview = new URL(item.thumbnailUrl)
    if (preview.protocol !== 'https:' || !EXTERNAL_PREVIEW_HOSTS.has(preview.hostname)) throw new Error(`外部皮肤 ${item.id} 的预览地址不受支持`)
    assertUpstreamAsset(item.id, item.origin.repo, item.media)
    if (item.poster) assertUpstreamAsset(item.id, item.origin.repo, item.poster)
    if (item.mediaKind === 'video' && !item.media.mime.startsWith('video/')) throw new Error(`外部皮肤 ${item.id} 的媒体类型不匹配`)
    if (item.mediaKind !== 'video' && !item.media.mime.startsWith('image/')) throw new Error(`外部皮肤 ${item.id} 的媒体类型不匹配`)
    assertPresentation(item.id, item.presentation)
  }
}

function extensionFor(asset: SkinAsset): string {
  return ({
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/webm': '.webm'
  } satisfies Record<SkinAsset['mime'], string>)[asset.mime]
}

function cachePath(asset: SkinAsset): string {
  return path.join(launcherDataPaths().skins, 'cache', `${asset.sha256.toLowerCase()}${extensionFor(asset)}`)
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function verifyCachedAsset(target: string, asset: SkinAsset): Promise<boolean> {
  try {
    const info = await stat(target)
    if (info.size !== asset.size) return false
    const hash = createHash('sha256')
    await pipeline(createReadStream(target), hash)
    return hash.digest('hex') === asset.sha256.toLowerCase()
  } catch {
    return false
  }
}

/** Rejects an over-long stream even when the channel omits Content-Length. */
function cappedStream(source: Readable, limit: number): AsyncGenerator<Buffer> {
  return (async function* () {
    let seen = 0
    for await (const chunk of source) {
      seen += (chunk as Buffer).length
      if (seen > limit) throw new Error('远程皮肤资源超过清单声明大小')
      yield chunk as Buffer
    }
  })()
}

async function fetchAssetFrom(asset: SkinAsset, url: string, temporary: string): Promise<void> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(downloadTimeoutMs(asset.size)),
    headers: { 'User-Agent': 'DeepSeek-Harness-Launcher' }
  })
  if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > asset.size || contentLength > (asset.mime.startsWith('video/') ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES)) {
    throw new Error('远程皮肤资源超过清单声明大小')
  }
  const responseType = response.headers.get('content-type')?.split(';', 1)[0]
  if (responseType && responseType !== 'application/octet-stream' && responseType !== asset.mime) throw new Error('资源类型与清单不一致')
  await unlink(temporary).catch(() => undefined)
  try {
    await pipeline(cappedStream(Readable.fromWeb(response.body as never), asset.size), createWriteStream(temporary, { flags: 'wx' }))
    if (!(await verifyCachedAsset(temporary, asset))) throw new Error('完整性校验失败')
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function downloadAsset(asset: SkinAsset): Promise<string> {
  assertAsset(asset)
  const target = cachePath(asset)
  if (await verifyCachedAsset(target, asset)) return target
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.part`
  const candidates = mirrorCandidates(asset.url, asset.size)
  if (!candidates.length) throw new Error('皮肤资源地址不可用')
  let lastFailure = '未知错误'
  for (const candidate of candidates) {
    try {
      await fetchAssetFrom(asset, candidate.url, temporary)
      await rename(temporary, target)
      return target
    } catch (error) {
      lastFailure = `${candidate.id}：${error instanceof Error ? error.message : String(error)}`
    }
  }
  throw new Error(`下载皮肤失败，已尝试 ${candidates.length} 个渠道，最后一次 ${lastFailure}`)
}

async function readBundledCatalog(): Promise<SkinCatalogPayload | undefined> {
  const candidates = [
    path.join(process.resourcesPath, 'skin-store', 'catalog.payload.json'),
    path.join(app.getAppPath(), 'skin-store', 'catalog.payload.json'),
    path.resolve('skin-store', 'catalog.payload.json')
  ]
  for (const candidate of candidates) {
    try {
      const payload = JSON.parse(await readFile(candidate, 'utf8')) as SkinCatalogPayload
      assertCatalog(payload)
      return payload
    } catch {
      // Try the next development fallback.
    }
  }
  return undefined
}

function disabledExternalState(message?: string): ExternalSkinState {
  return { status: 'disabled', generatedAt: '', sources: [], items: [], ...(message ? { message } : {}) }
}

export class SkinStore {
  private payload: SkinCatalogPayload = { schemaVersion: 1, generatedAt: '', pageSize: 20, items: [] }
  private source: SkinStoreState['source'] = 'bundled'
  private message: string | undefined
  private external: ExternalSkinState = disabledExternalState()

  /**
   * Loads the vetted external source catalog. Failure never affects the
   * first-party store, and the feature stays off until the user opts in.
   */
  async refreshExternal(url: string, enabled: boolean): Promise<ExternalSkinState> {
    if (!enabled) {
      this.external = disabledExternalState()
      return this.external
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { 'User-Agent': 'DeepSeek-Harness-Launcher' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const manifest = await response.json() as SignedExternalSkinCatalogManifest
      const remoteKey = await fetchTrustedStoreKey('skin', url, manifest.keyId).catch(() => undefined)
      const bundledKey = await readPublicKey()
      if (![remoteKey, bundledKey].some(key => key && verifyExternalSkinCatalog(manifest, key))) throw new Error('签名校验失败')
      assertExternalCatalog(manifest.payload)
      this.external = {
        status: 'ready',
        generatedAt: manifest.payload.generatedAt,
        sources: manifest.payload.sources,
        items: manifest.payload.items
      }
    } catch (error) {
      this.external = {
        status: 'error',
        generatedAt: '',
        sources: [],
        items: [],
        message: `外部来源目录不可用：${error instanceof Error ? error.message : String(error)}`
      }
    }
    return this.external
  }

  async refresh(url: string): Promise<SkinStoreState> {
    this.message = undefined
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { 'User-Agent': 'DeepSeek-Harness-Launcher' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const manifest = await response.json() as SignedSkinCatalogManifest
      const remoteKey = await fetchTrustedStoreKey('skin', url, manifest.keyId).catch(() => undefined)
      const bundledKey = await readPublicKey()
      if (![remoteKey, bundledKey].some(key => key && verifySkinCatalog(manifest, key))) throw new Error('签名校验失败')
      assertCatalog(manifest.payload)
      this.payload = manifest.payload
      this.source = 'remote'
      return this.snapshot('ready')
    } catch (error) {
      this.message = `在线目录不可用，已使用内置目录：${error instanceof Error ? error.message : String(error)}`
    }
    const bundled = await readBundledCatalog()
    if (bundled) this.payload = bundled
    this.source = 'bundled'
    return this.snapshot(this.payload.items.length ? 'offline' : 'error')
  }

  async apply(skinId: string): Promise<SkinStoreState> {
    const item = this.payload.items.find(entry => entry.id === skinId)
    const externalItem = item ? undefined : this.external.items.find(entry => entry.id === skinId)
    if (!item && !externalItem) throw new Error('所选皮肤不在当前签名目录中')
    const chosen: { mediaKind: SkinCatalogItem['mediaKind']; media: SkinAsset; poster?: SkinAsset; presentation: SkinCatalogItem['presentation']; license: ActiveSkinConfig['license'] } = item
      ? { mediaKind: item.mediaKind, media: item.media, poster: item.poster, presentation: item.presentation, license: item.license }
      : {
        mediaKind: externalItem!.mediaKind,
        media: externalItem!.media,
        poster: externalItem!.poster,
        presentation: externalItem!.presentation,
        license: {
          name: externalItem!.origin.licenseName,
          url: externalItem!.origin.repoUrl,
          author: externalItem!.origin.author,
          sourceUrl: externalItem!.origin.repoUrl,
          attribution: externalItem!.origin.notice
        }
      }
    const mediaPath = await downloadAsset(chosen.media)
    const posterPath = chosen.poster ? await downloadAsset(chosen.poster) : undefined
    const config: ActiveSkinConfig = {
      schemaVersion: 1,
      skinId,
      mediaKind: chosen.mediaKind,
      mediaPath,
      ...(posterPath ? { posterPath } : {}),
      presentation: chosen.presentation,
      license: chosen.license
    }
    const target = launcherDataPaths().skinConfig
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(`${target}.next`, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    await rename(`${target}.next`, target)
    return this.snapshot('ready')
  }

  async clear(): Promise<SkinStoreState> {
    await unlink(launcherDataPaths().skinConfig).catch(() => undefined)
    return this.snapshot('ready')
  }

  async snapshot(status: SkinStoreState['status'] = 'ready'): Promise<SkinStoreState> {
    let activeSkinId: string | undefined
    try {
      activeSkinId = (JSON.parse(await readFile(launcherDataPaths().skinConfig, 'utf8')) as ActiveSkinConfig).skinId
    } catch {
      // No active skin is the normal initial state.
    }
    const downloadedSkinIds: string[] = []
    for (const item of [...this.payload.items, ...this.external.items]) {
      if (await exists(cachePath(item.media))) downloadedSkinIds.push(item.id)
    }
    return {
      status,
      source: this.source,
      generatedAt: this.payload.generatedAt,
      ...(activeSkinId ? { activeSkinId } : {}),
      downloadedSkinIds,
      items: structuredClone(this.payload.items),
      external: structuredClone(this.external),
      ...(this.message ? { message: this.message } : {})
    }
  }
}
