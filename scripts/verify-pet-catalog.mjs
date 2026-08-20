import { createHash, verify } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(path.join(root, 'pet-store', 'catalog.json'), 'utf8'))
const publicKey = await readFile(path.join(root, 'resources', 'pet-catalog-public-key.pem'), 'utf8')

if (manifest.algorithm !== 'ed25519' || manifest.payload?.schemaVersion !== 1 || manifest.payload?.pageSize !== 20) throw new Error('Pet catalog metadata is invalid')
if (!verify(null, Buffer.from(JSON.stringify(manifest.payload)), publicKey, Buffer.from(manifest.signature, 'base64'))) throw new Error('Pet catalog signature is invalid')

for (const item of manifest.payload.items) {
  for (const [folder, asset] of [['thumbnails', item.thumbnail], ['assets', item.media]]) {
    const filename = new URL(asset.url).pathname.split('/').at(-1)
    const target = path.join(root, 'pet-store', folder, filename)
    const info = await stat(target)
    if (info.size !== asset.size) throw new Error(`${item.id} ${folder} size mismatch`)
    const digest = createHash('sha256').update(await readFile(target)).digest('hex')
    if (digest !== asset.sha256) throw new Error(`${item.id} ${folder} digest mismatch`)
  }
}

console.log(`Verified ${manifest.payload.items.length} signed pet catalog entries.`)
