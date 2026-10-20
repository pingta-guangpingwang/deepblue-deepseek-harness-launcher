// Credential-free policy: retain both old runtime graphs and add an RC2 channel.
import assert from 'node:assert/strict'
import { createHash, createPublicKey } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyRuntimeCatalogManifest, validateRuntimeModules } from './runtime-catalog-validation.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const RELEASE = path.join(ROOT, 'release')
export const VERSION = '0.10.38'
export const DSH_VERSION = '0.2.1-rc.2'
export const BUCKET = 'ailishishu-deepseek-harness'
export const HOSTNAME = `${BUCKET}.oss-cn-beijing.aliyuncs.com`
export const REPOSITORY = 'pingta-guangpingwang/deepblue-deepseek-harness-launcher'
export const LEGACY_KEY = 'release-v2/launcher-manifest.json'
export const ALPHA_KEY = 'release-v2/dsh02/launcher-manifest.json'
export const CHANNEL_KEY = 'release-v2/dsh021rc/launcher-manifest.json'
export const SOURCE_ID = 'runtime-v2-dsh021rc'
export const ALIAS_KEY = 'download/deepblue-deepseek-harness-launcher-win-x64-online.exe'
export const REPLACED_IDS = ['harness-core', 'launcher-ui', 'agent-host']
export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export const objectPath = key => `/${key.split('/').map(encodeURIComponent).join('/')}`
export const publicUrl = key => `https://${HOSTNAME}${objectPath(key)}`
export const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
export const parseJson = bytes => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''))
export const exactKeys = (object, keys) => assert.deepEqual(Object.keys(object).sort(), [...keys].sort())

export function assertGithubReadback(run, logs, plan) {
  assert.equal(run.head_sha, plan.sourceCommit, 'Readback must use the frozen publishing source')
  assert.equal(run.path, '.github/workflows/verify-038-public-artifacts.yml')
  assert.equal(run.event, 'workflow_dispatch')
  assert.equal(run.status, 'completed')
  assert.equal(run.conclusion, 'success')
  for (const artifact of plan.items) {
    const marker = `PUBLIC_READBACK_VERIFIED ${path.basename(artifact.file)} ${artifact.sha256} ${artifact.size}`
    assert.ok(logs.split(/\r?\n/u).some(line => line.endsWith(marker)), `Full-byte workflow evidence missing: ${artifact.role}`)
  }
}

export async function fileDigest(file) {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(file)) { size += chunk.length; hash.update(chunk) }
  return { sha256: hash.digest('hex'), size }
}

export async function releaseFile(relative, maxBytes = 2_000_000_000) {
  assert.match(relative, /^(?:modules\/)?[0-9A-Za-z+._-]+$/u, 'Unsafe release-relative file')
  assert.ok(!relative.includes('..'))
  const file = path.join(RELEASE, ...relative.split('/'))
  const metadata = await lstat(file)
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0 && metadata.size <= maxBytes, 'Not a bounded regular release file')
  const resolved = await realpath(file)
  const relativeReal = path.relative(await realpath(RELEASE), resolved)
  assert.ok(relativeReal && relativeReal !== '..' && !relativeReal.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeReal), 'Release file escaped real release directory')
  return file
}

export async function trustedManifest(bytes) {
  const key = createPublicKey(await readFile(path.join(ROOT, 'resources/runtime-update-public-key.pem')))
  const manifest = parseJson(bytes)
  assert.ok(verifyRuntimeCatalogManifest(manifest, key), 'Invalid signature or runtime graph')
  return manifest
}

// The public release includes only mirrors verified by this operator. Never
// retain a newly advertised Gitee mirror merely because a builder emitted it.
export function normalizeReplacement(record) {
  assert.ok(record && typeof record === 'object' && REPLACED_IDS.includes(record.id), 'Missing expected replacement module record')
  const module = structuredClone(record)
  delete module.fileName
  delete module.treeSha256
  exactKeys(module, ['id', 'version', 'required', 'installWhen', 'dependencies', 'artifacts', ...(module.probe ? ['probe'] : [])])
  assert.ok(REPLACED_IDS.includes(module.id))
  assert.equal(module.artifacts.length, 1)
  module.artifacts[0].mirrors = ['oss', 'github'].map(id => {
    const mirror = module.artifacts[0].mirrors.find(item => item.id === id)
    assert.ok(mirror, `Missing ${id} mirror for ${module.id}`)
    exactKeys(mirror, ['id', 'url'])
    return structuredClone(mirror)
  })
  return module
}

export function replacementItem(module) {
  const artifact = module.artifacts[0]
  assert.equal(artifact.platform, 'win32')
  assert.equal(artifact.arch, 'x64')
  assert.equal(artifact.format, 'tar.gz')
  const oss = new URL(artifact.mirrors.find(item => item.id === 'oss').url)
  const github = new URL(artifact.mirrors.find(item => item.id === 'github').url)
  for (const url of [oss, github]) assert.ok(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && !url.port)
  assert.equal(oss.hostname, HOSTNAME)
  const key = decodeURIComponent(oss.pathname).slice(1)
  assert.match(key, /^modules\/[0-9A-Za-z+._-]+\.tar\.gz$/u)
  assert.ok(!key.includes('..'))
  const fileName = key.slice('modules/'.length)
  assert.equal(github.hostname, 'github.com')
  const prefix = `/${REPOSITORY}/releases/download/`
  assert.ok(github.pathname.startsWith(prefix))
  const parts = github.pathname.slice(prefix.length).split('/').map(decodeURIComponent)
  assert.equal(parts.length, 2)
  assert.equal(parts[1], fileName)
  assert.match(parts[0], /^[0-9A-Za-z+._-]+$/u)
  if (module.id === 'harness-core') {
    assert.equal(module.version, DSH_VERSION)
    assert.equal(fileName, `harness-core-${DSH_VERSION}-win-x64-${artifact.sha256.slice(0, 16)}.tar.gz`)
    assert.equal(parts[0], `runtime-module-harness-core-${DSH_VERSION}-${artifact.sha256.slice(0, 16)}`)
    assert.deepEqual({ required: module.required, installWhen: module.installWhen, dependencies: module.dependencies }, { required: true, installWhen: 'harness', dependencies: ['node-runtime'] })
    assert.equal(module.probe, undefined)
  } else if (module.id === 'launcher-ui') {
    assert.match(module.version, /^ui-[a-f0-9]{16}$/u)
    assert.equal(fileName, `launcher-ui-${module.version}-win-x64-${artifact.sha256.slice(0, 16)}.tar.gz`)
    assert.equal(parts[0], `launcher-ui-${module.version}`)
    assert.deepEqual({ required: module.required, installWhen: module.installWhen, dependencies: module.dependencies }, { required: true, installWhen: 'launcher', dependencies: [] })
    assert.equal(module.probe, undefined)
  } else {
    assert.match(module.version, /^1\.0\.0\+[a-f0-9]{12}$/u)
    assert.equal(fileName, `agent-host-${module.version}-win-x64.tar.gz`)
    assert.equal(parts[0], `agent-host-${module.version}`)
    assert.deepEqual({ required: module.required, installWhen: module.installWhen, dependencies: module.dependencies }, { required: false, installWhen: 'launcher', dependencies: [] })
    assert.equal(module.probe, undefined)
  }
  return { role: module.id, key, file: key, githubTag: parts[0], sha256: artifact.sha256, size: artifact.size }
}

export function makePayloads(before, replacements, online, generatedAt, alphaBefore, metadata) {
  assert.equal(before.schemaVersion, 2)
  assert.ok(Number.isFinite(Date.parse(generatedAt)) && Date.parse(generatedAt) > Date.parse(before.generatedAt))
  assert.equal(new Date(generatedAt).toISOString(), generatedAt)
  assert.deepEqual(replacements.map(module => module.id).sort(), [...REPLACED_IDS].sort())
  for (const module of replacements) replacementItem(module)
  const legacy = structuredClone(before)
  legacy.generatedAt = generatedAt
  legacy.launcher = {
    ...legacy.launcher,
    version: VERSION,
    notes: [
      '先更新启动器至 0.10.38，再更新 DSH 核心；旧 0.1 和 alpha.2 更新目录保留原兼容模块。',
      '官方 DSH 0.2.1-rc.2 候选版，支持 DeepSeek V4.1 Flash 与独立 Search / Fetch API。',
      '模型页可开启 DeepSeek 搜索，复用已有凭据；RC2 克隆现有会话到独立目录，原数据保留供回退。',
      ...before.launcher.notes
    ],
    artifacts: [{ platform: 'win32', arch: 'x64', distribution: 'online', url: publicUrl(ALIAS_KEY), sha256: online.sha256, size: online.size }]
  }
  const alpha = structuredClone(alphaBefore)
  alpha.generatedAt = generatedAt
  alpha.launcher = structuredClone(legacy.launcher)
  const channel = structuredClone(alpha)
  channel.runtimeModules = alphaBefore.runtimeModules.map(module => replacements.find(item => item.id === module.id) || structuredClone(module))
  const official = metadata.modelProviderTemplates.find(item => item.id === 'deepseek-official')
  assert.ok(official && official.catalogUpdatedAt === '2026-10-20')
  channel.modelTemplates = alphaBefore.modelTemplates.map(item => item.id === 'deepseek-official' ? structuredClone(official) : structuredClone(item))
  channel.models = [...metadata.bundledModels.filter(item => item.provider === 'DeepSeek'), ...alphaBefore.models.filter(item => item.provider !== 'DeepSeek')]
  channel.harness = [{
    version: DSH_VERSION, channel: 'preview', installed: false, active: false, rollbackReady: false,
    sizeMb: Math.ceil(replacements.find(module => module.id === 'harness-core').artifacts[0].size / 1024 / 1024),
    publishedAt: '2026-10-17', notes: ['官方 dsh-v0.2.1-rc.2 候选版', '需要启动器 0.10.38；原生 Search / Fetch、Flash 图片理解和会话协议', 'RC2 使用 harness-data-v2-rc2，旧 alpha.2 数据与模块保留供回退']
  }, ...structuredClone(alphaBefore.harness).filter(item => item.version !== DSH_VERSION)]
  assertPayloadPair(before, legacy, channel, online, alphaBefore, metadata)
  assertAlphaAnnouncement(alphaBefore, alpha, legacy)
  return { legacy, channel, alpha }
}

export function assertAlphaAnnouncement(before, candidate, legacy) {
  exactKeys(candidate, Object.keys(before))
  for (const key of Object.keys(before)) if (!['generatedAt','launcher'].includes(key)) assert.deepEqual(candidate[key], before[key], `Alpha2 changed ${key}`)
  assert.deepEqual(candidate.launcher, legacy.launcher)
  for (const key of Object.keys(before.launcher)) if (!['version','notes','artifacts'].includes(key)) assert.deepEqual(candidate.launcher[key], before.launcher[key], `Alpha2 launcher changed ${key}`)
  assert.equal(candidate.generatedAt, legacy.generatedAt)
  assert.equal(candidate.runtimeModules.find(item => item.id === 'harness-core').version, '0.2.1-alpha.2')
}

export function assertPayloadPair(before, legacy, channel, online, alphaBefore, metadata) {
  exactKeys(legacy, Object.keys(before))
  exactKeys(channel, Object.keys(alphaBefore))
  assert.ok(validateRuntimeModules(legacy.runtimeModules) && validateRuntimeModules(channel.runtimeModules))
  assert.ok(Date.parse(legacy.generatedAt) > Date.parse(before.generatedAt))
  assert.equal(channel.generatedAt, legacy.generatedAt)
  for (const field of Object.keys(before)) {
    if (!['generatedAt', 'launcher'].includes(field)) assert.deepEqual(legacy[field], before[field], `Legacy changed ${field}`)
  }
  for (const field of Object.keys(alphaBefore)) if (!['generatedAt','launcher','runtimeModules','harness','modelTemplates','models'].includes(field)) assert.deepEqual(channel[field], alphaBefore[field], `RC2 changed ${field}`)
  const official = metadata.modelProviderTemplates.find(item => item.id === 'deepseek-official')
  assert.deepEqual(channel.modelTemplates, alphaBefore.modelTemplates.map(item => item.id === 'deepseek-official' ? official : item))
  assert.deepEqual(channel.models, [...metadata.bundledModels.filter(item => item.provider === 'DeepSeek'), ...alphaBefore.models.filter(item => item.provider !== 'DeepSeek')])
  exactKeys(legacy.launcher, Object.keys(before.launcher))
  for (const field of Object.keys(before.launcher)) if (!['version', 'notes', 'artifacts'].includes(field)) assert.deepEqual(legacy.launcher[field], before.launcher[field])
  assert.equal(legacy.launcher.version, VERSION)
  assert.deepEqual(legacy.launcher.artifacts, [{ platform: 'win32', arch: 'x64', distribution: 'online', url: publicUrl(ALIAS_KEY), sha256: online.sha256, size: online.size }])
  assert.ok(Array.isArray(legacy.launcher.notes) && legacy.launcher.notes.every(item => typeof item === 'string' && item.length < 1000))
  assert.deepEqual(channel.launcher, legacy.launcher)
  assert.deepEqual(channel.runtimeModules.map(module => module.id), alphaBefore.runtimeModules.map(module => module.id), 'Runtime order or graph changed')
  for (const module of alphaBefore.runtimeModules) {
    const next = channel.runtimeModules.find(item => item.id === module.id)
    if (REPLACED_IDS.includes(module.id)) {
      replacementItem(next)
      assert.notDeepEqual(next, module, `${module.id} was not replaced`)
    } else assert.deepEqual(next, module, `${module.id} must be preserved exactly`)
  }
  assert.deepEqual(channel.harness.slice(1), alphaBefore.harness.filter(item => item.version !== DSH_VERSION))
  assert.deepEqual(Object.keys(channel.harness[0]).sort(), ['active', 'channel', 'installed', 'notes', 'publishedAt', 'rollbackReady', 'sizeMb', 'version'])
  assert.equal(channel.harness[0].version, DSH_VERSION)
  assert.equal(channel.harness[0].channel, 'preview')
  for (const field of ['active', 'installed', 'rollbackReady']) assert.equal(channel.harness[0][field], false)
}

export function pointerState(actual, baseline, candidateSha256) {
  if (actual.status === 200 && actual.sha256 === candidateSha256) return 'candidate'
  if (actual.status === baseline.status && (actual.status === 404 || actual.sha256 === baseline.sha256)) return 'baseline'
  throw new Error('Public pointer is neither approved baseline nor exact candidate; stop for review')
}

export function assertPublicQa(gate, plan, planSha256, candidates) {
  assert.equal(gate.schemaVersion, 1)
  assert.equal(gate.passed, true)
  assert.equal(gate.planSha256, planSha256)
  assert.equal(gate.sourceCommit, plan.sourceCommit)
  assert.equal(gate.catalogUrl, publicUrl(CHANNEL_KEY))
  assert.equal(gate.catalogSha256, candidates.channel.sha256)
  assert.equal(gate.bootstrapSha256, plan.alias.sha256)
  assert.equal(gate.shellSha256, plan.items.find(item => item.role === 'shell').sha256)
  assert.equal(gate.installedLauncherVersion, VERSION)
  assert.equal(gate.installedDshVersion, DSH_VERSION)
  assert.equal(gate.sourceId, SOURCE_ID)
  for (const field of ['emptyDirectoryInstall', 'realPublicDownload', 'authenticatedBrowser', 'legacyCatalogStillDsh01', 'alpha2CatalogStillCompatible', 'userDataRollback', 'nodeRuntimeUnchanged', 'packageManagerUnchanged']) assert.equal(gate[field], true, `QA missing ${field}`)
  assert.equal(gate.realTask?.kind, 'real-model', 'Synthetic stub is not real-model release acceptance')
  assert.equal(gate.realTask?.passed, true)
  assert.ok(typeof gate.realTask?.report === 'string' && gate.realTask.report.length > 0)
  assert.ok(Number.isFinite(Date.parse(gate.testedAt)) && Date.parse(gate.testedAt) >= Date.parse(plan.createdAt))
  assert.ok(Array.isArray(gate.evidence) && gate.evidence.length > 0)
  assert.ok(gate.evidence.some(item => item.file === gate.realTask.report), 'Real-model task report must be hash-bound evidence')
  for (const item of gate.evidence) {
    exactKeys(item, ['file', 'size', 'sha256'])
    assert.match(item.file, /^(?:output|release)\/[0-9A-Za-z+._/-]+$/u)
    assert.ok(!item.file.split('/').includes('..'))
    assert.match(item.sha256, /^[a-f0-9]{64}$/u)
    assert.ok(Number.isSafeInteger(item.size) && item.size > 0 && item.size <= 16 * 1024 * 1024)
  }
}
