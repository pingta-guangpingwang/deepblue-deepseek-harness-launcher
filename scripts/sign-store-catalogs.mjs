import { createPrivateKey, sign } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1])

const skinKeyPath = args.get('--skin-key')
const petKeyPath = args.get('--pet-key')
if (!skinKeyPath || !petKeyPath) {
  console.error('Usage: node scripts/sign-store-catalogs.mjs --skin-key <private.pem> --pet-key <private.pem>')
  process.exit(2)
}

async function signPayload(payloadPath, targetPath, keyPath, keyId) {
  const payload = JSON.parse(await readFile(payloadPath, 'utf8'))
  const privateKey = createPrivateKey(await readFile(path.resolve(keyPath), 'utf8'))
  const signature = sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64')
  await writeFile(targetPath, `${JSON.stringify({ keyId, algorithm: 'ed25519', payload, signature }, null, 2)}\n`, 'utf8')
  return { items: payload.items.length, targetPath }
}

async function signCatalog(folder, keyPath, keyId) {
  const result = await signPayload(
    path.resolve(folder, 'catalog.payload.json'),
    path.resolve(folder, 'catalog.json'),
    keyPath,
    keyId
  )
  return { folder, ...result }
}

/**
 * The external source catalog is signed with the skin store key because the
 * launcher resolves it through the skin trust root. It is optional: a checkout
 * without a generated payload simply skips it.
 */
async function signExternalCatalog(keyPath, keyId) {
  const payloadPath = path.resolve('skin-store', 'external-catalog.payload.json')
  try {
    await access(payloadPath)
  } catch {
    return undefined
  }
  const result = await signPayload(payloadPath, path.resolve('skin-store', 'external-catalog.json'), keyPath, keyId)
  return { folder: 'skin-store (external sources)', ...result }
}

const results = await Promise.all([
  signCatalog('skin-store', skinKeyPath, 'skin-production-20260817'),
  signCatalog('pet-store', petKeyPath, 'pet-production-20260817')
])
const external = await signExternalCatalog(skinKeyPath, 'skin-production-20260817')
if (external) results.push(external)
console.log(JSON.stringify({ ok: true, catalogs: results }))
