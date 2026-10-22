// Credential-free 040 policy: retain all runtime graphs except the RC2 UI.
import assert from 'node:assert/strict'
import { createHash, createPublicKey } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyRuntimeCatalogManifest, validateRuntimeModules } from './runtime-catalog-validation.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const RELEASE = path.join(ROOT, 'release')
export const VERSION = '0.10.40'
export const DSH_VERSION = '0.2.1-rc.2'
export const BUCKET = 'ailishishu-deepseek-harness'
export const HOSTNAME = `${BUCKET}.oss-cn-beijing.aliyuncs.com`
export const REPOSITORY = 'pingta-guangpingwang/deepblue-deepseek-harness-launcher'
export const LEGACY_KEY = 'release-v2/launcher-manifest.json'
export const ALPHA_KEY = 'release-v2/dsh02/launcher-manifest.json'
export const CHANNEL_KEY = 'release-v2/dsh021rc/launcher-manifest.json'
export const SOURCE_ID = 'runtime-v2-dsh021rc'
export const ALIAS_KEY = 'download/deepblue-deepseek-harness-launcher-win-x64-online.exe'
export const REPLACED_IDS = ['launcher-ui']
export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export const objectPath = key => `/${key.split('/').map(encodeURIComponent).join('/')}`
export const publicUrl = key => `https://${HOSTNAME}${objectPath(key)}`
export const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
export const parseJson = bytes => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''))
export const exactKeys = (object, keys) => assert.deepEqual(Object.keys(object).sort(), [...keys].sort())

export function assertGithubReadback(run, logs, plan) {
  assert.equal(run.head_sha, plan.sourceCommit, 'Readback must use the frozen publishing source')
  assert.equal(run.path, '.github/workflows/verify-040-public-artifacts.yml')
  assert.equal(run.event, 'workflow_dispatch')
  assert.equal(run.status, 'completed')
  assert.equal(run.conclusion, 'success')
  assert.ok(logs.split(/\r?\n/u).some(line => line.endsWith(`PUBLIC_PLAN_VERIFIED ${sha(jsonBytes(plan))}`)), 'Readback must bind the reviewed release plan')
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
  assert.equal(module.id, 'launcher-ui', '040 may only publish a new launcher-ui module')
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
  assert.match(module.version, /^ui-[a-f0-9]{16}$/u)
  assert.equal(fileName, `launcher-ui-${module.version}-win-x64-${artifact.sha256.slice(0, 16)}.tar.gz`)
  assert.equal(parts[0], `launcher-ui-${module.version}`)
  assert.deepEqual({ required: module.required, installWhen: module.installWhen, dependencies: module.dependencies }, { required: true, installWhen: 'launcher', dependencies: [] })
  assert.equal(module.probe, undefined)
  return { role: module.id, key, file: key, githubTag: parts[0], sha256: artifact.sha256, size: artifact.size }
}

export function makePayloads(before, replacements, online, generatedAt, alphaBefore, metadata, rcBefore) {
  assert.equal(before.schemaVersion, 2)
  for (const baseline of [before, alphaBefore, rcBefore]) {
    assert.ok(baseline && baseline.launcher.version === '0.10.39', '040 requires the reviewed 039 baseline on all channels')
  }
  assert.ok(Date.parse(generatedAt) > Date.parse(before.generatedAt))
  assert.deepEqual(replacements.map(item => item.id).sort(), [...REPLACED_IDS].sort())
  replacements.forEach(replacementItem)
  const legacy = structuredClone(before)
  legacy.generatedAt = generatedAt
  legacy.launcher = { ...legacy.launcher, version: VERSION,
    notes: ['AI 游戏目录同步深蓝已上架试玩，按网站顺序展示；可在启动器内独立沙箱窗口直接试玩。', '游戏页面保留“去深蓝试玩学习”入口；加载失败可重试，关闭试玩窗口即可返回启动器。', '本次需更新基础内核至 0.10.40；DSH 0.2.1-rc.2、Node、pnpm 和智能体工作台运行模块保持原版本与字节。', ...before.launcher.notes],
    artifacts: [{ platform: 'win32', arch: 'x64', distribution: 'online', url: publicUrl(ALIAS_KEY), sha256: online.sha256, size: online.size }] }
  const alpha = structuredClone(alphaBefore)
  alpha.generatedAt = generatedAt
  alpha.launcher = structuredClone(legacy.launcher)
  const channel = structuredClone(rcBefore)
  channel.generatedAt = generatedAt
  channel.launcher = structuredClone(legacy.launcher)
  channel.runtimeModules = rcBefore.runtimeModules.map(item => structuredClone(replacements.find(next => next.id === item.id) || item))
  assertPayloadPair(before, legacy, channel, online, alphaBefore, metadata, rcBefore)
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

export function assertPayloadPair(before, legacy, channel, online, alphaBefore, metadata, rcBefore) {
  for (const baseline of [before, alphaBefore, rcBefore]) assert.equal(baseline.launcher.version, '0.10.39')
  assert.equal(before.runtimeModules.find(item => item.id === 'harness-core')?.version, '0.1.1-rc.2')
  assert.equal(rcBefore.runtimeModules.find(item => item.id === 'harness-core')?.version, DSH_VERSION)
  exactKeys(legacy, Object.keys(before)); exactKeys(channel, Object.keys(rcBefore))
  assert.ok(validateRuntimeModules(legacy.runtimeModules) && validateRuntimeModules(channel.runtimeModules))
  assert.ok(Date.parse(legacy.generatedAt) > Date.parse(before.generatedAt))
  assert.equal(channel.generatedAt, legacy.generatedAt)
  for (const key of Object.keys(before)) if (!['generatedAt','launcher'].includes(key)) assert.deepEqual(legacy[key], before[key], `Legacy changed ${key}`)
  for (const key of Object.keys(rcBefore)) if (!['generatedAt','launcher','runtimeModules'].includes(key)) assert.deepEqual(channel[key], rcBefore[key], `RC2 unrelated field changed ${key}`)
  exactKeys(legacy.launcher, Object.keys(before.launcher))
  for (const key of Object.keys(before.launcher)) if (!['version','notes','artifacts'].includes(key)) assert.deepEqual(legacy.launcher[key], before.launcher[key])
  assert.equal(legacy.launcher.version, VERSION)
  assert.deepEqual(legacy.launcher.artifacts, [{ platform: 'win32', arch: 'x64', distribution: 'online', url: publicUrl(ALIAS_KEY), sha256: online.sha256, size: online.size }])
  assert.deepEqual(channel.launcher, legacy.launcher)
  assert.deepEqual(channel.runtimeModules.map(item => item.id), rcBefore.runtimeModules.map(item => item.id))
  for (const module of rcBefore.runtimeModules) {
    const next = channel.runtimeModules.find(item => item.id === module.id)
    if (module.id === 'launcher-ui') { replacementItem(next); assert.notDeepEqual(next, module, 'UI must actually change') }
    else assert.deepEqual(next, module, `${module.id} must remain byte-for-byte compatible`)
  }
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
  for (const field of ['emptyDirectoryInstall', 'realPublicDownload', 'authenticatedBrowser', 'legacyCatalogStillDsh01', 'alpha2CatalogStillCompatible', 'userDataRollback', 'nodeRuntimeUnchanged', 'packageManagerUnchanged', 'harnessCoreUnchanged', 'agentHostUnchanged']) assert.equal(gate[field], true, `QA missing ${field}`)
  assert.equal(gate.realTask?.kind, 'public-shenlan-guest-gameplay', 'An actual public guest game must be played in the installed launcher')
  assert.equal(gate.realTask?.passed, true)
  assert.match(gate.realTask?.gameSlug || '', /^[a-z0-9][a-z0-9-]{0,79}$/u)
  assert.equal(gate.realTask?.interactionVerified, true)
  assert.equal(gate.realTask?.guestSessionEnded, true)
  assert.equal(gate.gameWindow?.passed, true)
  for (const field of ['sandboxed', 'contextIsolated', 'nodeIntegrationDisabled', 'noPreload', 'popupsDenied', 'unexpectedNavigationDenied', 'downloadsBlocked', 'failureRecovery', 'parentCloseCleanup']) assert.equal(gate.gameWindow?.[field], true, `Game window QA missing ${field}`)
  assert.equal(gate.gamesCatalog?.source, 'https://shenlanai.com/api/games.php?action=list')
  assert.ok(Number.isSafeInteger(gate.gamesCatalog?.count) && gate.gamesCatalog.count > 0, 'A real published game catalog is required')
  assert.equal(gate.gamesCatalog?.serverOrderPreserved, true)
  assert.deepEqual(gate.externalLearningCta, { url: 'https://shenlanai.com/ai-games/', passed: true })
  for (const field of ['passed', 'proactivePrompt', 'automaticModules', 'interruptedRetry', 'kernelDownloadVerified', 'inPlaceInstallerHandoff', 'profilePreserved']) assert.equal(gate.selfUpdate?.[field], true, `Self-update QA missing ${field}`)
  assert.ok(typeof gate.realTask?.report === 'string' && gate.realTask.report.length > 0)
  assert.ok(Number.isFinite(Date.parse(gate.testedAt)) && Date.parse(gate.testedAt) >= Date.parse(plan.createdAt))
  assert.ok(Array.isArray(gate.evidence) && gate.evidence.length > 0)
  assert.ok(gate.evidence.some(item => item.file === gate.realTask.report), 'Actual gameplay report must be hash-bound evidence')
  assert.ok(gate.evidence.some(item => item.file === gate.gameWindow.report), 'Packaged native sandbox evidence must be hash-bound')
  assert.ok(gate.evidence.some(item => item.file === gate.selfUpdate.report), 'Isolated-profile self-update evidence must be hash-bound')
  for (const item of gate.evidence) {
    exactKeys(item, ['file', 'size', 'sha256'])
    assert.match(item.file, /^(?:output|release)\/[0-9A-Za-z+._/-]+$/u)
    assert.ok(!item.file.split('/').includes('..'))
    assert.match(item.sha256, /^[a-f0-9]{64}$/u)
    assert.ok(Number.isSafeInteger(item.size) && item.size > 0 && item.size <= 16 * 1024 * 1024)
  }
}
