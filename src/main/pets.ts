import { app, nativeImage } from 'electron'
import { createHash, verify } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { launcherDataPaths } from './config'
import { fetchTrustedStoreKey } from './store-trust'
import type {
  PetAsset,
  PetCatalogItem,
  PetCatalogPayload,
  PetMediaKind,
  PetStoreState,
  SignedPetCatalogManifest
} from '../shared/types'

const MAX_MEDIA_BYTES = 12 * 1024 * 1024
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024
const ALLOWED_MIME = new Set<PetAsset['mime']>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

interface ActivePetConfig {
  schemaVersion: 1
  petId: string
  mediaKind: PetMediaKind
  mediaPath: string
  behavior: PetCatalogItem['behavior']
}

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
  }
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

async function downloadAsset(asset: PetAsset): Promise<string> {
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
  if (!response.ok || response.body === null) throw new Error(`下载宠物失败：HTTP ${response.status}`)
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > asset.size || contentLength > MAX_MEDIA_BYTES) throw new Error('远程宠物资源超过清单声明大小')
  const responseType = response.headers.get('content-type')?.split(';', 1)[0]
  if (responseType && responseType !== 'application/octet-stream' && responseType !== asset.mime) throw new Error('远程宠物资源类型与清单不一致')
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temporary, { flags: 'wx' }))
    if (!(await verifyCachedAsset(temporary, asset))) throw new Error('宠物资源完整性校验失败')
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  return target
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

  async refresh(url: string): Promise<PetStoreState> {
    this.message = undefined
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { 'User-Agent': 'DeepSeek-Harness-Launcher' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const manifest = await response.json() as SignedPetCatalogManifest
      const remoteKey = await fetchTrustedStoreKey('pet', url, manifest.keyId).catch(() => undefined)
      const bundledKey = await readPublicKey()
      if (![remoteKey, bundledKey].some(key => key && verifyPetCatalog(manifest, key))) throw new Error('签名校验失败')
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

  async apply(petId: string): Promise<PetStoreState> {
    const custom = (await readCustomRecords()).find(record => record.item.id === petId)
    const item = custom?.item || this.payload.items.find(entry => entry.id === petId)
    if (!item) throw new Error('所选宠物不在当前目录中')
    const mediaPath = custom?.mediaPath || await downloadAsset(item.media)
    const config: ActivePetConfig = { schemaVersion: 1, petId: item.id, mediaKind: item.mediaKind, mediaPath, behavior: item.behavior }
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
    for (const item of this.payload.items) {
      if (await verifyCachedAsset(cachePath(item.media), item.media)) downloadedPetIds.push(item.id)
    }
    const customItems = (await readCustomRecords()).map(withPreview)
    downloadedPetIds.push(...customItems.map(item => item.id))
    return {
      status,
      source: this.source,
      generatedAt: this.payload.generatedAt,
      ...(activePetId ? { activePetId } : {}),
      downloadedPetIds,
      items: [...customItems, ...structuredClone(this.payload.items)].map(item => ({ ...item, origin: item.origin || 'catalog' })),
      ...(this.message ? { message: this.message } : {})
    }
  }
}
