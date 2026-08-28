import { createPublicKey, verify } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const [onlineManifestPath, preparedPayloadPath, outputPath] = process.argv.slice(2)

if (!onlineManifestPath || !preparedPayloadPath || !outputPath) {
  console.error('Usage: node scripts/build-ui-hot-update-payload.mjs <online-manifest.json> <prepared-payload.json> <output-payload.json>')
  process.exit(2)
}

const readJson = async (filePath) => JSON.parse((await readFile(path.resolve(filePath), 'utf8')).replace(/^\uFEFF/u, ''))
const onlineManifest = await readJson(onlineManifestPath)
const preparedPayload = await readJson(preparedPayloadPath)
const publicKey = createPublicKey(await readFile(path.resolve('resources/runtime-update-public-key.pem'), 'utf8'))

if (onlineManifest.keyId !== 'runtime-production-v2-1') throw new Error(`Unexpected production key id: ${onlineManifest.keyId}`)
if (!verify(null, Buffer.from(JSON.stringify(onlineManifest.payload), 'utf8'), publicKey, Buffer.from(onlineManifest.signature, 'base64'))) {
  throw new Error('Current production manifest signature is invalid')
}

const replacementUi = preparedPayload.runtimeModules?.find((module) => module.id === 'launcher-ui')
const currentUi = onlineManifest.payload?.runtimeModules?.find((module) => module.id === 'launcher-ui')
if (!replacementUi || !currentUi) throw new Error('Both catalogs must contain launcher-ui')
if (replacementUi.version === currentUi.version) throw new Error('Prepared launcher-ui is not newer than production')

const payload = structuredClone(onlineManifest.payload)
payload.generatedAt = new Date().toISOString()
payload.runtimeModules = payload.runtimeModules.map((module) => module.id === 'launcher-ui' ? replacementUi : module)

if (payload.launcher?.version !== onlineManifest.payload.launcher?.version) throw new Error('UI-only payload changed the launcher version')
const changedModules = payload.runtimeModules
  .filter((module, index) => JSON.stringify(module) !== JSON.stringify(onlineManifest.payload.runtimeModules[index]))
  .map((module) => module.id)
if (changedModules.length !== 1 || changedModules[0] !== 'launcher-ui') {
  throw new Error(`UI-only payload changed unexpected modules: ${changedModules.join(', ') || 'none'}`)
}

await writeFile(path.resolve(outputPath), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({
  launcher: payload.launcher.version,
  fromUi: currentUi.version,
  toUi: replacementUi.version,
  changedModules
}))
