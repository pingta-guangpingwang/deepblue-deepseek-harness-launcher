import { createHash, createPublicKey } from 'node:crypto'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fetchBoundedBytes } from './bounded-fetch.mjs'
import { validateRuntimeModules, verifyRuntimeCatalogManifest } from './runtime-catalog-validation.mjs'

const [onlineManifestPath, launcherUiRecordPath, outputPath] = process.argv.slice(2)
const expectedLauncherVersion = process.env.EXPECTED_PUBLIC_LAUNCHER_VERSION
const expectedLauncherUiVersion = process.env.EXPECTED_PUBLIC_LAUNCHER_UI_VERSION
const expectedNewLauncherUiVersion = process.env.EXPECTED_NEW_LAUNCHER_UI_VERSION
const expectedNewLauncherUiSha256 = process.env.EXPECTED_NEW_LAUNCHER_UI_SHA256
const expectedNewLauncherUiSize = Number(process.env.EXPECTED_NEW_LAUNCHER_UI_SIZE)
const expectedNewLauncherUiUnpackedSize = Number(process.env.EXPECTED_NEW_LAUNCHER_UI_UNPACKED_SIZE)
const mirrorTimeoutMs = Number(process.env.LAUNCHER_UI_MIRROR_TIMEOUT_MS || 30_000)
const productionManifestUrl = 'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/release-v2/launcher-manifest.json'
const repositoryRoot = path.resolve(import.meta.dirname, '..')
const outputFile = path.resolve(outputPath || '')
const expectedOutputFile = path.join(repositoryRoot, 'release', 'launcher-catalog-payload.launcher-ui.json')

if (!onlineManifestPath || !launcherUiRecordPath || !outputPath || !expectedLauncherVersion || !expectedLauncherUiVersion || !expectedNewLauncherUiVersion || !/^[a-f0-9]{64}$/.test(expectedNewLauncherUiSha256 || '') || !Number.isSafeInteger(expectedNewLauncherUiSize) || expectedNewLauncherUiSize < 1 || !Number.isSafeInteger(expectedNewLauncherUiUnpackedSize) || expectedNewLauncherUiUnpackedSize < expectedNewLauncherUiSize) {
  console.error('Usage: EXPECTED_PUBLIC_LAUNCHER_VERSION=<version> EXPECTED_PUBLIC_LAUNCHER_UI_VERSION=<version> EXPECTED_NEW_LAUNCHER_UI_VERSION=<version> EXPECTED_NEW_LAUNCHER_UI_SHA256=<sha256> EXPECTED_NEW_LAUNCHER_UI_SIZE=<bytes> EXPECTED_NEW_LAUNCHER_UI_UNPACKED_SIZE=<bytes> node scripts/prepare-launcher-ui-hot-update.mjs <online-manifest.json> <launcher-ui.generated.json> <output-payload.json>')
  process.exit(2)
}
if (!Number.isSafeInteger(mirrorTimeoutMs) || mirrorTimeoutMs < 30_000 || mirrorTimeoutMs > 180_000) throw new Error('Launcher UI mirror timeout must be between 30000 and 180000 milliseconds')
if (outputFile !== expectedOutputFile || [path.resolve(onlineManifestPath), path.resolve(launcherUiRecordPath)].includes(outputFile)) throw new Error('Launcher UI payload output must use the fixed release path and cannot overwrite input evidence')
const temporaryOutputFile = `${outputFile}.next`
await rm(outputFile, { force: true })
await rm(temporaryOutputFile, { force: true })

const readJson = async (filePath) => JSON.parse((await readFile(path.resolve(filePath), 'utf8')).replace(/^\uFEFF/u, ''))
const baselineStat = await stat(path.resolve(onlineManifestPath))
const recordStat = await stat(path.resolve(launcherUiRecordPath))
if (!baselineStat.isFile() || baselineStat.size < 1 || baselineStat.size > 256 * 1024 || !recordStat.isFile() || recordStat.size < 1 || recordStat.size > 64 * 1024) throw new Error('Saved manifest or generated Launcher UI record is not a bounded file')
const onlineManifestBytes = await readFile(path.resolve(onlineManifestPath))
if (onlineManifestBytes.length !== baselineStat.size) throw new Error('Saved production manifest changed after preflight')
const liveFetch = await fetchBoundedBytes(productionManifestUrl, { maxBytes: 2 * 1024 * 1024, redirect: 'error', timeoutMs: 30_000 })
if (!liveFetch.response.ok || liveFetch.response.url !== productionManifestUrl) throw new Error(`Fixed production manifest returned HTTP ${liveFetch.response.status}`)
const liveManifestBytes = liveFetch.bytes
if (createHash('sha256').update(liveManifestBytes).digest('hex') !== createHash('sha256').update(onlineManifestBytes).digest('hex')) {
  throw new Error('Saved production manifest is no longer the exact live manifest')
}
const onlineManifest = JSON.parse(onlineManifestBytes.toString('utf8').replace(/^\uFEFF/u, ''))
const generatedHost = await readJson(launcherUiRecordPath)
const publicKey = createPublicKey(await readFile(path.join(repositoryRoot, 'resources', 'runtime-update-public-key.pem'), 'utf8'))

if (!verifyRuntimeCatalogManifest(onlineManifest, publicKey)) throw new Error('Current production manifest fails Launcher-equivalent signature or runtime graph validation')

const currentIds = onlineManifest.payload.runtimeModules.map((module) => module.id)
if (new Set(currentIds).size !== currentIds.length) throw new Error('Current production runtime module ids are not unique')
const currentHost = onlineManifest.payload.runtimeModules.find((module) => module.id === 'launcher-ui')
if (!currentHost) throw new Error('Current production catalog has no launcher-ui module')
if (onlineManifest.payload.launcher?.version !== expectedLauncherVersion) throw new Error('Current production launcher does not match the pinned release baseline')
if (currentHost.version !== expectedLauncherUiVersion) throw new Error('Current production Launcher UI does not match the pinned release baseline')
if (generatedHost.id !== 'launcher-ui' || !/^ui-[a-f0-9]{16}$/.test(generatedHost.version || '')) {
  throw new Error('Generated Launcher UI record is invalid')
}
if (JSON.stringify(Object.keys(generatedHost).sort()) !== JSON.stringify(['artifacts', 'dependencies', 'fileName', 'id', 'installWhen', 'required', 'treeSha256', 'version'])) throw new Error('Generated Launcher UI record contains unexpected release fields')
if (generatedHost.probe !== undefined) throw new Error('Generated Launcher UI must not define an executable probe')
if (generatedHost.version !== expectedNewLauncherUiVersion) throw new Error('Generated Launcher UI version does not match the pinned release candidate')
if (generatedHost.version === currentHost.version) throw new Error('Generated Launcher UI is not newer than production')
if (generatedHost.required !== true || generatedHost.installWhen !== 'launcher' || !Array.isArray(generatedHost.dependencies) || generatedHost.dependencies.length !== 0) {
  throw new Error('Generated Launcher UI lifecycle contract is invalid')
}
if (!Array.isArray(generatedHost.artifacts) || generatedHost.artifacts.length !== 1) {
  throw new Error('Generated Launcher UI must contain exactly one artifact')
}

const sourceArtifact = generatedHost.artifacts[0]
if (sourceArtifact.platform !== 'win32' || sourceArtifact.arch !== 'x64' || sourceArtifact.format !== 'tar.gz') {
  throw new Error('Generated Launcher UI artifact target is invalid')
}
if (!/^[a-f0-9]{64}$/.test(sourceArtifact.sha256 || '') || !Number.isSafeInteger(sourceArtifact.size) || sourceArtifact.size < 1 || sourceArtifact.size > 16 * 1024 * 1024) {
  throw new Error('Generated Launcher UI artifact digest or size is invalid')
}
if (JSON.stringify(Object.keys(sourceArtifact).sort()) !== JSON.stringify(['arch', 'format', 'mirrors', 'platform', 'sha256', 'size', 'unpackedSize']) || !Number.isSafeInteger(sourceArtifact.unpackedSize) || sourceArtifact.unpackedSize < sourceArtifact.size || sourceArtifact.unpackedSize > 2_000_000_000 || sourceArtifact.sha256 !== expectedNewLauncherUiSha256 || sourceArtifact.size !== expectedNewLauncherUiSize || sourceArtifact.unpackedSize !== expectedNewLauncherUiUnpackedSize) {
  throw new Error('Generated Launcher UI artifact does not match the pinned digest, size or unpacked-size contract')
}
const expectedFileName = `launcher-ui-${generatedHost.version}-win-x64-${sourceArtifact.sha256.slice(0, 16)}.tar.gz`
const localArchive = path.join(path.dirname(path.resolve(launcherUiRecordPath)), 'modules', expectedFileName)
if ([path.resolve(onlineManifestPath), path.resolve(launcherUiRecordPath), path.resolve(localArchive)].includes(outputFile)) throw new Error('Output payload cannot overwrite baseline, generated record or archive evidence')
const archiveStat = await stat(localArchive)
if (!archiveStat.isFile() || archiveStat.size !== sourceArtifact.size || archiveStat.size > 16 * 1024 * 1024) throw new Error('Generated Launcher UI archive changed before verification')
const localBytes = await readFile(localArchive)
if (localBytes.length !== sourceArtifact.size || createHash('sha256').update(localBytes).digest('hex') !== sourceArtifact.sha256) {
  throw new Error('Generated Launcher UI record does not match its local archive')
}

const sourceMirrors = Array.isArray(sourceArtifact.mirrors) ? sourceArtifact.mirrors : []
const sourceMirrorIds = [...new Set(sourceMirrors.map((mirror) => mirror.id))].sort()
const giteeMirror = sourceMirrors.find((mirror) => mirror.id === 'gitee')
const verifiedSourceMirrors = sourceMirrors.filter((mirror) => mirror.id === 'oss' || mirror.id === 'github')
if (sourceMirrors.length !== 3 || JSON.stringify(sourceMirrorIds) !== JSON.stringify(['gitee', 'github', 'oss']) ||
    !giteeMirror || JSON.stringify(Object.keys(giteeMirror).sort()) !== JSON.stringify(['id', 'parts', 'url']) || !Array.isArray(giteeMirror.parts) || giteeMirror.parts.length < 1 ||
    verifiedSourceMirrors.some((mirror) => JSON.stringify(Object.keys(mirror).sort()) !== JSON.stringify(['id', 'url']))) {
  throw new Error('Generated Launcher UI mirrors do not match the build contract')
}
const mirrors = ['oss', 'github'].map((id) => sourceMirrors.find((mirror) => mirror.id === id)).filter(Boolean).map((mirror) => ({ id: mirror.id, url: mirror.url }))
if (mirrors.length !== 2 || new Set(mirrors.map((mirror) => mirror.id)).size !== 2) {
  throw new Error('Launcher UI release requires exactly the verified OSS and GitHub mirrors')
}
for (const mirror of mirrors) {
  const url = new URL(mirror.url)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error(`Unsafe ${mirror.id} mirror URL`)
  const decodedPath = decodeURIComponent(url.pathname)
  if (mirror.id === 'oss' && (url.hostname !== 'ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com' || decodedPath !== `/modules/${expectedFileName}`)) {
    throw new Error('Launcher UI OSS mirror is outside the fixed bucket path')
  }
  if (mirror.id === 'github' && (url.hostname !== 'github.com' || decodedPath !== `/pingta-guangpingwang/deepblue-deepseek-harness-launcher/releases/download/launcher-ui-${generatedHost.version}/${expectedFileName}`)) {
    throw new Error('Launcher UI GitHub mirror is outside the fixed release path')
  }
  const remote = await fetchBoundedBytes(url, mirror.id === 'github'
    ? { maxBytes: sourceArtifact.size, allowedRedirectHosts: ['github.com', '.githubusercontent.com'], maxRedirects: 5, timeoutMs: mirrorTimeoutMs }
    : { maxBytes: sourceArtifact.size, redirect: 'error', timeoutMs: 30_000 })
  if (!remote.response.ok) throw new Error(`${mirror.id} Launcher UI mirror returned HTTP ${remote.response.status}`)
  const finalHost = new URL(remote.response.url).hostname
  if (mirror.id === 'oss' && finalHost !== 'ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com') throw new Error('Launcher UI OSS mirror redirected unexpectedly')
  if (mirror.id === 'github' && finalHost !== 'github.com' && !finalHost.endsWith('.githubusercontent.com')) throw new Error('Launcher UI GitHub mirror redirected outside GitHub assets')
  const bytes = remote.bytes
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (bytes.length !== sourceArtifact.size || sha256 !== sourceArtifact.sha256) {
    throw new Error(`${mirror.id} Launcher UI mirror digest mismatch`)
  }
}

if (generatedHost.fileName !== expectedFileName || !/^[a-f0-9]{64}$/.test(generatedHost.treeSha256 || '') || generatedHost.version !== 'ui-' + generatedHost.treeSha256.slice(0, 16)) throw new Error('UI tree metadata does not match its version or archive');
const replacementHost = structuredClone(generatedHost)
delete replacementHost.fileName
delete replacementHost.treeSha256
replacementHost.artifacts[0].mirrors = mirrors
const payload = structuredClone(onlineManifest.payload)
payload.generatedAt = new Date().toISOString()
const nextGeneratedAt = Date.parse(payload.generatedAt)
const currentGeneratedAt = Date.parse(onlineManifest.payload.generatedAt)
if (!Number.isFinite(nextGeneratedAt) || !Number.isFinite(currentGeneratedAt) || nextGeneratedAt <= currentGeneratedAt) throw new Error('Prepared payload timestamp must advance beyond the live catalog')
payload.runtimeModules = payload.runtimeModules.map((module) => module.id === 'launcher-ui' ? replacementHost : module)
if (!validateRuntimeModules(payload.runtimeModules)) throw new Error('Prepared payload fails Launcher-equivalent runtime graph validation')

if (payload.launcher?.version !== onlineManifest.payload.launcher?.version || JSON.stringify(payload.launcher) !== JSON.stringify(onlineManifest.payload.launcher)) {
  throw new Error('Launcher-UI-only payload changed the public launcher')
}
const changedModules = payload.runtimeModules
  .filter((module, index) => JSON.stringify(module) !== JSON.stringify(onlineManifest.payload.runtimeModules[index]))
  .map((module) => module.id)
if (changedModules.length !== 1 || changedModules[0] !== 'launcher-ui') {
  throw new Error(`Launcher-UI-only payload changed unexpected modules: ${changedModules.join(', ') || 'none'}`)
}

await writeFile(temporaryOutputFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
await rename(temporaryOutputFile, outputFile)
console.log(JSON.stringify({
  launcher: payload.launcher.version,
  fromLauncherUi: currentHost.version,
  toLauncherUi: replacementHost.version,
  mirrors: mirrors.map((mirror) => mirror.id),
  changedModules
}))
