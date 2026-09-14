// Publishes immutable 0.10.36 artifacts first; public alias and signed catalog are a separate confirmed step.
import assert from 'node:assert/strict'
import { createHash, createHmac, createPublicKey } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'
import { fetchBoundedBytes } from './bounded-fetch.mjs'
import { verifyRuntimeCatalogManifest } from './runtime-catalog-validation.mjs'

const mode = process.argv[2]
assert.ok(['check', 'artifacts', 'pointers'].includes(mode), 'Use check, artifacts or pointers')
const root = path.resolve(import.meta.dirname, '..')
const release = path.join(root, 'release')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const planBytes = await readFile(path.join(release, 'release-036-plan.json'))
assert.equal(sha(planBytes), '97570371cfb6b3bd5fdded6d43d176ce0d93ce12c2d2ecbadc766f60df567e67')
const plan = JSON.parse(planBytes)
const bucket = 'ailishishu-deepseek-harness'
const hostname = `${bucket}.oss-cn-beijing.aliyuncs.com`
const objectPath = key => `/${key.split('/').map(encodeURIComponent).join('/')}`
const publicUrl = key => `https://${hostname}${objectPath(key)}`
const catalogKey = 'release-v2/launcher-manifest.json'
const candidateBytes = await readFile(path.join(release, 'launcher-manifest.036.json'))
const candidate = JSON.parse(candidateBytes)
const beforeBytes = await readFile(path.join(release, 'launcher-manifest.before-036.json'))
const before = JSON.parse(beforeBytes)
const publicKey = createPublicKey(await readFile(path.join(root, 'resources/runtime-update-public-key.pem')))
assert.equal(sha(beforeBytes), plan.baselineSha256)
for (const value of [before, candidate]) assert.ok(verifyRuntimeCatalogManifest(value, publicKey))
assert.equal(candidate.payload.launcher.version, '0.10.36')
assert.ok(Date.parse(candidate.payload.generatedAt) > Date.parse(before.payload.generatedAt))
assert.deepEqual(candidate.payload.runtimeModules, before.payload.runtimeModules)
for (const field of Object.keys(before.payload)) if (!['generatedAt', 'launcher'].includes(field)) assert.deepEqual(candidate.payload[field], before.payload[field])
assert.deepEqual(candidate.payload.launcher.artifacts, [{ platform: 'win32', arch: 'x64', distribution: 'online', url: publicUrl(plan.alias.key), sha256: plan.alias.sha256, size: plan.alias.size }])

const bodies = new Map()
for (const item of plan.items) {
  const body = await readFile(path.join(release, item.file))
  assert.equal(body.length, item.size)
  assert.equal(sha(body), item.sha256)
  bodies.set(item.key, body)
}
const get = (key, maxBytes) => fetchBoundedBytes(publicUrl(key), { maxBytes, redirect: 'error', timeoutMs: 120_000 })
const live = await get(catalogKey, 256 * 1024)
assert.equal(live.response.status, 200)
assert.ok([plan.baselineSha256, sha(candidateBytes)].includes(sha(live.bytes)), 'Live catalog moved')
if (mode === 'check') {
  console.log(JSON.stringify({ ok: true, mode, items: plan.items.length, baselineSha256: plan.baselineSha256, candidateSha256: sha(candidateBytes) }))
  process.exit(0)
}

const profilePath = await realpath(process.env.OSS_PUBLISHER_PROFILE || '')
const outside = target => { const relative = path.relative(root, target); return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) }
assert.ok(outside(profilePath))
const profile = JSON.parse((await readFile(profilePath, 'utf8')).replace(/^\uFEFF/u, ''))
assert.deepEqual({ provider: profile.provider, region: profile.region, bucket: profile.bucket, scope: profile.scope, acl: profile.defaultObjectAcl }, { provider: 'aliyun-oss', region: 'oss-cn-beijing', bucket, scope: 'bucket-only', acl: 'public-read' })
assert.equal(new URL(profile.endpoint).href, 'https://oss-cn-beijing.aliyuncs.com/')
const credentialPath = await realpath(path.resolve(path.dirname(profilePath), profile.credentialFile))
const credential = JSON.parse((await readFile(credentialPath, 'utf8')).replace(/^\uFEFF/u, '')).AccessKey
assert.equal(credential.Status, 'Active')
assert.ok(credential.AccessKeyId && credential.AccessKeySecret)

async function put(key, body, immutable) {
  const type = key.endsWith('.json') ? 'application/json; charset=utf-8' : key.endsWith('.exe') ? 'application/vnd.microsoft.portable-executable' : 'application/octet-stream'
  const date = new Date().toUTCString()
  const md5 = createHash('md5').update(body).digest('base64')
  const ossHeaders = { ...(immutable ? { 'x-oss-forbid-overwrite': 'true' } : {}), 'x-oss-object-acl': 'public-read' }
  const canonical = Object.entries(ossHeaders).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `${name}:${value}\n`).join('')
  const signature = createHmac('sha1', credential.AccessKeySecret).update(`PUT\n${md5}\n${type}\n${date}\n${canonical}/${bucket}/${key}`).digest('base64')
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname, port: 443, method: 'PUT', path: objectPath(key), headers: { Host: hostname, Date: date, 'Content-Type': type, 'Content-Length': body.length, 'Content-MD5': md5, ...ossHeaders, Authorization: `OSS ${credential.AccessKeyId}:${signature}` } }, response => {
      response.resume()
      response.on('end', () => response.headers['x-oss-version-id'] ? reject(new Error('Versioned bucket unsupported')) : resolve(response.statusCode || 0))
    })
    request.setTimeout(20 * 60_000, () => request.destroy(new Error('OSS upload timeout')))
    request.on('error', reject)
    request.end(body)
  })
}
async function verify(key, body) {
  const response = await get(key, Math.max(4096, body.length))
  assert.equal(response.response.status, 200)
  assert.equal(response.bytes.length, body.length)
  assert.equal(sha(response.bytes), sha(body))
}
function verifyGithub(item) {
  const repository = 'pingta-guangpingwang/deepblue-deepseek-harness-launcher'
  const metadata = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/releases/tags/${item.githubTag}`], { encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024, timeout: 30_000 }))
  const asset = metadata.assets.find(row => row.name === path.basename(item.file))
  assert.ok(asset)
  assert.equal(asset.state, 'uploaded')
  assert.equal(asset.size, item.size)
  assert.equal(asset.digest, `sha256:${item.sha256}`)
}

const receipt = { mode, createdAt: new Date().toISOString(), candidateSha256: sha(candidateBytes), verified: [] }
if (mode === 'artifacts') {
  for (const item of plan.items) {
    const body = bodies.get(item.key)
    const existing = await get(item.key, Math.max(4096, item.size))
    if (existing.response.status === 404) assert.equal(await put(item.key, body, true), 200)
    else { assert.equal(existing.response.status, 200); assert.equal(sha(existing.bytes), item.sha256) }
    await verify(item.key, body)
    receipt.verified.push({ key: item.key, sha256: item.sha256, size: item.size })
    console.log(JSON.stringify(receipt.verified.at(-1)))
  }
} else {
  assert.equal(process.env.CONFIRM_RELEASE_036, 'publish-0.10.36-after-public-install-smoke')
  const gate = JSON.parse(await readFile(path.join(release, 'release-036-public-qa.json'), 'utf8'))
  assert.equal(gate.passed, true)
  assert.equal(gate.bootstrapSha256, plan.alias.sha256)
  assert.equal(gate.shellSha256, plan.items.find(item => item.file.endsWith('.7z')).sha256)
  for (const item of plan.items) { await verify(item.key, bodies.get(item.key)); verifyGithub(item) }
  const lockKey = `release-v2/locks/manifest-from-${plan.baselineSha256}.json`
  const lock = Buffer.from(`${JSON.stringify({ schemaVersion: 1, fromSha256: plan.baselineSha256, toSha256: sha(candidateBytes), launcherVersion: '0.10.36' })}\n`)
  const lockStatus = await put(lockKey, lock, true)
  assert.ok([200, 409].includes(lockStatus))
  await verify(lockKey, lock)
  const catalog = await get(catalogKey, 256 * 1024)
  assert.equal(sha(catalog.bytes), plan.baselineSha256)
  const alias = await get(plan.alias.key, 2 * 1024 * 1024)
  assert.ok([plan.previousAliasSha256, plan.alias.sha256].includes(sha(alias.bytes)))
  const onlineBody = bodies.get(plan.items.find(item => item.file === plan.alias.file).key)
  if (sha(alias.bytes) !== plan.alias.sha256) assert.equal(await put(plan.alias.key, onlineBody, false), 200)
  await verify(plan.alias.key, onlineBody)
  assert.equal(await put(catalogKey, candidateBytes, false), 200)
  await verify(catalogKey, candidateBytes)
  receipt.verified.push({ key: plan.alias.key, sha256: plan.alias.sha256 }, { key: catalogKey, sha256: sha(candidateBytes) })
}
await writeFile(path.join(release, `release-036-${mode}-receipt.json`), `${JSON.stringify(receipt, null, 2)}\n`)
console.log(JSON.stringify({ ok: true, mode, verified: receipt.verified.length }))
