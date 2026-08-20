import { generateKeyPairSync } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const [privateTarget, publicTarget] = process.argv.slice(2)
if (!privateTarget || !publicTarget) {
  console.error('Usage: npm run keys:generate -- <private-key.pem> <public-key.pem>')
  process.exit(2)
}

for (const target of [privateTarget, publicTarget]) {
  try {
    await access(path.resolve(target))
    throw new Error(`Refusing to overwrite existing key: ${path.resolve(target)}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing')) throw error
  }
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' })
const publicPem = publicKey.export({ type: 'spki', format: 'pem' })
await mkdir(path.dirname(path.resolve(privateTarget)), { recursive: true })
await mkdir(path.dirname(path.resolve(publicTarget)), { recursive: true })
await writeFile(path.resolve(privateTarget), privatePem, { mode: 0o600 })
await writeFile(path.resolve(publicTarget), publicPem)
console.log(`Private key: ${path.resolve(privateTarget)}`)
console.log(`Public key: ${path.resolve(publicTarget)}`)
