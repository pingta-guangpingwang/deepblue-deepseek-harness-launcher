// Read-only production preflight; creates unsigned payloads and a pinned local
// plan. Does not sign, read credentials, upload, or update public pointers.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, lstat, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fetchBoundedBytes } from './bounded-fetch.mjs'
import { loadBundledReleaseMetadata } from './bundled-release-metadata.mjs'
import {
  ROOT, RELEASE, VERSION, DSH_VERSION, LEGACY_KEY, ALPHA_KEY, CHANNEL_KEY, ALIAS_KEY, SOURCE_ID, REPLACED_IDS,
  sha, parseJson, jsonBytes, publicUrl, fileDigest, releaseFile, trustedManifest,
  normalizeReplacement, replacementItem, makePayloads
} from './release-040-qa.mjs'

const planFile = path.join(RELEASE, 'release-040-plan.json')
try { await access(planFile); throw new Error('An approved 040 plan already exists; preserve it and resume the publisher, do not reprepare') }
catch (error) { if (error.code !== 'ENOENT') throw error }
const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim()
const sourceCommit = git(['rev-parse', 'HEAD'])
assert.match(sourceCommit, /^[a-f0-9]{40}$/u)
assert.equal(git(['status', '--porcelain']), '', 'Commit and review source before preparing a release')
const packageJson = parseJson(await readFile(path.join(ROOT, 'package.json')))
assert.equal(packageJson.version, VERSION)
assert.equal(packageJson.dependencies['@deepseek-ai/dsh'], DSH_VERSION)
const config = await readFile(path.join(ROOT, 'src/main/config.ts'), 'utf8')
assert.ok(config.includes(`id: '${SOURCE_ID}'`) && config.includes(publicUrl(CHANNEL_KEY)), 'New kernel must use the approved separate channel and source ID')

async function getPointer(key, maxBytes) {
  const response = await fetchBoundedBytes(publicUrl(key), { maxBytes, redirect: 'error', timeoutMs: 120_000 })
  assert.ok([200, 404].includes(response.response.status), `${key} preflight failed`)
  assert.ok(!response.response.headers.get('x-oss-version-id'), 'Versioned bucket requires a different publication policy')
  return response
}
const legacyFetch = await getPointer(LEGACY_KEY, 256 * 1024)
assert.equal(legacyFetch.response.status, 200)
const before = await trustedManifest(legacyFetch.bytes)
assert.equal(before.payload.launcher.version, '0.10.39', 'Unexpected legacy release; re-review baseline')
assert.equal(before.payload.runtimeModules.find(module => module.id === 'harness-core')?.version, '0.1.1-rc.2')
const alphaFetch = await getPointer(ALPHA_KEY, 256 * 1024)
assert.equal(alphaFetch.response.status, 200)
const alphaBefore = await trustedManifest(alphaFetch.bytes)
assert.equal(alphaBefore.payload.launcher.version, '0.10.39')
assert.equal(alphaBefore.payload.runtimeModules.find(module => module.id === 'harness-core')?.version, '0.2.1-alpha.2')
const channelFetch = await getPointer(CHANNEL_KEY, 256 * 1024)
assert.equal(channelFetch.response.status, 200, 'RC2 channel must already exist')
const rcBefore = await trustedManifest(channelFetch.bytes)
assert.equal(rcBefore.payload.launcher.version, '0.10.39')
const aliasFetch = await getPointer(ALIAS_KEY, 4 * 1024 * 1024)
assert.equal(aliasFetch.response.status, 200)
const oldOnline = before.payload.launcher.artifacts.find(item => item.platform === 'win32' && item.arch === 'x64' && item.distribution === 'online')
assert.ok(oldOnline && oldOnline.url === publicUrl(ALIAS_KEY))
assert.equal(sha(aliasFetch.bytes), oldOnline.sha256, 'Legacy catalog and installer alias are not aligned')
assert.equal(aliasFetch.bytes.length, oldOnline.size)

async function generated(name, maxBytes = 256 * 1024) {
  const file = await releaseFile(name, maxBytes)
  const bytes = await readFile(file)
  return { value: parseJson(bytes), sha256: sha(bytes) }
}
const shellRecord = await generated('launcher-shell.generated.json')
const windowsRecord = await generated('windows-artifacts.json')
const runtimeRecord = await generated('runtime-modules.generated.json')
const uiRecord = await generated('launcher-ui.generated.json')
const shell = shellRecord.value
assert.equal(shell.version, VERSION)
assert.equal(shell.platform, 'win32')
assert.equal(shell.arch, 'x64')
assert.equal(shell.format, '7z')
assert.equal(shell.fileName, `launcher-shell-${VERSION}-win-x64-${shell.sha256.slice(0, 16)}.7z`)
assert.equal(shell.executable, '深蓝DeepSeekHarness启动器.exe')
assert.ok(Number.isSafeInteger(shell.unpackedSize) && shell.unpackedSize >= shell.size && shell.unpackedSize <= 2_000_000_000)
const shellOss = shell.mirrors.find(item => item.id === 'oss')
const shellGithub = shell.mirrors.find(item => item.id === 'github')
assert.equal(shellOss?.url, publicUrl(`modules/${shell.fileName}`))
assert.equal(shellGithub?.url, `https://github.com/pingta-guangpingwang/deepblue-deepseek-harness-launcher/releases/download/runtime-v${VERSION}/${shell.fileName}`)
assert.deepEqual(windowsRecord.value.map(item => item.edition).sort(), ['offline', 'online'])
const online = windowsRecord.value.find(item => item.edition === 'online')
const offline = windowsRecord.value.find(item => item.edition === 'offline')
for (const item of windowsRecord.value) assert.equal(item.fileName, `deepblue-deepseek-harness-launcher-${VERSION}-win-x64-${item.edition}.exe`)
assert.equal(runtimeRecord.value.schemaVersion, 1)
const replacements = [normalizeReplacement(uiRecord.value)]
assert.equal(uiRecord.value.fileName, replacementItem(replacements[0]).key.slice('modules/'.length))
assert.equal(uiRecord.value.version, `ui-${uiRecord.value.treeSha256?.slice(0, 16)}`)
assert.deepEqual(runtimeRecord.value.modules.map(module => module.id).sort(), rcBefore.payload.runtimeModules.map(module => module.id).sort())
for (const module of runtimeRecord.value.modules) {
  const expected = replacements.find(item => item.id === module.id) || rcBefore.payload.runtimeModules.find(item => item.id === module.id)
  assert.deepEqual(REPLACED_IDS.includes(module.id) ? normalizeReplacement(module) : module, expected, `${module.id}: do not replace the currently signed production descriptor`)
}
// A shell built against a different graph could pass archive hashing but install
// wrong bytes. Compare its actual packaged fallback, not only build records.
const embeddedFile = path.join(RELEASE, 'win-unpacked/resources/resources/runtime-modules.generated.json')
const embeddedStat = await lstat(embeddedFile)
assert.ok(embeddedStat.isFile() && !embeddedStat.isSymbolicLink() && embeddedStat.size <= 256 * 1024)
const embeddedBytes = await readFile(embeddedFile)
const embedded = parseJson(embeddedBytes)
assert.equal(embedded.schemaVersion, 1)
assert.deepEqual(embedded.modules.map(module => module.id).sort(), rcBefore.payload.runtimeModules.map(module => module.id).sort())
for (const module of embedded.modules) {
  const expected = replacements.find(item => item.id === module.id) || rcBefore.payload.runtimeModules.find(item => item.id === module.id)
  assert.deepEqual(REPLACED_IDS.includes(module.id) ? normalizeReplacement(module) : module, expected, `Shell fallback mismatch for ${module.id}`)
}

const items = [
  { role: 'shell', key: `modules/${shell.fileName}`, file: shell.fileName, sha256: shell.sha256, size: shell.size, githubTag: `runtime-v${VERSION}` },
  ...windowsRecord.value.map(item => ({ role: item.edition, key: `download/${item.fileName}`, file: item.fileName, sha256: item.sha256, size: item.size, githubTag: `v${VERSION}` })),
  ...replacements.map(replacementItem)
]
assert.equal(new Set(items.map(item => item.key)).size, items.length)
for (const item of items) {
  assert.match(item.sha256, /^[a-f0-9]{64}$/u)
  assert.ok(Number.isSafeInteger(item.size) && item.size > 0 && item.size <= 2_000_000_000)
  assert.deepEqual(await fileDigest(await releaseFile(item.file)), { sha256: item.sha256, size: item.size }, `${item.role} archive changed`)
}
const createdAt = new Date().toISOString()
const metadata = await loadBundledReleaseMetadata()
const payloads = makePayloads(before.payload, replacements, online, createdAt, alphaBefore.payload, metadata, rcBefore.payload, offline)
const payloadBytes = { legacy: jsonBytes(payloads.legacy), channel: jsonBytes(payloads.channel), alpha: jsonBytes(payloads.alpha) }
const plan = {
  schemaVersion: 1, version: VERSION, dshVersion: DSH_VERSION, sourceCommit, createdAt,
  policy: 'legacy-alpha2-preserved-rc2-ui-only-040-v1',
  source: { id: SOURCE_ID, url: publicUrl(CHANNEL_KEY) },
  baselines: {
    legacy: { key: LEGACY_KEY, status: 200, sha256: sha(legacyFetch.bytes), size: legacyFetch.bytes.length, file: 'launcher-manifest.before-040.legacy.json' },
    channel: { key: CHANNEL_KEY, status: channelFetch.response.status, ...(channelFetch.response.status === 200 ? { sha256: sha(channelFetch.bytes), size: channelFetch.bytes.length, file: 'launcher-manifest.before-040.dsh02.json' } : {}) },
    alias: { key: ALIAS_KEY, status: 200, sha256: sha(aliasFetch.bytes), size: aliasFetch.bytes.length, file: 'launcher-online.before-040.exe' }
  },
  payloads: {
    legacy: { file: 'launcher-catalog-040-legacy-payload.json', sha256: sha(payloadBytes.legacy), signedFile: 'launcher-manifest.040.legacy.json' },
    channel: { file: 'launcher-catalog-040-dsh02-payload.json', sha256: sha(payloadBytes.channel), signedFile: 'launcher-manifest.040.dsh02.json' }
  },
  inputs: [
    { file: 'launcher-shell.generated.json', sha256: shellRecord.sha256 },
    { file: 'windows-artifacts.json', sha256: windowsRecord.sha256 },
    { file: 'runtime-modules.generated.json', sha256: runtimeRecord.sha256 },
    { file: 'launcher-ui.generated.json', sha256: uiRecord.sha256 },
    { file: 'win-unpacked/resources/resources/runtime-modules.generated.json', sha256: sha(embeddedBytes) }
  ],
  items,
  alias: { key: ALIAS_KEY, file: online.fileName, sha256: online.sha256, size: online.size },
  alphaAnnouncement: {
    key: ALPHA_KEY,
    baseline: { status: 200, sha256: sha(alphaFetch.bytes), size: alphaFetch.bytes.length, file: 'launcher-manifest.before-040.alpha2.json' },
    payload: { file: 'launcher-catalog-040-alpha2-payload.json', sha256: sha(payloadBytes.alpha), signedFile: 'launcher-manifest.040.alpha2.json' }
  },
  qaFile: 'release-040-public-qa.json'
}
// Write the plan last. Exclusive creation never replaces earlier baseline/QA.
const writeNew = (name, bytes) => writeFile(path.join(RELEASE, name), bytes, { flag: 'wx' })
await writeNew(plan.baselines.legacy.file, legacyFetch.bytes)
if (plan.baselines.channel.status === 200) await writeNew(plan.baselines.channel.file, channelFetch.bytes)
await writeNew(plan.baselines.alias.file, aliasFetch.bytes)
await writeNew(plan.payloads.legacy.file, payloadBytes.legacy)
await writeNew(plan.payloads.channel.file, payloadBytes.channel)
await writeNew(plan.alphaAnnouncement.baseline.file, alphaFetch.bytes)
await writeNew(plan.alphaAnnouncement.payload.file, payloadBytes.alpha)
const planBytes = jsonBytes(plan)
await writeNew('release-040-plan.json', planBytes)
console.log(JSON.stringify({ ok: true, sourceCommit, planSha256: sha(planBytes), legacyBaselineSha256: plan.baselines.legacy.sha256, channelBaselineStatus: plan.baselines.channel.status, payloads: plan.payloads, items, next: 'Review plan, sign all three payloads externally, then check/stage/GitHub full readback/artifacts/channel/public game QA/pointers' }, null, 2))
