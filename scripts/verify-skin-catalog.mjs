import { createHash, verify } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('skin-store')
const manifest = JSON.parse(await readFile(path.join(root, 'catalog.json'), 'utf8'))
const publicKey = await readFile(path.resolve('resources/skin-catalog-public-key.pem'), 'utf8')
if (manifest.algorithm !== 'ed25519' || manifest.payload?.schemaVersion !== 1 || manifest.payload?.pageSize !== 20) throw new Error('Skin catalog envelope is invalid')
if (!verify(null, Buffer.from(JSON.stringify(manifest.payload)), publicKey, Buffer.from(manifest.signature, 'base64'))) throw new Error('Skin catalog signature is invalid')

const seen = new Set()
for (const item of manifest.payload.items) {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(item.id) || seen.has(item.id)) throw new Error(`Invalid or duplicate skin id: ${item.id}`)
  seen.add(item.id)
  for (const [kind, asset] of [['thumbnail', item.thumbnail], ['media', item.media], ...(item.poster ? [['poster', item.poster]] : [])]) {
    const url = new URL(asset.url)
    const filename = decodeURIComponent(url.pathname.split('/').at(-1))
    const local = path.join(root, kind === 'thumbnail' ? 'thumbnails' : 'assets', filename)
    const bytes = await readFile(local)
    const info = await stat(local)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (info.size !== asset.size) throw new Error(`${item.id} ${kind} size mismatch`)
    if (digest !== asset.sha256) throw new Error(`${item.id} ${kind} SHA-256 mismatch`)
  }
}

console.log(`Verified ${manifest.payload.items.length} signed skins and their local assets.`)
