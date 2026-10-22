// Execute only after controller approval. `check` never reads credentials.
// `channel` intentionally precedes public-install QA and the two legacy pointers.
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'
import { fetchReleaseArtifact } from './release-artifact-fetch.mjs'
import { loadBundledReleaseMetadata } from './bundled-release-metadata.mjs'
import {
  ROOT, RELEASE, VERSION, DSH_VERSION, BUCKET, HOSTNAME, REPOSITORY, LEGACY_KEY, ALPHA_KEY, CHANNEL_KEY,
  ALIAS_KEY, SOURCE_ID, REPLACED_IDS, objectPath, publicUrl, sha, parseJson, jsonBytes,
  releaseFile, fileDigest, trustedManifest, replacementItem, assertPayloadPair, assertAlphaAnnouncement, pointerState, assertPublicQa, assertGithubReadback, exactKeys
} from './release-040-qa.mjs'

const mode = process.argv[2]
assert.ok(['check', 'stage', 'artifacts', 'channel', 'pointers'].includes(mode), 'Use check, stage, artifacts, channel or pointers')
const expectedPlanSha256 = process.env.EXPECTED_RELEASE_040_PLAN_SHA256
assert.match(expectedPlanSha256 || '', /^[a-f0-9]{64}$/u, 'Supply the reviewed plan SHA256, not a source-code hardcoded digest')
const planBytes = await readFile(await releaseFile('release-040-plan.json', 256 * 1024))
const planSha256 = sha(planBytes)
assert.equal(planSha256, expectedPlanSha256, 'Plan changed after controller review')
const plan = parseJson(planBytes)
assert.equal(plan.schemaVersion, 1)
assert.equal(plan.version, VERSION)
assert.equal(plan.dshVersion, DSH_VERSION)
assert.equal(plan.policy, 'legacy-alpha2-preserved-rc2-ui-only-040-v1')
assert.deepEqual(plan.source, { id: SOURCE_ID, url: publicUrl(CHANNEL_KEY) })
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim(), plan.sourceCommit, 'Release source HEAD moved')
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim(), '', 'Release source is dirty')
assert.equal(plan.baselines.legacy.key, LEGACY_KEY)
assert.equal(plan.baselines.channel.key, CHANNEL_KEY)
assert.equal(plan.baselines.alias.key, ALIAS_KEY)
assert.equal(plan.alias.key, ALIAS_KEY)
assert.equal(plan.baselines.legacy.file, 'launcher-manifest.before-040.legacy.json')
assert.equal(plan.baselines.alias.file, 'launcher-online.before-040.exe')
assert.equal(plan.baselines.legacy.status, 200)
assert.equal(plan.baselines.alias.status, 200)
assert.ok([200, 404].includes(plan.baselines.channel.status))
assert.equal(plan.qaFile, 'release-040-public-qa.json')
for (const [role, basename] of [['legacy', 'legacy'], ['channel', 'dsh02']]) {
  assert.equal(plan.payloads[role].file, `launcher-catalog-040-${basename}-payload.json`)
  assert.equal(plan.payloads[role].signedFile, `launcher-manifest.040.${basename}.json`)
}
const beforeBytes = await readFile(await releaseFile(plan.baselines.legacy.file, 256 * 1024))
assert.equal(sha(beforeBytes), plan.baselines.legacy.sha256)
const before = await trustedManifest(beforeBytes)
assert.equal(before.payload.launcher.version, '0.10.39')
assert.equal(before.payload.runtimeModules.find(module => module.id === 'harness-core').version, '0.1.1-rc.2')
const oldAliasBytes = await readFile(await releaseFile(plan.baselines.alias.file, 4 * 1024 * 1024))
assert.equal(sha(oldAliasBytes), plan.baselines.alias.sha256)
assert.equal(oldAliasBytes.length, plan.baselines.alias.size)
assert.equal(plan.baselines.channel.status, 200)
let rcBefore
if (plan.baselines.channel.status === 200) {
  assert.equal(plan.baselines.channel.file, 'launcher-manifest.before-040.dsh02.json')
  const bytes = await readFile(await releaseFile(plan.baselines.channel.file, 256 * 1024))
  assert.equal(sha(bytes), plan.baselines.channel.sha256)
  rcBefore = await trustedManifest(bytes)
} else exactKeys(plan.baselines.channel, ['key', 'status'])

const candidates = {}
for (const role of ['legacy', 'channel']) {
  const payloadBytes = await readFile(await releaseFile(plan.payloads[role].file, 256 * 1024))
  assert.equal(sha(payloadBytes), plan.payloads[role].sha256)
  const bytes = await readFile(await releaseFile(plan.payloads[role].signedFile, 256 * 1024))
  const manifest = await trustedManifest(bytes)
  assert.deepEqual(manifest.payload, parseJson(payloadBytes), 'Signed candidate differs from reviewed payload')
  candidates[role] = { bytes, manifest, sha256: sha(bytes) }
}
const alphaPlan = plan.alphaAnnouncement
assert.equal(alphaPlan.key, ALPHA_KEY)
assert.equal(alphaPlan.baseline.file, 'launcher-manifest.before-040.alpha2.json')
assert.equal(alphaPlan.payload.file, 'launcher-catalog-040-alpha2-payload.json')
assert.equal(alphaPlan.payload.signedFile, 'launcher-manifest.040.alpha2.json')
const alphaBeforeBytes = await readFile(await releaseFile(alphaPlan.baseline.file, 256 * 1024))
assert.equal(sha(alphaBeforeBytes), alphaPlan.baseline.sha256)
const alphaBefore = await trustedManifest(alphaBeforeBytes)
assert.equal(alphaBefore.payload.launcher.version, '0.10.39')
const alphaPayloadBytes = await readFile(await releaseFile(alphaPlan.payload.file, 256 * 1024))
assert.equal(sha(alphaPayloadBytes), alphaPlan.payload.sha256)
const alphaBytes = await readFile(await releaseFile(alphaPlan.payload.signedFile, 256 * 1024))
const alphaManifest = await trustedManifest(alphaBytes)
assert.deepEqual(alphaManifest.payload, parseJson(alphaPayloadBytes))
candidates.alpha = { bytes: alphaBytes, manifest: alphaManifest, sha256: sha(alphaBytes) }
assertPayloadPair(before.payload, candidates.legacy.manifest.payload, candidates.channel.manifest.payload, plan.alias, alphaBefore.payload, await loadBundledReleaseMetadata(), rcBefore.payload, plan.items.find(item => item.role === 'offline'))
assertAlphaAnnouncement(alphaBefore.payload, candidates.alpha.manifest.payload, candidates.legacy.manifest.payload)
assert.equal(plan.items.length, 4)
assert.deepEqual(plan.items.map(item => item.role).sort(), ['shell', 'online', 'offline', ...REPLACED_IDS].sort())
assert.equal(new Set(plan.items.map(item => item.key)).size, plan.items.length)
for (const item of plan.items) {
  exactKeys(item, ['role', 'key', 'file', 'githubTag', 'sha256', 'size'])
  assert.match(item.key, /^(?:modules|download)\/[0-9A-Za-z+._-]+$/u)
  assert.ok(!item.key.includes('..'))
  assert.match(item.githubTag, /^[0-9A-Za-z+._-]+$/u)
  const file = await releaseFile(item.file)
  assert.deepEqual(await fileDigest(file), { sha256: item.sha256, size: item.size }, `Artifact changed: ${item.role}`)
}
for (const module of candidates.channel.manifest.payload.runtimeModules.filter(item => REPLACED_IDS.includes(item.id))) {
  assert.deepEqual(plan.items.find(item => item.role === module.id), replacementItem(module), 'Approved item and advertised module must be identical')
}
const shellItem = plan.items.find(item => item.role === 'shell')
assert.equal(shellItem.file, `launcher-shell-${VERSION}-win-x64-${shellItem.sha256.slice(0, 16)}.7z`)
assert.equal(shellItem.key, `modules/${shellItem.file}`)
assert.equal(shellItem.githubTag, `runtime-v${VERSION}`)
for (const role of ['online', 'offline']) {
  const item = plan.items.find(candidate => candidate.role === role)
  assert.equal(item.file, `deepblue-deepseek-harness-launcher-${VERSION}-win-x64-${role}.exe`)
  assert.equal(item.key, `download/${item.file}`)
  assert.equal(item.githubTag, `v${VERSION}`)
}
const onlineItem = plan.items.find(item => item.role === 'online')
assert.deepEqual(plan.alias, { key: ALIAS_KEY, file: onlineItem.file, sha256: onlineItem.sha256, size: onlineItem.size })
assert.deepEqual(plan.inputs.map(input => input.file).sort(), ['launcher-shell.generated.json', 'windows-artifacts.json', 'runtime-modules.generated.json', 'launcher-ui.generated.json', 'win-unpacked/resources/resources/runtime-modules.generated.json'].sort())
for (const input of plan.inputs) {
  const relative = input.file
  let file
  if (relative === 'win-unpacked/resources/resources/runtime-modules.generated.json') {
    file = path.join(RELEASE, relative)
    const info = await lstat(file)
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 256 * 1024)
    assert.equal(await realpath(file), file, 'Packaged fallback cannot be a junction or symlink')
  } else file = await releaseFile(relative, 256 * 1024)
  assert.equal(sha(await readFile(file)), input.sha256, `Build metadata changed: ${relative}`)
}

async function get(key, maxBytes = 256 * 1024) {
  const response = await fetchReleaseArtifact(publicUrl(key), { maxBytes, redirect: 'error', timeoutMs: 120_000 })
  assert.ok(!response.response.headers.get('x-oss-version-id'), 'Versioned bucket unsupported by release policy')
  return { ...response, status: response.response.status, sha256: sha(response.bytes) }
}
async function states() {
  const legacy = await get(LEGACY_KEY)
  const channel = await get(CHANNEL_KEY)
  const alpha = await get(ALPHA_KEY)
  const alias = await get(ALIAS_KEY, 4 * 1024 * 1024)
  return {
    alpha: pointerState(alpha, alphaPlan.baseline, candidates.alpha.sha256),
    legacy: pointerState(legacy, plan.baselines.legacy, candidates.legacy.sha256),
    channel: pointerState(channel, plan.baselines.channel, candidates.channel.sha256),
    alias: pointerState(alias, plan.baselines.alias, plan.alias.sha256)
  }
}
const initialState = await states()
if (initialState.legacy === 'candidate') {
  assert.equal(initialState.channel, 'candidate', 'Legacy launcher entry published before new channel')
  assert.equal(initialState.alias, 'candidate', 'Legacy catalog hash and installer alias diverged')
}
if (mode === 'check') {
  console.log(JSON.stringify({ ok: true, mode, planSha256, candidateSha256: { legacy: candidates.legacy.sha256, channel: candidates.channel.sha256 }, state: initialState, sourceCommit: plan.sourceCommit, items: plan.items }, null, 2))
  process.exit(0)
}
assert.equal(process.env.CONFIRM_RELEASE_040, `publish-0.10.40-${mode}`, 'Explicit stage confirmation required')

// Credentials are read only below this point, never in check/preparation/QA.
const outside = target => { const relative = path.relative(ROOT, target); return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) }
assert.ok(process.env.OSS_PUBLISHER_PROFILE, 'External OSS profile location required')
const profilePath = await realpath(process.env.OSS_PUBLISHER_PROFILE)
assert.ok(outside(profilePath), 'Publisher profile must stay outside repository')
const profile = parseJson(await readFile(profilePath))
exactKeys(profile, ['profile', 'provider', 'endpoint', 'region', 'bucket', 'credentialFile', 'defaultObjectAcl', 'scope'])
assert.deepEqual({ provider: profile.provider, region: profile.region, bucket: profile.bucket, scope: profile.scope, acl: profile.defaultObjectAcl }, { provider: 'aliyun-oss', region: 'oss-cn-beijing', bucket: BUCKET, scope: 'bucket-only', acl: 'public-read' })
let safeEndpoint = false
try { safeEndpoint = new URL(profile.endpoint).href === 'https://oss-cn-beijing.aliyuncs.com/' } catch { /* Do not include malformed private profile values in errors. */ }
assert.ok(safeEndpoint, 'Publisher endpoint is outside the fixed OSS endpoint')
const profileDirectory = path.dirname(profilePath)
const credentialPath = await realpath(path.resolve(profileDirectory, profile.credentialFile))
const credentialRelative = path.relative(profileDirectory, credentialPath)
assert.ok(credentialRelative && credentialRelative !== '..' && !credentialRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(credentialRelative) && outside(credentialPath), 'Credentials must be beside the external profile')
const credentialDocument = parseJson(await readFile(credentialPath))
exactKeys(credentialDocument, ['AccessKey', 'RequestId'])
const credential = credentialDocument.AccessKey
exactKeys(credential, ['AccessKeyId', 'AccessKeySecret', 'CreateDate', 'Status'])
assert.equal(credential.Status, 'Active')
assert.ok(typeof credential.AccessKeyId === 'string' && credential.AccessKeyId && typeof credential.AccessKeySecret === 'string' && credential.AccessKeySecret)

async function put(key, body, immutable) {
  const allowed = new Set([LEGACY_KEY, ALPHA_KEY, CHANNEL_KEY, ALIAS_KEY, ...plan.items.map(item => item.key)])
  assert.ok(allowed.has(key) || /^release-v2\/locks\/(?:manifest-from-|dsh021rc-from-|alpha-announcement-from-)[a-f0-9]{64}\.json$/u.test(key) || key === 'release-v2/locks/forbid-overwrite-capability-v1.json', 'Write target outside approved plan')
  const type = key.endsWith('.json') ? 'application/json; charset=utf-8' : key.endsWith('.exe') ? 'application/vnd.microsoft.portable-executable' : 'application/octet-stream'
  const date = new Date().toUTCString()
  const md5 = createHash('md5').update(body).digest('base64')
  const ossHeaders = { ...(immutable ? { 'x-oss-forbid-overwrite': 'true' } : {}), 'x-oss-object-acl': 'public-read' }
  const canonical = Object.entries(ossHeaders).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `${name}:${value}\n`).join('')
  const signature = createHmac('sha1', credential.AccessKeySecret).update(`PUT\n${md5}\n${type}\n${date}\n${canonical}/${BUCKET}/${key}`).digest('base64')
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname: HOSTNAME, port: 443, method: 'PUT', path: objectPath(key), headers: {
      Host: HOSTNAME, Date: date, 'Content-Type': type, 'Content-Length': body.length, 'Content-MD5': md5,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...ossHeaders, Authorization: `OSS ${credential.AccessKeyId}:${signature}`
    } }, response => {
      response.resume()
      response.on('end', () => response.headers['x-oss-version-id'] ? reject(new Error('Versioned bucket unsupported')) : resolve(response.statusCode || 0))
    })
    request.setTimeout(20 * 60_000, () => request.destroy(new Error('OSS upload timeout')))
    request.on('error', error => reject(new Error(`OSS request failed (${error.code || 'transport'})`)))
    request.end(body)
  })
}
async function verifyObject(key, expected) {
  const response = await get(key, Math.max(4096, expected.size))
  assert.ok([200, 206].includes(response.status), `Public object unavailable: ${key}`)
  assert.equal(response.bytes.length, expected.size, `Public size mismatch: ${key}`)
  assert.equal(response.sha256, expected.sha256, `Public hash mismatch: ${key}`)
}
async function immutable(key, body) {
  const existing = await get(key, Math.max(4096, body.length))
  if (existing.status === 404) assert.ok([200, 409].includes(await put(key, body, true)), 'Immutable upload failed')
  else {
    assert.ok([200, 206].includes(existing.status))
    assert.equal(existing.sha256, sha(body), 'Existing immutable object differs; never overwrite')
    assert.equal(existing.bytes.length, body.length)
    return // The existing object has already been read completely and hashed.
  }
  await verifyObject(key, { size: body.length, sha256: sha(body) })
}
async function capability() {
  const key = 'release-v2/locks/forbid-overwrite-capability-v1.json'
  const bytes = Buffer.from('{"schemaVersion":1,"purpose":"verify x-oss-forbid-overwrite before runtime publication"}\n')
  await immutable(key, bytes)
  assert.equal(await put(key, bytes, true), 409, 'OSS overwrite prevention is not enforced')
}
async function claims() {
  // Cooperative compare-and-swap: OSS PutObject does not promise destination
  // If-Match CAS. All approved writers must honor these immutable baseline
  // claims; exact public hashes are rechecked immediately before each write.
  const body = jsonBytes({ schemaVersion: 1, fromSha256: plan.baselines.legacy.sha256, toSha256: candidates.legacy.sha256, launcherVersion: VERSION, planSha256, channelFrom: plan.baselines.channel.status === 404 ? 'absent' : plan.baselines.channel.sha256, channelToSha256: candidates.channel.sha256, alphaFromSha256: alphaPlan.baseline.sha256, alphaToSha256: candidates.alpha.sha256, aliasToSha256: plan.alias.sha256 })
  await immutable(`release-v2/locks/manifest-from-${plan.baselines.legacy.sha256}.json`, body)
  await immutable(`release-v2/locks/dsh021rc-from-${plan.baselines.channel.status === 404 ? sha(Buffer.from('absent')) : plan.baselines.channel.sha256}.json`, body)
  await immutable(`release-v2/locks/alpha-announcement-from-${alphaPlan.baseline.sha256}.json`, body)
}
function githubAsset(item) {
  const metadata = parseJson(Buffer.from(execFileSync('gh', ['api', `repos/${REPOSITORY}/releases/tags/${item.githubTag}`], { encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024, timeout: 30_000 })))
  assert.equal(metadata.draft, false, 'GitHub release must be publicly published before OSS pointers')
  const asset = metadata.assets.find(row => row.name === path.basename(item.file))
  assert.ok(asset, `Missing GitHub artifact: ${item.role}`)
  assert.equal(asset.state, 'uploaded')
  assert.equal(asset.size, item.size)
  assert.equal(asset.digest, `sha256:${item.sha256}`)
  return asset.browser_download_url
}
let githubProof
async function verifyGithubBytes(item) {
  const url = githubAsset(item)
  const expected = `https://github.com/${REPOSITORY}/releases/download/${item.githubTag}/${path.basename(item.file)}`
  const actualUrl = new URL(url)
  assert.equal(actualUrl.origin, 'https://github.com')
  assert.ok(!actualUrl.username && !actualUrl.password && !actualUrl.search && !actualUrl.hash)
  assert.equal(decodeURIComponent(actualUrl.pathname), decodeURIComponent(new URL(expected).pathname), 'Unexpected GitHub asset URL')
  if (!githubProof) {
    // Use the same repository's read-only, fixed-hash anonymous download job.
    // This avoids repeatedly downloading large GitHub assets over a slow link;
    // OSS bytes are still downloaded and hashed locally in every release stage.
    const runId = process.env.GITHUB_PUBLIC_READBACK_RUN_ID || ''
    assert.match(runId, /^\d+$/u, 'An actual successful public-byte workflow run is required')
    const run = parseJson(Buffer.from(execFileSync('gh', ['api', `repos/${REPOSITORY}/actions/runs/${runId}`], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })))
    const logs = execFileSync('gh', ['run', 'view', runId, '--repo', REPOSITORY, '--log'], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 60_000 })
    assertGithubReadback(run, logs, plan)
    githubProof = { runId, sourceCommit: run.head_sha, url: run.html_url, logsSha256: sha(Buffer.from(logs)) }
    await writeFile(path.join(RELEASE, 'release-040-github-public-readback.json'), jsonBytes(githubProof))
  }
}
async function verifiedArtifacts() {
  for (const item of plan.items) { await verifyObject(item.key, item); await verifyGithubBytes(item) }
}

const receipt = { schemaVersion: 1, mode, version: VERSION, planSha256, sourceCommit: plan.sourceCommit, startedAt: new Date().toISOString(), initialState, candidateSha256: { legacy: candidates.legacy.sha256, channel: candidates.channel.sha256 }, verified: [] }
const receiptPath = path.join(RELEASE, `release-040-${mode}-receipt.json`)
async function saveReceipt() { const next = `${receiptPath}.next`; await writeFile(next, jsonBytes(receipt)); await rename(next, receiptPath) }
try {
  await capability()
  if (mode === 'stage' || mode === 'artifacts') {
    for (const item of plan.items) {
      console.log(`Uploading and checking complete public bytes: ${item.role}`)
      await immutable(item.key, await readFile(await releaseFile(item.file)))
      if (mode === 'artifacts') await verifyGithubBytes(item)
      receipt.verified.push({ key: item.key, sha256: item.sha256, size: item.size })
      await saveReceipt()
      console.log(JSON.stringify(receipt.verified.at(-1)))
    }
  } else {
    await verifiedArtifacts()
    await claims()
    if (mode === 'channel') {
      const current = await states()
      if (current.channel === 'baseline') {
        const status = await put(CHANNEL_KEY, candidates.channel.bytes, plan.baselines.channel.status === 404)
        assert.ok(status === 200 || (status === 409 && plan.baselines.channel.status === 404))
      }
      await verifyObject(CHANNEL_KEY, { sha256: candidates.channel.sha256, size: candidates.channel.bytes.length })
      receipt.verified.push({ key: CHANNEL_KEY, sha256: candidates.channel.sha256 })
    } else {
      const gateBytes = await readFile(await releaseFile(plan.qaFile, 256 * 1024))
      const gate = parseJson(gateBytes)
      assertPublicQa(gate, plan, planSha256, candidates)
      for (const evidence of gate.evidence) {
        const evidencePath = path.join(ROOT, ...evidence.file.split('/'))
        const metadata = await lstat(evidencePath)
        assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size === evidence.size)
        assert.equal(await realpath(evidencePath), evidencePath, 'QA evidence cannot point outside workspace')
        assert.deepEqual(await fileDigest(evidencePath), { sha256: evidence.sha256, size: evidence.size })
      }
      receipt.qaSha256 = sha(gateBytes)
      let current = await states()
      assert.equal(current.channel, 'candidate', 'Publish new channel and pass public installer QA first')
      // Preserve this safe partial state if catalog update fails: the alias may
      // already point to .40, while the legacy catalog still advertises .39.
      if (current.alias === 'baseline') assert.equal(await put(ALIAS_KEY, await readFile(await releaseFile(plan.alias.file)), false), 200)
      await verifyObject(ALIAS_KEY, { sha256: plan.alias.sha256, size: plan.alias.size })
      receipt.verified.push({ key: ALIAS_KEY, sha256: plan.alias.sha256 })
      await saveReceipt()
      current = await states()
      assert.equal(current.channel, 'candidate')
      assert.equal(current.alias, 'candidate')
      if (current.legacy === 'baseline') assert.equal(await put(LEGACY_KEY, candidates.legacy.bytes, false), 200)
      await verifyObject(LEGACY_KEY, { sha256: candidates.legacy.sha256, size: candidates.legacy.bytes.length })
      receipt.verified.push({ key: LEGACY_KEY, sha256: candidates.legacy.sha256 })
      await saveReceipt()
      current = await states()
      if (current.alpha === 'baseline') assert.equal(await put(ALPHA_KEY, candidates.alpha.bytes, false), 200)
      await verifyObject(ALPHA_KEY, { sha256: candidates.alpha.sha256, size: candidates.alpha.bytes.length })
      receipt.verified.push({ key: ALPHA_KEY, sha256: candidates.alpha.sha256 })
    }
  }
  receipt.finalState = await states()
  receipt.completedAt = new Date().toISOString()
  receipt.ok = true
  await saveReceipt()
  console.log(JSON.stringify({ ok: true, mode, planSha256, state: receipt.finalState, verified: receipt.verified.length }))
} catch (error) {
  receipt.ok = false
  receipt.failedAt = new Date().toISOString()
  receipt.error = error.message
  try { receipt.observedState = await states() } catch { receipt.observedState = 'unknown-or-foreign-pointer; do not overwrite' }
  await saveReceipt()
  throw error
}
