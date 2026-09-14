import { createHash, createHmac, createPublicKey } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'
import { fetchBoundedBytes } from './bounded-fetch.mjs'
import { verifyRuntimeCatalogManifest } from './runtime-catalog-validation.mjs'

const [localFileArgument, objectKeyArgument] = process.argv.slice(2)
const profileArgument = process.env.OSS_PUBLISHER_PROFILE
const productionManifestUrl = 'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/release-v2/launcher-manifest.json'
const fixedBucket = 'ailishishu-deepseek-harness'
const fixedEndpoint = 'oss-cn-beijing.aliyuncs.com'
const repositoryRootPath = path.resolve(import.meta.dirname, '..')
const expectedNewLauncherUiVersion = process.env.EXPECTED_NEW_LAUNCHER_UI_VERSION
const expectedNewLauncherUiSha256 = process.env.EXPECTED_NEW_LAUNCHER_UI_SHA256
const expectedNewLauncherUiSize = Number(process.env.EXPECTED_NEW_LAUNCHER_UI_SIZE)
const expectedNewLauncherUiUnpackedSize = Number(process.env.EXPECTED_NEW_LAUNCHER_UI_UNPACKED_SIZE)
const mirrorTimeoutMs = Number(process.env.LAUNCHER_UI_MIRROR_TIMEOUT_MS || 30_000)

if (!localFileArgument || !objectKeyArgument || !profileArgument) {
  console.error('Usage: OSS_PUBLISHER_PROFILE=/secure/profile.json node scripts/publish-oss-object.mjs <local-file> <object-key>')
  process.exit(2)
}
if (!Number.isSafeInteger(mirrorTimeoutMs) || mirrorTimeoutMs < 30_000 || mirrorTimeoutMs > 180_000) throw new Error('Launcher UI mirror timeout must be between 30000 and 180000 milliseconds')

const localFile = path.resolve(localFileArgument)
const objectKey = String(objectKeyArgument).replace(/^\/+/, '')
if (!/^(?:modules\/[A-Za-z0-9+._%-]+|release-v2\/launcher-manifest\.json)$/.test(objectKey) || objectKey.includes('..')) throw new Error('OSS object key is outside the fixed runtime release paths')
const metadata = await stat(localFile)
const maximumInputBytes = objectKey.endsWith('.json') ? 256 * 1024 : 16 * 1024 * 1024
if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumInputBytes) throw new Error('OSS upload source is not a bounded release file')

const repositoryRoot = await realpath(path.resolve(import.meta.dirname, '..'))
const isInsideRepository = (target) => {
  const relative = path.relative(repositoryRoot, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
const exactKeys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => allowed.has(key))

const profilePath = await realpath(path.resolve(profileArgument))
if (isInsideRepository(profilePath)) throw new Error('OSS publisher profile must stay outside the repository')
const profile = JSON.parse((await readFile(profilePath, 'utf8')).replace(/^\uFEFF/u, ''))
const profileKeys = new Set(['profile', 'provider', 'endpoint', 'region', 'bucket', 'credentialFile', 'defaultObjectAcl', 'scope'])
if (!exactKeys(profile, profileKeys) || typeof profile.profile !== 'string' || typeof profile.credentialFile !== 'string' || profile.provider !== 'aliyun-oss' || profile.region !== 'oss-cn-beijing' || profile.scope !== 'bucket-only' || profile.defaultObjectAcl !== 'public-read') throw new Error('OSS publisher profile has an unsupported policy or inline fields')
const endpoint = new URL(profile.endpoint)
if (endpoint.protocol !== 'https:' || endpoint.hostname !== fixedEndpoint || endpoint.port || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('OSS publisher endpoint is invalid')
if (profile.bucket !== fixedBucket) throw new Error('OSS publisher bucket is not the fixed runtime bucket')

const profileDirectory = path.dirname(profilePath)
const credentialPath = await realpath(path.resolve(profileDirectory, profile.credentialFile || ''))
const relativeCredential = path.relative(profileDirectory, credentialPath)
if (!relativeCredential || relativeCredential.startsWith(`..${path.sep}`) || relativeCredential === '..' || path.isAbsolute(relativeCredential) || isInsideRepository(credentialPath)) throw new Error('OSS credential file must stay beside the external publisher profile')
const credentialDocument = JSON.parse((await readFile(credentialPath, 'utf8')).replace(/^\uFEFF/u, ''))
const credentialKeys = new Set(['AccessKey', 'RequestId'])
const accessKeyKeys = new Set(['AccessKeyId', 'AccessKeySecret', 'CreateDate', 'Status'])
const credential = credentialDocument.AccessKey
if (!exactKeys(credentialDocument, credentialKeys) || !exactKeys(credential, accessKeyKeys) || credential.Status !== 'Active' || typeof credential.AccessKeyId !== 'string' || typeof credential.AccessKeySecret !== 'string' || !credential.AccessKeyId || !credential.AccessKeySecret) throw new Error('OSS publisher credential is incomplete or has unexpected fields')

const bytes = await readFile(localFile)
if (bytes.length !== metadata.size || bytes.length > maximumInputBytes) throw new Error('OSS upload source changed after preflight')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const contentType = objectKey.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/gzip'
const hostname = `${fixedBucket}.${fixedEndpoint}`
const encodeObjectPath = (key) => '/' + key.split('/').map((segment) => encodeURIComponent(segment)).join('/')
const publicUrlFor = (key) => new URL(encodeObjectPath(key), `https://${hostname}`).href

const capabilityProbeKey = 'release-v2/locks/forbid-overwrite-capability-v1.json'
const capabilityProbeBytes = Buffer.from('{"schemaVersion":1,"purpose":"verify x-oss-forbid-overwrite before runtime publication"}\n', 'utf8')
const putCapabilityProbe = () => new Promise((resolve, reject) => {
  const date = new Date().toUTCString()
  const contentType = 'application/json; charset=utf-8'
  const contentMd5 = createHash('md5').update(capabilityProbeBytes).digest('base64')
  const canonicalHeaders = 'x-oss-forbid-overwrite:true\nx-oss-object-acl:public-read\n'
  const signature = createHmac('sha1', credential.AccessKeySecret).update(`PUT\n${contentMd5}\n${contentType}\n${date}\n${canonicalHeaders}/${fixedBucket}/${capabilityProbeKey}`).digest('base64')
  const request = https.request({
    protocol: 'https:', hostname, port: 443, method: 'PUT', path: encodeObjectPath(capabilityProbeKey),
    headers: { Host: hostname, Date: date, 'Content-Type': contentType, 'Content-Length': capabilityProbeBytes.length, 'Content-MD5': contentMd5, 'x-oss-forbid-overwrite': 'true', 'x-oss-object-acl': 'public-read', Authorization: `OSS ${credential.AccessKeyId}:${signature}` }
  }, (response) => {
    response.resume()
    response.on('end', () => resolve({ statusCode: response.statusCode || 0, versionId: response.headers['x-oss-version-id'] || '' }))
  })
  request.setTimeout(30_000, () => request.destroy(new Error('OSS forbid-overwrite capability probe timed out')))
  request.on('error', reject)
  request.end(capabilityProbeBytes)
})

const verifyForbidOverwrite = async () => {
  let existing = await fetchBoundedBytes(publicUrlFor(capabilityProbeKey), { maxBytes: 4096, redirect: 'error', timeoutMs: 30_000 })
  if (existing.response.status === 404) {
    const created = await putCapabilityProbe()
    if (created.versionId) throw new Error('OSS bucket returned a version id; immutable release keys are not safe')
    if (created.statusCode !== 200 && created.statusCode !== 409) throw new Error(`OSS forbid-overwrite capability probe creation returned HTTP ${created.statusCode}`)
    existing = await fetchBoundedBytes(publicUrlFor(capabilityProbeKey), { maxBytes: 4096, redirect: 'error', timeoutMs: 30_000 })
  }
  if (!existing.response.ok || existing.bytes.length !== capabilityProbeBytes.length || createHash('sha256').update(existing.bytes).digest('hex') !== createHash('sha256').update(capabilityProbeBytes).digest('hex')) throw new Error('OSS forbid-overwrite capability object is missing or changed')
  const blocked = await putCapabilityProbe()
  if (blocked.statusCode !== 409 || blocked.versionId) throw new Error('OSS x-oss-forbid-overwrite is not enforced; release locks and immutable modules are unsafe')
}

const readSignedManifest = async (body, label) => {
  let manifest
  try { manifest = JSON.parse(body.toString('utf8').replace(/^\uFEFF/u, '')) }
  catch { throw new Error(`${label} is not valid JSON`) }
  const publicKey = createPublicKey(await readFile(path.join(repositoryRootPath, 'resources', 'runtime-update-public-key.pem'), 'utf8'))
  if (!verifyRuntimeCatalogManifest(manifest, publicKey)) throw new Error(`${label} fails Launcher-equivalent signature or runtime graph validation`)
  return manifest
}

const pinnedNewHost = (payload, label) => {
  if (!expectedNewLauncherUiVersion || !/^[a-f0-9]{64}$/.test(expectedNewLauncherUiSha256 || '') || !Number.isSafeInteger(expectedNewLauncherUiSize) || expectedNewLauncherUiSize < 1 || !Number.isSafeInteger(expectedNewLauncherUiUnpackedSize) || expectedNewLauncherUiUnpackedSize < expectedNewLauncherUiSize) throw new Error(`${label} requires a pinned new Launcher UI version, digest and sizes`)
  const host = payload.runtimeModules.find((module) => module.id === 'launcher-ui')
  const artifact = host?.artifacts?.find((candidate) => candidate.platform === 'win32' && candidate.arch === 'x64')
  const expectedFileName = `launcher-ui-${expectedNewLauncherUiVersion}-win-x64-${expectedNewLauncherUiSha256.slice(0, 16)}.tar.gz`
  const mirrorIds = artifact?.mirrors?.map((mirror) => mirror.id)
  const mirrorUrls = artifact?.mirrors?.map((mirror) => new URL(mirror.url)) || []
  const decodedPaths = mirrorUrls.map((url) => decodeURIComponent(url.pathname))
  if (host?.version !== expectedNewLauncherUiVersion || host.required !== true || host.installWhen !== 'launcher' || !Array.isArray(host.dependencies) || host.dependencies.length !== 0 || host.probe !== undefined || !Array.isArray(host.artifacts) || host.artifacts.length !== 1 || JSON.stringify(Object.keys(host || {}).sort()) !== JSON.stringify(['artifacts', 'dependencies', 'id', 'installWhen', 'required', 'version']) || artifact?.platform !== 'win32' || artifact?.arch !== 'x64' || artifact?.format !== 'tar.gz' || artifact?.sha256 !== expectedNewLauncherUiSha256 || artifact?.size !== expectedNewLauncherUiSize || artifact?.unpackedSize !== expectedNewLauncherUiUnpackedSize || JSON.stringify(Object.keys(artifact || {}).sort()) !== JSON.stringify(['arch', 'format', 'mirrors', 'platform', 'sha256', 'size', 'unpackedSize']) || JSON.stringify(mirrorIds) !== JSON.stringify(['oss', 'github']) || artifact.mirrors.some((mirror) => JSON.stringify(Object.keys(mirror).sort()) !== JSON.stringify(['id', 'url'])) || mirrorUrls.some((url) => url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) || mirrorUrls[0]?.hostname !== hostname || mirrorUrls[1]?.hostname !== 'github.com' || decodedPaths[0] !== `/modules/${expectedFileName}` || decodedPaths[1] !== `/pingta-guangpingwang/deepblue-deepseek-harness-launcher/releases/download/launcher-ui-${expectedNewLauncherUiVersion}/${expectedFileName}`) throw new Error(`${label} Launcher UI does not match the pinned canonical release`)
  return { host, artifact }
}

const verifyPinnedMirrors = async (artifact) => {
  for (const mirror of artifact.mirrors) {
    const remote = await fetchBoundedBytes(mirror.url, mirror.id === 'github'
      ? { maxBytes: expectedNewLauncherUiSize, allowedRedirectHosts: ['github.com', '.githubusercontent.com'], maxRedirects: 5, timeoutMs: mirrorTimeoutMs }
      : { maxBytes: expectedNewLauncherUiSize, redirect: 'error', timeoutMs: 30_000 })
    if (!remote.response.ok) throw new Error(`${mirror.id} Launcher UI mirror returned HTTP ${remote.response.status}`)
    const finalHost = new URL(remote.response.url).hostname
    if (mirror.id === 'oss' && finalHost !== hostname) throw new Error('Launcher UI OSS mirror redirected unexpectedly')
    if (mirror.id === 'github' && finalHost !== 'github.com' && !finalHost.endsWith('.githubusercontent.com')) throw new Error('Launcher UI GitHub mirror redirected outside GitHub assets')
    if (remote.bytes.length !== expectedNewLauncherUiSize || createHash('sha256').update(remote.bytes).digest('hex') !== expectedNewLauncherUiSha256) throw new Error(`${mirror.id} Launcher UI mirror digest mismatch during manifest publication`)
  }
}

if (objectKey.startsWith('modules/')) {
  if (objectKey !== `modules/launcher-ui-${expectedNewLauncherUiVersion}-win-x64-${expectedNewLauncherUiSha256.slice(0, 16)}.tar.gz` || sha256 !== expectedNewLauncherUiSha256 || bytes.length !== expectedNewLauncherUiSize) throw new Error('Launcher UI object does not match the pinned new release version, digest and size')
  const existing = await fetchBoundedBytes(publicUrlFor(objectKey), { maxBytes: bytes.length, redirect: 'error', timeoutMs: 30_000 })
  if (existing.response.ok) {
    if (existing.bytes.length !== bytes.length || createHash('sha256').update(existing.bytes).digest('hex') !== sha256) throw new Error('Content-addressed OSS object already exists with different bytes')
    console.log(JSON.stringify({ objectKey, bytes: bytes.length, sha256, publicUrl: publicUrlFor(objectKey), anonymousVerified: true, alreadyPublished: true }))
    process.exit(0)
  }
  if (existing.response.status !== 404) throw new Error(`Content-addressed OSS preflight returned HTTP ${existing.response.status}`)
}

let manifestPublication
if (objectKey === 'release-v2/launcher-manifest.json') {
  const expectedLauncherVersion = process.env.EXPECTED_PUBLIC_LAUNCHER_VERSION
  const expectedLauncherUiVersion = process.env.EXPECTED_PUBLIC_LAUNCHER_UI_VERSION
  if (!expectedLauncherVersion || !expectedLauncherUiVersion) throw new Error('Manifest publication requires pinned public Launcher and Launcher UI versions')
  const candidate = await readSignedManifest(bytes, 'Candidate production manifest')
  const candidateHost = pinnedNewHost(candidate.payload, 'Candidate production manifest')
  await verifyPinnedMirrors(candidateHost.artifact)
  const currentFetch = await fetchBoundedBytes(productionManifestUrl, { maxBytes: 2 * 1024 * 1024, redirect: 'error', timeoutMs: 30_000 })
  if (!currentFetch.response.ok || currentFetch.response.url !== productionManifestUrl) throw new Error(`Fixed production manifest returned HTTP ${currentFetch.response.status}`)
  const current = await readSignedManifest(currentFetch.bytes, 'Current production manifest')
  const currentSha256 = createHash('sha256').update(currentFetch.bytes).digest('hex')
  if (current.payload.launcher?.version !== expectedLauncherVersion) throw new Error('Current production Launcher no longer matches the pinned release baseline')
  if (currentSha256 === sha256) {
    pinnedNewHost(current.payload, 'Already-published production manifest')
    console.log(JSON.stringify({ objectKey, bytes: bytes.length, sha256, publicUrl: productionManifestUrl, anonymousVerified: true, alreadyPublished: true }))
    process.exit(0)
  }
  const candidateGeneratedAt = Date.parse(candidate.payload.generatedAt)
  const currentGeneratedAt = Date.parse(current.payload.generatedAt)
  if (!Number.isFinite(candidateGeneratedAt) || !Number.isFinite(currentGeneratedAt) || candidateGeneratedAt <= currentGeneratedAt) throw new Error('Candidate production manifest timestamp does not advance beyond the live catalog')
  const currentHost = current.payload.runtimeModules.find((module) => module.id === 'launcher-ui')
  if (currentHost?.version !== expectedLauncherUiVersion) throw new Error('Current production Launcher UI no longer matches the pinned release baseline')
  if (JSON.stringify(candidate.payload.launcher) !== JSON.stringify(current.payload.launcher)) throw new Error('Candidate manifest changes the public launcher')
  const currentKeys = Object.keys(current.payload).sort()
  const candidateKeys = Object.keys(candidate.payload).sort()
  if (JSON.stringify(currentKeys) !== JSON.stringify(candidateKeys)) throw new Error('Candidate manifest changes top-level catalog fields')
  for (const key of currentKeys) {
    if (key === 'generatedAt' || key === 'runtimeModules') continue
    if (JSON.stringify(candidate.payload[key]) !== JSON.stringify(current.payload[key])) throw new Error(`Candidate manifest changes ${key}`)
  }
  if (candidate.payload.runtimeModules.length !== current.payload.runtimeModules.length) throw new Error('Candidate manifest changes the runtime module set')
  const changed = candidate.payload.runtimeModules.filter((module, index) => JSON.stringify(module) !== JSON.stringify(current.payload.runtimeModules[index])).map((module) => module.id)
  if (changed.length !== 1 || changed[0] !== 'launcher-ui') throw new Error(`Candidate manifest changes unexpected modules: ${changed.join(', ') || 'none'}`)
  manifestPublication = { currentSha256, candidateSha256: sha256 }
}

const putObject = (key, body, type, { acl = 'public-read', forbidOverwrite = false } = {}) => new Promise((resolve, reject) => {
  const contentMd5 = createHash('md5').update(body).digest('base64')
  const date = new Date().toUTCString()
  const ossHeaders = { ...(forbidOverwrite ? { 'x-oss-forbid-overwrite': 'true' } : {}), 'x-oss-object-acl': acl }
  const canonicalHeaders = Object.entries(ossHeaders).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `${name}:${value}\n`).join('')
  const canonicalResource = `/${fixedBucket}/${key}`
  const stringToSign = `PUT\n${contentMd5}\n${type}\n${date}\n${canonicalHeaders}${canonicalResource}`
  const signature = createHmac('sha1', credential.AccessKeySecret).update(stringToSign).digest('base64')
  const request = https.request({
    protocol: 'https:', hostname, port: 443, method: 'PUT', path: encodeObjectPath(key),
    headers: { Host: hostname, Date: date, 'Content-Type': type, 'Content-Length': body.length, 'Content-MD5': contentMd5, ...ossHeaders, Authorization: `OSS ${credential.AccessKeyId}:${signature}` }
  }, (response) => {
    response.resume()
    response.on('end', () => {
      if (response.statusCode === 200 && response.headers['x-oss-version-id']) return reject(new Error('OSS bucket returned a version id; release lock guarantees are no longer valid'))
      return response.statusCode === 200 ? resolve(response) : reject(Object.assign(new Error(`OSS PUT failed with HTTP ${response.statusCode || 0}; requestId=${response.headers['x-oss-request-id'] || 'unavailable'}`), { statusCode: response.statusCode }))
    })
  })
  request.setTimeout(60_000, () => request.destroy(new Error('OSS PUT timed out')))
  request.on('error', reject)
  request.end(body)
})

await verifyForbidOverwrite()

if (manifestPublication) {
  const lockKey = `release-v2/locks/manifest-from-${manifestPublication.currentSha256}.json`
  const lockBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, fromSha256: manifestPublication.currentSha256, toSha256: manifestPublication.candidateSha256, launcherUiVersion: expectedNewLauncherUiVersion })}\n`, 'utf8')
  try {
    await putObject(lockKey, lockBytes, 'application/json; charset=utf-8', { acl: 'public-read', forbidOverwrite: true })
  } catch (error) {
    if (error.statusCode === 409) {
      const existingLock = await fetchBoundedBytes(publicUrlFor(lockKey), { maxBytes: 4096, redirect: 'error', timeoutMs: 30_000 })
      if (!existingLock.response.ok || existingLock.bytes.length !== lockBytes.length || createHash('sha256').update(existingLock.bytes).digest('hex') !== createHash('sha256').update(lockBytes).digest('hex')) throw new Error('Production manifest release claim belongs to a different candidate')
    } else {
      throw error
    }
  }
  const recheck = await fetchBoundedBytes(productionManifestUrl, { maxBytes: 2 * 1024 * 1024, redirect: 'error', timeoutMs: 30_000 })
  const recheckSha256 = createHash('sha256').update(recheck.bytes).digest('hex')
  if (recheck.response.ok && recheckSha256 === manifestPublication.candidateSha256) {
    console.log(JSON.stringify({ objectKey, bytes: bytes.length, sha256, publicUrl: productionManifestUrl, anonymousVerified: true, alreadyPublished: true }))
    process.exit(0)
  }
  if (!recheck.response.ok || recheckSha256 !== manifestPublication.currentSha256) throw new Error('Production manifest changed after the single-writer release claim')
}

await putObject(objectKey, bytes, contentType, { forbidOverwrite: objectKey.startsWith('modules/') })
const verification = await fetchBoundedBytes(publicUrlFor(objectKey), { maxBytes: bytes.length, redirect: 'error', timeoutMs: 30_000 })
if (!verification.response.ok || verification.bytes.length !== bytes.length || createHash('sha256').update(verification.bytes).digest('hex') !== sha256) throw new Error('Anonymous OSS verification failed or returned different bytes')
if (objectKey === 'release-v2/launcher-manifest.json') await readSignedManifest(verification.bytes, 'Published production manifest')

console.log(JSON.stringify({ objectKey, bytes: bytes.length, sha256, publicUrl: publicUrlFor(objectKey), anonymousVerified: true, alreadyPublished: false }))
