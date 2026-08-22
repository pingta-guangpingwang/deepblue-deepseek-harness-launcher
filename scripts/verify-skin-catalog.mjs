import { verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('skin-store')
const manifest = JSON.parse(await readFile(path.join(root, 'catalog.json'), 'utf8'))
const payload = JSON.parse(await readFile(path.join(root, 'catalog.payload.json'), 'utf8'))
const publicKey = await readFile(path.resolve('resources/skin-catalog-public-key.pem'), 'utf8')
const repositories = [
  'https://gitee.com/wanggp123/deepseek-harness-skins/raw/master/',
  'https://gitee.com/wanggp123/deepseek-harness-skins-video/raw/master/'
]

if (manifest.algorithm !== 'ed25519' || manifest.payload?.schemaVersion !== 1 || manifest.payload?.pageSize !== 20) throw new Error('Skin catalog envelope is invalid')
if (JSON.stringify(manifest.payload) !== JSON.stringify(payload)) throw new Error('Signed and distributable skin payloads differ')
if (!verify(null, Buffer.from(JSON.stringify(manifest.payload)), publicKey, Buffer.from(manifest.signature, 'base64'))) throw new Error('Skin catalog signature is invalid')

const seen = new Set()
const counts = { main: 0, video: 0 }
for (const item of manifest.payload.items) {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(item.id) || seen.has(item.id)) throw new Error(`Invalid or duplicate skin id: ${item.id}`)
  seen.add(item.id)
  for (const [kind, asset] of [['thumbnail', item.thumbnail], ['media', item.media], ...(item.poster ? [['poster', item.poster]] : [])]) {
    const prefix = repositories.find((candidate) => asset.url.startsWith(candidate))
    if (!prefix) throw new Error(`${item.id} ${kind} is outside the two fixed Gitee repositories`)
    if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 80 * 1024 * 1024) throw new Error(`${item.id} ${kind} integrity metadata is invalid`)
    if (kind === 'thumbnail' && (!asset.url.startsWith(`${repositories[0]}thumbnails/`) || !asset.mime.startsWith('image/'))) throw new Error(`${item.id} thumbnail must be an image in the main Gitee repository`)
    if (kind === 'media') counts[prefix === repositories[0] ? 'main' : 'video'] += 1
  }
}

console.log(`Verified ${manifest.payload.items.length} signed skins: ${counts.main} media assets in skins and ${counts.video} in skins-video.`)
