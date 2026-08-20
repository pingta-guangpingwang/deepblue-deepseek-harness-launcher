import { readFile, writeFile } from 'node:fs/promises'
import { sign } from 'node:crypto'
import path from 'node:path'

const [input, output] = process.argv.slice(2)
const keyPath = process.env.LAUNCHER_SIGNING_KEY

if (!input || !output || !keyPath) {
  console.error('Usage: LAUNCHER_SIGNING_KEY=/secure/private-key.pem npm run sign:manifest -- <payload.json> <launcher-manifest.json>')
  process.exit(2)
}

const payload = JSON.parse(await readFile(path.resolve(input), 'utf8'))
const privateKey = await readFile(path.resolve(keyPath), 'utf8')
const signature = sign(null, Buffer.from(JSON.stringify(payload), 'utf8'), privateKey).toString('base64')
const manifest = {
  keyId: process.env.LAUNCHER_SIGNING_KEY_ID || 'production-1',
  algorithm: 'ed25519',
  payload,
  signature
}
await writeFile(path.resolve(output), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`Signed catalog written to ${path.resolve(output)}`)
