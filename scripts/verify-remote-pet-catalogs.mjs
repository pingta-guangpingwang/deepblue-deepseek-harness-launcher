import { createHash, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const publicKey = await readFile(path.join(root, 'resources', 'pet-catalog-public-key.pem'), 'utf8')
const sources = [
  { id: 'official', expected: 50, catalogUrl: 'https://gitee.com/wanggp123/deepseek-harness-pets/raw/master/catalog.json' },
  { id: 'pixel', expected: 800, catalogUrl: 'https://gitee.com/wanggp123/deepseek-harness-pets-pixel/raw/master/catalog.json' },
  { id: 'live2d', expected: 230, catalogUrl: 'https://gitee.com/wanggp123/deepseek-harness-pets-live2d/raw/master/catalog.json' },
]

async function fetchBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'DeepSeek-Harness-Launcher-Release-Check' } })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

for (const source of sources) {
  const manifest = JSON.parse((await fetchBytes(source.catalogUrl)).toString('utf8'))
  if (manifest.keyId !== 'pet-production-20260817' || manifest.algorithm !== 'ed25519' || manifest.payload?.schemaVersion !== 1 || manifest.payload?.pageSize !== 20) {
    throw new Error(`${source.id} catalog metadata is invalid`)
  }
  if (!verify(null, Buffer.from(JSON.stringify(manifest.payload)), publicKey, Buffer.from(manifest.signature, 'base64'))) {
    throw new Error(`${source.id} catalog signature is invalid`)
  }
  if (manifest.payload.items.length !== source.expected) throw new Error(`${source.id} expected ${source.expected} entries, received ${manifest.payload.items.length}`)
  const first = manifest.payload.items[0]
  const media = await fetchBytes(first.media.url)
  if (media.length !== first.media.size || createHash('sha256').update(media).digest('hex') !== first.media.sha256) {
    throw new Error(`${source.id} first media failed signed size/hash validation`)
  }
  const thumbnail = await fetchBytes(first.thumbnail.url)
  if (thumbnail.length !== first.thumbnail.size || createHash('sha256').update(thumbnail).digest('hex') !== first.thumbnail.sha256) {
    throw new Error(`${source.id} first thumbnail failed signed size/hash validation`)
  }
  if (first.packKind) {
    const entryUrl = new URL(`${first.packPath}${first.entry}`, source.catalogUrl).toString()
    await fetchBytes(entryUrl)
  }
  process.stdout.write(`Verified ${source.id}: ${manifest.payload.items.length} entries, signed sample assets available.\n`)
}

