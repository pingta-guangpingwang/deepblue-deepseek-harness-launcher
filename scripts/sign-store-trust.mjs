import { readFile, writeFile } from 'node:fs/promises'
import { sign } from 'node:crypto'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const rootPrivateKeyPath = process.env.LAUNCHER_SIGNING_KEY
if (!rootPrivateKeyPath) throw new Error('LAUNCHER_SIGNING_KEY is required')

const rootPrivateKey = await readFile(path.resolve(rootPrivateKeyPath), 'utf8')
const generatedAt = new Date().toISOString()
const stores = [
  {
    store: 'skin',
    repository: path.join(root, 'output', 'gitee-skins'),
    catalogUrl: 'https://gitee.com/wanggp123/deepseek-harness-skins/raw/master/catalog.json',
    publicKeyPath: path.join(root, 'resources', 'skin-catalog-public-key.pem')
  },
  {
    store: 'pet',
    repository: path.join(root, 'output', 'gitee-pets'),
    catalogUrl: 'https://gitee.com/wanggp123/deepseek-harness-pets/raw/master/catalog.json',
    publicKeyPath: path.join(root, 'resources', 'pet-catalog-public-key.pem')
  }
]

for (const store of stores) {
  const catalog = JSON.parse(await readFile(path.join(store.repository, 'catalog.json'), 'utf8'))
  const payload = {
    schemaVersion: 1,
    generatedAt,
    store: store.store,
    catalogUrl: store.catalogUrl,
    keys: [{
      keyId: catalog.keyId,
      algorithm: 'ed25519',
      publicKeyPem: await readFile(store.publicKeyPath, 'utf8'),
      status: 'active'
    }]
  }
  const manifest = {
    keyId: process.env.LAUNCHER_SIGNING_KEY_ID || 'production-1',
    algorithm: 'ed25519',
    payload,
    signature: sign(null, Buffer.from(JSON.stringify(payload), 'utf8'), rootPrivateKey).toString('base64')
  }
  await writeFile(path.join(store.repository, 'trust.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`Signed fixed ${store.store} trust manifest.`)
}
