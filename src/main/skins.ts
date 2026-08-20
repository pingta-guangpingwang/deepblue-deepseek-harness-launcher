import { app } from 'electron'
import { createHash, verify } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { launcherDataPaths } from './config'
import { fetchTrustedStoreKey } from './store-trust'
import type {
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
  license: SkinCatalogItem['license']
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
    if (item.presentation.blurPx < 0 || item.presentation.blurPx > 24) throw new Error(`皮肤 ${item.id} 的模糊参数无效`)
    if (item.presentation.surfaceOpacity < 0.2 || item.presentation.surfaceOpacity > 0.98) throw new Error(`皮肤 ${item.id} 的界面透明度无效`)
    const position = item.presentation.position.match(/^(\d{1,3})% (\d{1,3})%$/)
    if (!position || Number(position[1]) > 100 || Number(position[2]) > 100) throw new Error(`皮肤 ${item.id} 的焦点参数无效`)
    const overlay = item.presentation.overlay.match(/^rgba\((\d{1,3}), (\d{1,3}), (\d{1,3}), (0|1|0?\.\d+)\)$/)
    if (!overlay || overlay.slice(1, 4).some(value => Number(value) > 255) || Number(overlay[4]) > 1) {
      throw new Error(`皮肤 ${item.id} 的遮罩参数无效`)
    }
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

async function downloadAsset(asset: SkinAsset): Promise<string> {
  assertAsset(asset)
  const target = cachePath(asset)
  if (await verifyCachedAsset(target, asset)) return target
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.part`
  await unlink(temporary).catch(() => undefined)
  const response = await fetch(asset.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(90_000),
    headers: { 'User-Agent': 'DeepSeek-Harness-Launcher' }
  })
  if (!response.ok || response.body === null) throw new Error(`下载皮肤失败：HTTP ${response.status}`)
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > asset.size || contentLength > (asset.mime.startsWith('video/') ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES)) {
    throw new Error('远程皮肤资源超过清单声明大小')
  }
  const responseType = response.headers.get('content-type')?.split(';', 1)[0]
  if (responseType && responseType !== 'application/octet-stream' && responseType !== asset.mime) throw new Error('远程皮肤资源类型与清单不一致')
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temporary, { flags: 'wx' }))
    if (!(await verifyCachedAsset(temporary, asset))) throw new Error('皮肤资源完整性校验失败')
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  return target
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

  async apply(skinId: string): Promise<SkinStoreState> {
    const item = this.payload.items.find(entry => entry.id === skinId)
    if (!item) throw new Error('所选皮肤不在当前签名目录中')
    const mediaPath = await downloadAsset(item.media)
    const posterPath = item.poster ? await downloadAsset(item.poster) : undefined
    const config: ActiveSkinConfig = {
      schemaVersion: 1,
      skinId: item.id,
      mediaKind: item.mediaKind,
      mediaPath,
      ...(posterPath ? { posterPath } : {}),
      presentation: item.presentation,
      license: item.license
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
    for (const item of this.payload.items) {
      if (await exists(cachePath(item.media))) downloadedSkinIds.push(item.id)
    }
    return {
      status,
      source: this.source,
      generatedAt: this.payload.generatedAt,
      ...(activeSkinId ? { activeSkinId } : {}),
      downloadedSkinIds,
      items: structuredClone(this.payload.items),
      ...(this.message ? { message: this.message } : {})
    }
  }
}
