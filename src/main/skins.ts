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
  SignedSkinCatalogManifest,
  SkinAsset,
  SkinCatalogItem,
  SkinCatalogPayload,
  SkinPreview,
  SkinStoreState
} from '../shared/types'

const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_VIDEO_BYTES = 80 * 1024 * 1024
const GITEE_SKIN_ASSET_PREFIXES = [
  'https://gitee.com/wanggp123/deepseek-harness-skins/raw/master/',
  'https://gitee.com/wanggp123/deepseek-harness-skins-video/raw/master/'
] as const
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

interface FavoriteSkinFile {
  schemaVersion: 1
  skinIds: string[]
}

export interface SkinDownloadProgress {
  status: 'downloading' | 'verifying' | 'completed'
  receivedBytes: number
  totalBytes: number
  message: string
}

type SkinDownloadReporter = (progress: SkinDownloadProgress) => void

export function isSkinResponseTypeCompatible(expected: SkinAsset['mime'], responseType?: string): boolean {
  if (!responseType || responseType === 'application/octet-stream' || responseType === expected) return true
  return ALLOWED_MIME.has(responseType as SkinAsset['mime']) && responseType.split('/', 1)[0] === expected.split('/', 1)[0]
}

export function nextFavoriteSkinIds(current: string[], skinId: string): string[] {
  const unique = [...new Set(current.filter(id => typeof id === 'string' && id.length <= 64))]
  return unique.includes(skinId) ? unique.filter(id => id !== skinId) : [skinId, ...unique]
}

async function readFavoriteSkinIds(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(launcherDataPaths().skinFavorites, 'utf8')) as Partial<FavoriteSkinFile>
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.skinIds)) return []
    return [...new Set(parsed.skinIds.filter(id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{1,63}$/.test(id)))].slice(0, 500)
  } catch {
    return []
  }
}

async function writeFavoriteSkinIds(skinIds: string[]): Promise<void> {
  const target = launcherDataPaths().skinFavorites
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(`${target}.next`, `${JSON.stringify({ schemaVersion: 1, skinIds } satisfies FavoriteSkinFile, null, 2)}\n`, 'utf8')
  await rename(`${target}.next`, target)
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

function assertAsset(asset: SkinAsset): void {
  const url = new URL(asset.url)
  if (url.protocol !== 'https:') throw new Error('皮肤资源必须使用 HTTPS')
  if (!GITEE_SKIN_ASSET_PREFIXES.some(prefix => asset.url.startsWith(prefix))) throw new Error('皮肤资源必须来自两个固定的 Gitee 皮肤仓库')
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
function cappedStream(source: Readable, limit: number, onChunk?: (receivedBytes: number) => void): AsyncGenerator<Buffer> {
  return (async function* () {
    let seen = 0
    for await (const chunk of source) {
      seen += (chunk as Buffer).length
      if (seen > limit) throw new Error('远程皮肤资源超过清单声明大小')
      onChunk?.(seen)
      yield chunk as Buffer
    }
  })()
}

async function fetchAssetFrom(asset: SkinAsset, url: string, temporary: string, sourceLabel: string, onProgress?: SkinDownloadReporter): Promise<void> {
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
  // Gitee may transcode a trusted raw JPG to WebP. The signed byte size and
  // SHA-256 check below remain authoritative, while cross-category responses
  // (for example HTML returned for a video) are still rejected.
  if (!isSkinResponseTypeCompatible(asset.mime, responseType)) throw new Error('资源类型与清单不一致')
  await unlink(temporary).catch(() => undefined)
  try {
    await pipeline(cappedStream(Readable.fromWeb(response.body as never), asset.size, (receivedBytes) => {
      onProgress?.({ status: 'downloading', receivedBytes, totalBytes: asset.size, message: `正在从 ${sourceLabel} 下载` })
    }), createWriteStream(temporary, { flags: 'wx' }))
    onProgress?.({ status: 'verifying', receivedBytes: asset.size, totalBytes: asset.size, message: '下载完成，正在校验完整性' })
    if (!(await verifyCachedAsset(temporary, asset))) throw new Error('完整性校验失败')
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function downloadAsset(asset: SkinAsset, onProgress?: SkinDownloadReporter): Promise<string> {
  assertAsset(asset)
  const target = cachePath(asset)
  onProgress?.({ status: 'verifying', receivedBytes: 0, totalBytes: asset.size, message: '正在检查本地缓存' })
  if (await verifyCachedAsset(target, asset)) {
    onProgress?.({ status: 'completed', receivedBytes: asset.size, totalBytes: asset.size, message: '本地高清资源已就绪' })
    return target
  }
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.part`
  const candidates = mirrorCandidates(asset.url, asset.size)
  if (!candidates.length) throw new Error('皮肤资源地址不可用')
  let lastFailure = '未知错误'
  for (const candidate of candidates) {
    try {
      onProgress?.({ status: 'downloading', receivedBytes: 0, totalBytes: asset.size, message: `正在连接 ${candidate.id.toUpperCase()}` })
      await fetchAssetFrom(asset, candidate.url, temporary, candidate.id.toUpperCase(), onProgress)
      await unlink(target).catch(() => undefined)
      await rename(temporary, target)
      onProgress?.({ status: 'completed', receivedBytes: asset.size, totalBytes: asset.size, message: '高清资源下载完成' })
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

export class SkinStore {
  private payload: SkinCatalogPayload = { schemaVersion: 1, generatedAt: '', pageSize: 20, items: [] }
  private source: SkinStoreState['source'] = 'bundled'
  private message: string | undefined
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

  private item(skinId: string): SkinCatalogItem {
    const item = this.payload.items.find(entry => entry.id === skinId)
    if (!item) throw new Error('所选皮肤不在当前 Gitee 签名目录中')
    return item
  }

  private async downloadItem(item: SkinCatalogItem, onProgress?: SkinDownloadReporter): Promise<{ mediaPath: string; posterPath?: string }> {
    const assets = [item.media, ...(item.poster ? [item.poster] : [])]
    const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0)
    let completedBytes = 0
    const paths: string[] = []
    for (const asset of assets) {
      const localPath = await downloadAsset(asset, (progress) => {
        onProgress?.({
          ...progress,
          receivedBytes: Math.min(totalBytes, completedBytes + progress.receivedBytes),
          totalBytes
        })
      })
      paths.push(localPath)
      completedBytes += asset.size
    }
    onProgress?.({ status: 'completed', receivedBytes: totalBytes, totalBytes, message: '高清资源已下载到本机' })
    return { mediaPath: paths[0]!, ...(paths[1] ? { posterPath: paths[1] } : {}) }
  }

  async download(skinId: string, onProgress?: SkinDownloadReporter): Promise<SkinStoreState> {
    await this.downloadItem(this.item(skinId), onProgress)
    return this.snapshot('ready')
  }

  async preview(skinId: string, onProgress?: SkinDownloadReporter): Promise<{ state: SkinStoreState; preview: SkinPreview }> {
    const item = this.item(skinId)
    const downloaded = await this.downloadItem(item, onProgress)
    return {
      state: await this.snapshot('ready'),
      preview: {
        skinId,
        name: item.name,
        mediaKind: item.mediaKind,
        mediaUrl: `deepblue-skin://cache/${path.basename(downloaded.mediaPath)}`,
        ...(downloaded.posterPath ? { posterUrl: `deepblue-skin://cache/${path.basename(downloaded.posterPath)}` } : {}),
        mime: item.media.mime
      }
    }
  }

  async apply(skinId: string, onProgress?: SkinDownloadReporter): Promise<SkinStoreState> {
    const item = this.item(skinId)
    const chosen: { mediaKind: SkinCatalogItem['mediaKind']; media: SkinAsset; poster?: SkinAsset; presentation: SkinCatalogItem['presentation']; license: ActiveSkinConfig['license'] } = {
      mediaKind: item.mediaKind,
      media: item.media,
      poster: item.poster,
      presentation: item.presentation,
      license: item.license
    }
    const { mediaPath, posterPath } = await this.downloadItem(item, onProgress)
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

  async toggleFavorite(skinId: string): Promise<SkinStoreState> {
    if (!this.payload.items.some(item => item.id === skinId)) throw new Error('所选皮肤不在当前 Gitee 签名目录中')
    await writeFavoriteSkinIds(nextFavoriteSkinIds(await readFavoriteSkinIds(), skinId))
    return this.snapshot('ready')
  }

  async desktopAsset(skinId: string, onProgress?: SkinDownloadReporter): Promise<{ state: SkinStoreState; mediaKind: SkinCatalogItem['mediaKind']; mediaPath: string; posterPath?: string }> {
    const item = this.item(skinId)
    const downloaded = await this.downloadItem(item, onProgress)
    return {
      state: await this.snapshot('ready'),
      mediaKind: item.mediaKind,
      mediaPath: downloaded.mediaPath,
      ...(downloaded.posterPath ? { posterPath: downloaded.posterPath } : {})
    }
  }

  async remove(skinId: string): Promise<SkinStoreState> {
    const item = this.item(skinId)
    let activeSkinId: string | undefined
    try {
      activeSkinId = (JSON.parse(await readFile(launcherDataPaths().skinConfig, 'utf8')) as ActiveSkinConfig).skinId
    } catch {
      // No active skin needs to be reset.
    }
    if (activeSkinId === skinId) await unlink(launcherDataPaths().skinConfig).catch(() => undefined)
    const targets = [...new Set([item.media, ...(item.poster ? [item.poster] : [])].map(cachePath))]
    await Promise.all(targets.flatMap(target => [unlink(target).catch(() => undefined), unlink(`${target}.part`).catch(() => undefined)]))
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
    for (const item of this.payload.items) {
      const mediaReady = await exists(cachePath(item.media))
      const posterReady = !item.poster || await exists(cachePath(item.poster))
      if (mediaReady && posterReady) downloadedSkinIds.push(item.id)
    }
    const itemIds = new Set(this.payload.items.map(item => item.id))
    const favoriteSkinIds = (await readFavoriteSkinIds()).filter(id => itemIds.has(id))
    return {
      status,
      source: this.source,
      generatedAt: this.payload.generatedAt,
      ...(activeSkinId ? { activeSkinId } : {}),
      downloadedSkinIds,
      favoriteSkinIds,
      transfers: {},
      items: structuredClone(this.payload.items),
      ...(this.message ? { message: this.message } : {})
    }
  }
}
