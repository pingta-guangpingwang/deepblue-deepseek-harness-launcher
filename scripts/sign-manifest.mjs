import { readFile, writeFile } from 'node:fs/promises'
import { createPublicKey, sign } from 'node:crypto'
import path from 'node:path'

const [input, output] = process.argv.slice(2)
const keyPath = process.env.LAUNCHER_SIGNING_KEY

if (!input || !output || !keyPath) {
  console.error('Usage: LAUNCHER_SIGNING_KEY=/secure/private-key.pem npm run sign:manifest -- <payload.json> <launcher-manifest.json>')
  process.exit(2)
}

const payload = JSON.parse(await readFile(path.resolve(input), 'utf8'))
const privateKey = await readFile(path.resolve(keyPath), 'utf8')
const trustedPublicKey = createPublicKey(await readFile(path.resolve('resources/runtime-update-public-key.pem'), 'utf8')).export({ type: 'spki', format: 'der' })
const signingPublicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
if (!signingPublicKey.equals(trustedPublicKey)) throw new Error('Signing key does not match resources/runtime-update-public-key.pem')
const keyId = process.env.LAUNCHER_SIGNING_KEY_ID || 'runtime-production-v2-1'
if (keyId !== 'runtime-production-v2-1') throw new Error(`Unsupported runtime catalog key id: ${keyId}`)
const signature = sign(null, Buffer.from(JSON.stringify(payload), 'utf8'), privateKey).toString('base64')
const manifest = {
  // Schema-2 runtime catalogs have an independent trust root. Keeping the
  // production key id as the default prevents a correctly signed catalog from
  // being silently rejected by every launcher after a release.
  keyId,
  algorithm: 'ed25519',
  payload,
  signature
}
await writeFile(path.resolve(output), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`Signed catalog written to ${path.resolve(output)}`)
