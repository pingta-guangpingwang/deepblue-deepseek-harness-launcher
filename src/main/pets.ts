import { app, nativeImage } from 'electron'
import { createHash, verify } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { FIXED_PET_CATALOG_SOURCES, launcherDataPaths } from './config'
import { downloadTimeoutMs, mirrorCandidates } from './asset-mirrors'
import { fetchTrustedStoreKey } from './store-trust'
import type {
  PetAsset,
  PetCatalogItem,
  PetCatalogPayload,
  PetCatalogSourceId,
  PetCatalogSourceState,
  PetMediaKind,
  PetPreview,
  PetStoreState,
  SignedPetCatalogManifest
} from '../shared/types'

const MAX_MEDIA_BYTES = 12 * 1024 * 1024
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024
const ALLOWED_MIME = new Set<PetAsset['mime']>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const GITEE_PET_ASSET_PREFIXES = FIXED_PET_CATALOG_SOURCES.map(source => `${source.repositoryUrl}/raw/master/`)

interface ActivePetConfig {
  schemaVersion: 1
  petId: string
  mediaKind: PetMediaKind
  mediaPath: string
  packKind?: PetCatalogItem['packKind']
  behavior: PetCatalogItem['behavior']
}

interface FavoritePetFile {
  schemaVersion: 1
  petIds: string[]
}

export interface PetDownloadProgress {
  status: 'downloading' | 'verifying' | 'completed'
  receivedBytes: number
  totalBytes: number
  message: string
}

type PetDownloadReporter = (progress: PetDownloadProgress) => void

interface CustomPetRecord {
  item: PetCatalogItem
  mediaPath: string
  previewPath: string
}

function publicKeyCandidates(): string[] {
  return [
    path.join(process.resourcesPath, 'resources', 'pet-catalog-public-key.pem'),
    path.join(app.getAppPath(), 'resources', 'pet-catalog-public-key.pem')
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

export function verifyPetCatalog(manifest: SignedPetCatalogManifest, publicKey: string): boolean {
  if (manifest.algorithm !== 'ed25519' || manifest.payload.schemaVersion !== 1 || manifest.payload.pageSize !== 20) return false
  try {
    return verify(null, Buffer.from(JSON.stringify(manifest.payload)), publicKey, Buffer.from(manifest.signature, 'base64'))
  } catch {
    return false
  }
}

function assertAsset(asset: PetAsset, thumbnail = false): void {
  const url = new URL(asset.url)
  if (url.protocol !== 'https:') throw new Error('宠物资源必须使用 HTTPS')
  if (!GITEE_PET_ASSET_PREFIXES.some(prefix => asset.url.startsWith(prefix))) throw new Error('宠物资源必须来自三个固定的 Gitee 宠物仓库')
  if (!/^[a-f0-9]{64}$/i.test(asset.sha256)) throw new Error('宠物资源 SHA-256 无效')
  if (!ALLOWED_MIME.has(asset.mime)) throw new Error(`不支持的宠物资源类型：${asset.mime}`)
  const limit = thumbnail ? MAX_THUMBNAIL_BYTES : MAX_MEDIA_BYTES
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > limit) throw new Error('宠物资源大小超出安全限制')
}

function assertCatalog(payload: PetCatalogPayload): void {
  if (payload.schemaVersion !== 1 || payload.pageSize !== 20 || !Array.isArray(payload.items)) throw new Error('宠物目录版本不兼容')
  const ids = new Set<string>()
  for (const item of payload.items) {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(item.id) || ids.has(item.id)) throw new Error(`宠物 ID 无效或重复：${item.id}`)
    ids.add(item.id)
    if (item.contentRating !== 'everyone' || item.origin === 'custom') throw new Error(`宠物 ${item.id} 的内容分级或来源无效`)
    assertAsset(item.thumbnail, true)
    assertAsset(item.media)
    if (item.mediaKind === 'animated' && item.media.mime !== 'image/gif' && item.media.mime !== 'image/webp') throw new Error(`宠物 ${item.id} 的媒体类型不匹配`)
    if (item.behavior.widthPx < 96 || item.behavior.widthPx > 280) throw new Error(`宠物 ${item.id} 的显示尺寸无效`)
    if (!['float', 'bounce', 'none'].includes(item.behavior.idleMotion)) throw new Error(`宠物 ${item.id} 的待机动作无效`)
    if (!['hop', 'spin', 'heart'].includes(item.behavior.clickMotion)) throw new Error(`宠物 ${item.id} 的点击动作无效`)
    if (!Array.isArray(item.behavior.speechLines) || item.behavior.speechLines.length > 6 || item.behavior.speechLines.some(line => typeof line !== 'string' || line.length > 24)) {
      throw new Error(`宠物 ${item.id} 的互动文案无效`)
    }
    if (item.behavior.autoSpeakIntervalSec !== undefined && (!Number.isSafeInteger(item.behavior.autoSpeakIntervalSec) || item.behavior.autoSpeakIntervalSec < 30 || item.behavior.autoSpeakIntervalSec > 600)) {
      throw new Error(`宠物 ${item.id} 的主动问候间隔无效`)
    }
    if (item.behavior.hoverMotion !== undefined && !['perk', 'none'].includes(item.behavior.hoverMotion)) {
      throw new Error(`宠物 ${item.id} 的悬停动作无效`)
    }
    if (item.license.name === 'LOCAL') throw new Error(`宠物 ${item.id} 的许可证无效`)
    if (item.packKind !== undefined && !['pixel-atlas', 'live2d'].includes(item.packKind)) throw new Error(`宠物 ${item.id} 的资源包类型无效`)
    if (item.packKind && (!item.entry || !/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(item.entry) || !item.packPath || !/^packs\/[a-z0-9-]+\/$/.test(item.packPath))) {
      throw new Error(`宠物 ${item.id} 的资源包入口无效`)
    }
  }
}

export function nextFavoritePetIds(current: string[], petId: string): string[] {
  const unique = [...new Set(current.filter(id => typeof id === 'string' && id.length <= 64))]
  return unique.includes(petId) ? unique.filter(id => id !== petId) : [petId, ...unique]
}

async function readFavoritePetIds(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(launcherDataPaths().petFavorites, 'utf8')) as Partial<FavoritePetFile>
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.petIds)) return []
    return [...new Set(parsed.petIds.filter(id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{1,63}$/.test(id)))].slice(0, 2_000)
  } catch {
    return []
  }
}

async function writeFavoritePetIds(petIds: string[]): Promise<void> {
  const target = launcherDataPaths().petFavorites
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(`${target}.next`, `${JSON.stringify({ schemaVersion: 1, petIds } satisfies FavoritePetFile, null, 2)}\n`, 'utf8')
  await rename(`${target}.next`, target)
}

function extensionFor(asset: PetAsset): string {
  return ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' } satisfies Record<PetAsset['mime'], string>)[asset.mime]
}

function mimeForExtension(filename: string): PetAsset['mime'] | undefined {
  const extension = path.extname(filename).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.gif') return 'image/gif'
  return undefined
}

function cachePath(asset: PetAsset): string {
  return path.join(launcherDataPaths().pets, 'cache', `${asset.sha256.toLowerCase()}${extensionFor(asset)}`)
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function verifyCachedAsset(target: string, asset: PetAsset): Promise<boolean> {
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
      if (seen > limit) throw new Error('远程宠物资源超过清单声明大小')
      onChunk?.(seen)
      yield chunk as Buffer
    }
  })()
}

async function fetchAssetFrom(asset: PetAsset, url: string, temporary: string, sourceLabel: string, onProgress?: PetDownloadReporter): Promise<void> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(downloadTimeoutMs(asset.size)),
    headers: { 'User-Agent': 'DeepSeek-Harness-Launcher' }
  })
  if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > asset.size || contentLength > MAX_MEDIA_BYTES) throw new Error('远程宠物资源超过清单声明大小')
  const responseType = response.headers.get('content-type')?.split(';', 1)[0]
  if (responseType && responseType !== 'application/octet-stream' && responseType !== asset.mime) throw new Error('资源类型与清单不一致')
  await unlink(temporary).catch(() => undefined)
  try {
    await pipeline(cappedStream(Readable.fromWeb(response.body as never), asset.size, receivedBytes => {
      onProgress?.({ status: 'downloading', receivedBytes, totalBytes: asset.size, message: `正在从 ${sourceLabel} 下载` })
    }), createWriteStream(temporary, { flags: 'wx' }))
    onProgress?.({ status: 'verifying', receivedBytes: asset.size, totalBytes: asset.size, message: '下载完成，正在校验完整性' })
    if (!(await verifyCachedAsset(temporary, asset))) throw new Error('完整性校验失败')
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function downloadAsset(asset: PetAsset, onProgress?: PetDownloadReporter): Promise<string> {
  assertAsset(asset)
  const target = cachePath(asset)
  onProgress?.({ status: 'verifying', receivedBytes: 0, totalBytes: asset.size, message: '正在检查本地缓存' })
  if (await verifyCachedAsset(target, asset)) {
    onProgress?.({ status: 'completed', receivedBytes: asset.size, totalBytes: asset.size, message: '本机宠物资源已就绪' })
    return target
  }
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.part`
  const candidates = mirrorCandidates(asset.url, asset.size)
  if (!candidates.length) throw new Error('宠物资源地址不可用')
  let lastFailure = '未知错误'
  for (const candidate of candidates) {
    try {
      onProgress?.({ status: 'downloading', receivedBytes: 0, totalBytes: asset.size, message: `正在连接 ${candidate.id.toUpperCase()}` })
      await fetchAssetFrom(asset, candidate.url, temporary, candidate.id.toUpperCase(), onProgress)
      await unlink(target).catch(() => undefined)
      await rename(temporary, target)
      onProgress?.({ status: 'completed', receivedBytes: asset.size, totalBytes: asset.size, message: '宠物资源下载完成' })
      return target
    } catch (error) {
      lastFailure = `${candidate.id}：${error instanceof Error ? error.message : String(error)}`
    }
  }
  throw new Error(`下载宠物失败，已尝试 ${candidates.length} 个渠道，最后一次 ${lastFailure}`)
}

async function readBundledCatalog(): Promise<PetCatalogPayload | undefined> {
  const candidates = [
    path.join(process.resourcesPath, 'pet-store', 'catalog.payload.json'),
    path.join(app.getAppPath(), 'pet-store', 'catalog.payload.json'),
    path.resolve('pet-store', 'catalog.payload.json')
  ]
  for (const candidate of candidates) {
    try {
      const payload = JSON.parse(await readFile(candidate, 'utf8')) as PetCatalogPayload
      assertCatalog(payload)
      return payload
    } catch {
      // Try the next packaged or development fallback.
    }
  }
  return undefined
}

function customIndexPath(): string {
  return path.join(launcherDataPaths().pets, 'custom', 'index.json')
}

function isInsideCustomDirectory(target: string): boolean {
  const root = `${path.resolve(launcherDataPaths().pets, 'custom')}${path.sep}`.toLowerCase()
  return path.resolve(target).toLowerCase().startsWith(root)
}

async function readCustomRecords(): Promise<CustomPetRecord[]> {
  try {
    const records = JSON.parse(await readFile(customIndexPath(), 'utf8')) as CustomPetRecord[]
    const valid: CustomPetRecord[] = []
    for (const record of records) {
      if (record.item?.origin !== 'custom' || !isInsideCustomDirectory(record.mediaPath) || !isInsideCustomDirectory(record.previewPath)) continue
      if (await exists(record.mediaPath) && await exists(record.previewPath)) valid.push(record)
    }
    return valid
  } catch {
    return []
  }
}

async function writeCustomRecords(records: CustomPetRecord[]): Promise<void> {
  const target = customIndexPath()
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(`${target}.next`, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
  await rename(`${target}.next`, target)
}

function withPreview(record: CustomPetRecord): PetCatalogItem {
  const image = nativeImage.createFromPath(record.previewPath)
  return { ...record.item, previewDataUrl: image.isEmpty() ? undefined : image.toDataURL() }
}

export class PetStore {
  private payload: PetCatalogPayload = { schemaVersion: 1, generatedAt: '', pageSize: 20, items: [] }
  private source: PetStoreState['source'] = 'bundled'
  private message: string | undefined
  private sources: PetCatalogSourceState[] = []

  async refresh(): Promise<PetStoreState> {
    this.message = undefined
    const bundledKey = await readPublicKey()
    const results = await Promise.all(FIXED_PET_CATALOG_SOURCES.map(async (source) => {
      try {
        const response = await fetch(source.catalogUrl, { signal: AbortSignal.timeout(12_000), headers: { 'User-Agent': 'DeepSeek-Harness-Launcher' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const manifest = await response.json() as SignedPetCatalogManifest
        const remoteKey = await fetchTrustedStoreKey('pet', source.catalogUrl, manifest.keyId).catch(() => undefined)
        if (![remoteKey, bundledKey].some(key => key && verifyPetCatalog(manifest, key))) throw new Error('签名校验失败')
        assertCatalog(manifest.payload)
        return { source, payload: manifest.payload }
      } catch (error) {
        return { source, error: error instanceof Error ? error.message : String(error) }
      }
    }))
    const merged = new Map<string, PetCatalogItem>()
    const generatedAt: string[] = []
    this.sources = []
    for (const result of results) {
      if (result.payload) {
        for (const item of result.payload.items) {
          if (merged.has(item.id)) throw new Error(`三个宠物目录存在重复 ID：${item.id}`)
          merged.set(item.id, { ...structuredClone(item), catalogSource: result.source.id as Exclude<PetCatalogSourceId, 'custom'> })
        }
        generatedAt.push(result.payload.generatedAt)
        this.sources.push({ id: result.source.id, name: result.source.name, repositoryUrl: result.source.repositoryUrl, status: 'ready', itemCount: result.payload.items.length })
      } else {
        this.sources.push({ id: result.source.id, name: result.source.name, repositoryUrl: result.source.repositoryUrl, status: 'error', itemCount: 0, message: result.error })
      }
    }
    const officialState = this.sources.find(source => source.id === 'official')
    if (officialState?.status !== 'ready') {
      const bundled = await readBundledCatalog()
      if (bundled) {
        for (const item of bundled.items) if (!merged.has(item.id)) merged.set(item.id, { ...structuredClone(item), catalogSource: 'official' })
        generatedAt.push(bundled.generatedAt)
        Object.assign(officialState || {}, { status: 'offline', itemCount: bundled.items.length, message: '在线目录不可用，已使用内置目录' })
      }
    }
    this.payload = {
      schemaVersion: 1,
      generatedAt: generatedAt.sort().at(-1) || '',
      pageSize: 20,
      items: [...merged.values()]
    }
    const failures = this.sources.filter(source => source.status !== 'ready')
    this.message = failures.length ? `${failures.map(source => source.name).join('、')}目录暂不可用，其余来源已正常加载。` : undefined
    this.source = results.some(result => result.payload) ? 'remote' : 'bundled'
    const status: PetStoreState['status'] = this.payload.items.length ? (this.source === 'remote' ? 'ready' : 'offline') : 'error'
    return this.snapshot(status)
  }

  private item(petId: string): PetCatalogItem {
    const item = this.payload.items.find(entry => entry.id === petId)
    if (!item) throw new Error('所选宠物不在当前 Gitee 签名目录中')
    return item
  }

  async download(petId: string, onProgress?: PetDownloadReporter): Promise<PetStoreState> {
    await downloadAsset(this.item(petId).media, onProgress)
    return this.snapshot('ready')
  }

  async preview(petId: string, onProgress?: PetDownloadReporter): Promise<{ state: PetStoreState; preview: PetPreview }> {
    const item = this.item(petId)
    const previewAsset = item.packKind === 'live2d' ? item.thumbnail : item.media
    const assets = previewAsset === item.media ? [item.media] : [item.media, previewAsset]
    const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0)
    let completedBytes = 0
    const paths: string[] = []
    for (const asset of assets) {
      paths.push(await downloadAsset(asset, progress => onProgress?.({
        ...progress,
        receivedBytes: Math.min(totalBytes, completedBytes + progress.receivedBytes),
        totalBytes,
      })))
      completedBytes += asset.size
    }
    const previewPath = paths.at(-1)!
    return {
      state: await this.snapshot('ready'),
      preview: {
        petId,
        name: item.name,
        mediaKind: item.mediaKind,
        packKind: item.packKind || 'image',
        mediaUrl: `deepblue-pet://cache/${path.basename(previewPath)}`,
        mime: previewAsset.mime
      }
    }
  }

  async apply(petId: string, onProgress?: PetDownloadReporter): Promise<PetStoreState> {
    const custom = (await readCustomRecords()).find(record => record.item.id === petId)
    const item = custom?.item || this.payload.items.find(entry => entry.id === petId)
    if (!item) throw new Error('所选宠物不在当前目录中')
    if (item.packKind === 'live2d') throw new Error('Live2D 模型包已支持下载、收藏与预览；安全运行库接入后才可应用到 Harness')
    const mediaPath = custom?.mediaPath || await downloadAsset(item.media, onProgress)
    const config: ActivePetConfig = { schemaVersion: 1, petId: item.id, mediaKind: item.mediaKind, mediaPath, ...(item.packKind ? { packKind: item.packKind } : {}), behavior: item.behavior }
    const target = launcherDataPaths().petConfig
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(`${target}.next`, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    await rename(`${target}.next`, target)
    return this.snapshot('ready')
  }

  async clear(): Promise<PetStoreState> {
    await unlink(launcherDataPaths().petConfig).catch(() => undefined)
    return this.snapshot('ready')
  }

  async toggleFavorite(petId: string): Promise<PetStoreState> {
    this.item(petId)
    await writeFavoritePetIds(nextFavoritePetIds(await readFavoritePetIds(), petId))
    return this.snapshot('ready')
  }

  async remove(petId: string): Promise<PetStoreState> {
    const item = this.item(petId)
    let activePetId: string | undefined
    try {
      activePetId = (JSON.parse(await readFile(launcherDataPaths().petConfig, 'utf8')) as ActivePetConfig).petId
    } catch {
      // No active pet needs to be reset.
    }
    if (activePetId === petId) await unlink(launcherDataPaths().petConfig).catch(() => undefined)
    const targets = [...new Set([item.media, ...(item.packKind === 'live2d' ? [item.thumbnail] : [])].map(cachePath))]
    await Promise.all(targets.flatMap(target => [unlink(target).catch(() => undefined), unlink(`${target}.part`).catch(() => undefined)]))
    return this.snapshot('ready')
  }

  async importCustom(filename: string): Promise<PetStoreState> {
    const mime = mimeForExtension(filename)
    if (!mime) throw new Error('仅支持 PNG、JPG、WebP 或 GIF 宠物图片')
    const info = await stat(filename)
    if (!info.isFile() || info.size <= 0 || info.size > MAX_MEDIA_BYTES) throw new Error('宠物图片必须小于 12 MB')
    const image = nativeImage.createFromPath(filename)
    if (image.isEmpty()) throw new Error('无法识别这张宠物图片')
    const digest = createHash('sha256').update(await readFile(filename)).digest('hex')
    const id = `custom-${digest.slice(0, 16)}`
    const customDirectory = path.join(launcherDataPaths().pets, 'custom')
    await mkdir(customDirectory, { recursive: true })
    const mediaPath = path.join(customDirectory, `${id}${extensionFor({ url: '', sha256: digest, size: info.size, mime })}`)
    const previewPath = path.join(customDirectory, `${id}-preview.png`)
    await copyFile(filename, mediaPath)
    const resized = image.resize({ width: Math.min(360, image.getSize().width), quality: 'good' })
    await writeFile(previewPath, resized.toPNG())
    const displayName = path.basename(filename, path.extname(filename)).slice(0, 32) || '我的宠物'
    const record: CustomPetRecord = {
      mediaPath,
      previewPath,
      item: {
        id,
        name: displayName,
        description: '从本机导入，只保存在当前电脑。',
        mediaKind: mime === 'image/gif' ? 'animated' : 'static',
        species: 'other',
        styles: ['cute'],
        tags: ['自定义'],
        featured: false,
        contentRating: 'everyone',
        thumbnail: { url: '', sha256: digest, size: info.size, mime },
        media: { url: '', sha256: digest, size: info.size, mime },
        license: { name: 'LOCAL', url: '', author: '本机用户', sourceUrl: '' },
        behavior: { widthPx: 168, idleMotion: 'float', clickMotion: 'heart', speechLines: ['今天也一起加油吧！', '点我可以互动哦'] },
        origin: 'custom'
      }
    }
    const records = (await readCustomRecords()).filter(entry => entry.item.id !== id)
    records.unshift(record)
    await writeCustomRecords(records)
    return this.snapshot('ready')
  }

  async removeCustom(petId: string): Promise<PetStoreState> {
    const records = await readCustomRecords()
    const target = records.find(record => record.item.id === petId)
    if (!target) throw new Error('只能删除从本机导入的宠物')
    if (isInsideCustomDirectory(target.mediaPath)) await unlink(target.mediaPath).catch(() => undefined)
    if (isInsideCustomDirectory(target.previewPath)) await unlink(target.previewPath).catch(() => undefined)
    await writeCustomRecords(records.filter(record => record.item.id !== petId))
    try {
      const active = JSON.parse(await readFile(launcherDataPaths().petConfig, 'utf8')) as ActivePetConfig
      if (active.petId === petId) await unlink(launcherDataPaths().petConfig).catch(() => undefined)
    } catch {
      // No active pet is the normal state.
    }
    return this.snapshot('ready')
  }

  async snapshot(status: PetStoreState['status'] = 'ready'): Promise<PetStoreState> {
    let activePetId: string | undefined
    try {
      activePetId = (JSON.parse(await readFile(launcherDataPaths().petConfig, 'utf8')) as ActivePetConfig).petId
    } catch {
      // No active pet is the normal initial state.
    }
    const downloadedPetIds: string[] = []
    for (const item of this.payload.items) if (await exists(cachePath(item.media))) downloadedPetIds.push(item.id)
    const customItems = (await readCustomRecords()).map(withPreview)
    downloadedPetIds.push(...customItems.map(item => item.id))
    const itemIds = new Set(this.payload.items.map(item => item.id))
    const favoritePetIds = (await readFavoritePetIds()).filter(id => itemIds.has(id))
    return {
      status,
      source: this.source,
      generatedAt: this.payload.generatedAt,
      ...(activePetId ? { activePetId } : {}),
      downloadedPetIds,
      favoritePetIds,
      transfers: {},
      sources: structuredClone(this.sources),
      items: [...customItems.map(item => ({ ...item, catalogSource: 'custom' as const })), ...structuredClone(this.payload.items)].map(item => ({ ...item, origin: item.origin || 'catalog' })),
      ...(this.message ? { message: this.message } : {})
    }
  }
}
