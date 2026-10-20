// Kept outside Vitest discovery: this suite uses the Node.js test runner.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  VERSION, DSH_VERSION, CHANNEL_KEY, SOURCE_ID, REPLACED_IDS, publicUrl, normalizeReplacement,
  replacementItem, makePayloads, assertPayloadPair, assertAlphaAnnouncement, pointerState, assertPublicQa, assertGithubReadback
} from './release-038-qa.mjs'

import { loadBundledReleaseMetadata } from './bundled-release-metadata.mjs'
const metadata = await loadBundledReleaseMetadata()
const digest = letter => letter.repeat(64)
test('cloud byte evidence requires the exact successful workflow and every artifact digest', () => {
  const plan = { sourceCommit: 'a'.repeat(40), items: [{ role: 'core', file: 'modules/core.tar.gz', sha256: digest('b'), size: 123 }] }
  const run = { head_sha: plan.sourceCommit, path: '.github/workflows/verify-038-public-artifacts.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' }
  const logs = `job\tstep\tdate PUBLIC_READBACK_VERIFIED core.tar.gz ${digest('b')} 123\n`
  assertGithubReadback(run, logs, plan)
  for (const [key, value] of [['head_sha', 'c'.repeat(40)], ['path', 'other.yml'], ['event', 'push'], ['status', 'in_progress'], ['conclusion', 'failure']]) {
    assert.throws(() => assertGithubReadback({ ...run, [key]: value }, logs, plan))
  }
  assert.throws(() => assertGithubReadback(run, logs.replace(digest('b'), digest('c')), plan))
  assert.throws(() => assertGithubReadback(run, '', plan))
})
const artifact = (id, version, hash = digest('a')) => {
  const fileName = id === 'agent-host' ? `${id}-${version}-win-x64.tar.gz` : `${id}-${version}-win-x64-${hash.slice(0, 16)}.tar.gz`
  const tag = id === 'launcher-ui' ? `launcher-ui-${version}` : id === 'agent-host' ? `agent-host-${version}` : `runtime-module-${id}-${version}-${hash.slice(0, 16)}`
  return {
    platform: 'win32', arch: 'x64', format: 'tar.gz', sha256: hash, size: 100, unpackedSize: 200,
    mirrors: [
      { id: 'oss', url: publicUrl(`modules/${fileName}`) },
      { id: 'github', url: `https://github.com/pingta-guangpingwang/deepblue-deepseek-harness-launcher/releases/download/${tag}/${fileName}` }
    ]
  }
}
const module = (id, version, hash) => ({ id, version, required: !['agent-host', 'package-manager'].includes(id), installWhen: ['agent-host', 'launcher-ui'].includes(id) ? 'launcher' : id === 'package-manager' ? 'plugin-manager' : 'harness', dependencies: ['harness-core', 'package-manager'].includes(id) ? ['node-runtime'] : [], artifacts: [artifact(id, version, hash)] })
const before = {
  schemaVersion: 2, generatedAt: '2026-09-22T14:51:22.246Z',
  launcher: { version: '0.10.37', notes: ['keep old notes'], artifacts: [{ platform: 'win32', arch: 'x64', distribution: 'online', url: publicUrl('download/deepblue-deepseek-harness-launcher-win-x64-online.exe'), sha256: digest('a'), size: 100 }] },
  harness: [{ version: '0.1.1-rc.2', channel: 'stable', installed: false, active: false, rollbackReady: false, notes: ['old'] }],
  plugins: [{ id: 'unchanged' }], models: [{ id: 'unchanged-model' }],
  runtimeModules: [module('node-runtime', '24.16.0'), module('harness-core', '0.1.1-rc.2'), module('package-manager', '11.22.0'), module('launcher-ui', 'ui-aaaaaaaaaaaaaaaa'), module('agent-host', '1.0.0+aaaaaaaaaaaa')]
}
before.modelTemplates = [{ ...metadata.modelProviderTemplates.find(item => item.id === 'deepseek-official'), catalogUpdatedAt: '2026-08-22', suggestedModels: [{ id: 'deepseek-v4-flash', name: 'Old Flash' }] }]
const alphaBefore = structuredClone(before)
alphaBefore.runtimeModules[1] = module('harness-core', '0.2.1-alpha.2')
alphaBefore.harness.unshift({ version: '0.2.1-alpha.2', channel: 'preview', installed: false, active: false, rollbackReady: false, notes: ['alpha'] })
const replacements = [module('harness-core', DSH_VERSION, digest('b')), module('launcher-ui', 'ui-bbbbbbbbbbbbbbbb', digest('b')), module('agent-host', '1.0.0+bbbbbbbbbbbb', digest('b'))]
const online = { sha256: digest('c'), size: 200 }
const payloads = () => makePayloads(before, replacements, online, '2026-10-20T08:00:00.000Z', alphaBefore, metadata)

test('two catalogs keep legacy .1 intact and isolate .2/UI/Host', () => {
  const { legacy, channel } = payloads()
  assert.equal(legacy.launcher.version, VERSION)
  assert.deepEqual(legacy.runtimeModules, before.runtimeModules)
  assert.deepEqual(legacy.harness, before.harness)
  assert.equal(channel.harness[0].version, DSH_VERSION)
  assert.equal(channel.harness[0].channel, 'preview')
  assert.deepEqual(channel.runtimeModules.filter(item => !REPLACED_IDS.includes(item.id)), before.runtimeModules.filter(item => !REPLACED_IDS.includes(item.id)))
})
test('legacy .2 contamination and unrelated field drift are rejected', () => {
  for (const mutation of [
    value => { value.legacy.runtimeModules[1] = replacements[0] },
    value => { value.channel.runtimeModules[0].version = '24.17.0' },
    value => { value.channel.plugins = [] },
    value => { value.legacy.models = [] },
    value => { value.channel.harness[0].channel = 'stable' },
    value => { value.channel.runtimeModules.reverse() }
  ]) {
    const value = payloads()
    mutation(value)
    assert.throws(() => assertPayloadPair(before, value.legacy, value.channel, online, alphaBefore, metadata))
  }
})
test('replacement archive/tag paths are content-addressed and target constrained', () => {
  assert.equal(replacementItem(replacements[0]).key, `modules/harness-core-${DSH_VERSION}-win-x64-${digest('b').slice(0, 16)}.tar.gz`)
  for (const mutate of [
    item => { item.artifacts[0].mirrors[0].url = 'https://evil.example/modules/x.tar.gz' },
    item => { item.artifacts[0].mirrors[1].url = item.artifacts[0].mirrors[1].url.replace('releases/download/', 'archive/') },
    item => { item.version = '0.2.2-alpha.1' },
    item => { item.probe = { path: 'unexpected.exe' } }
  ]) {
    const value = structuredClone(replacements[0]); mutate(value)
    assert.throws(() => replacementItem(value))
  }
})
test('unverified Gitee mirrors are removed only from replacement descriptors', () => {
  const record = structuredClone(replacements[2])
  record.artifacts[0].mirrors.unshift({ id: 'gitee', url: 'https://gitee.com/not-uploaded' })
  assert.deepEqual(normalizeReplacement(record), replacements[2])
  assert.deepEqual(before.runtimeModules[0], module('node-runtime', '24.16.0'))
})
test('public pointer state permits exact interrupted-release retry, rejects foreign moves', () => {
  const baseline = { status: 200, sha256: digest('a') }
  assert.equal(pointerState({ status: 200, sha256: digest('a') }, baseline, digest('b')), 'baseline')
  assert.equal(pointerState({ status: 200, sha256: digest('b') }, baseline, digest('b')), 'candidate')
  assert.equal(pointerState({ status: 404 }, { status: 404 }, digest('b')), 'baseline')
  for (const actual of [{ status: 200, sha256: digest('c') }, { status: 404 }, { status: 403 }, { status: 500 }]) assert.throws(() => pointerState(actual, baseline, digest('b')))
})
const qaFixture = () => {
  const plan = { sourceCommit: 'a'.repeat(40), createdAt: '2026-10-10T08:00:00.000Z', alias: online, items: [{ role: 'shell', sha256: digest('d') }] }
  const candidates = { channel: { sha256: digest('e') } }
  const gate = {
    schemaVersion: 1, passed: true, planSha256: digest('f'), sourceCommit: plan.sourceCommit,
    catalogUrl: publicUrl(CHANNEL_KEY), catalogSha256: candidates.channel.sha256, sourceId: SOURCE_ID,
    bootstrapSha256: online.sha256, shellSha256: digest('d'), installedLauncherVersion: VERSION, installedDshVersion: DSH_VERSION,
    emptyDirectoryInstall: true, realPublicDownload: true, authenticatedBrowser: true,
    legacyCatalogStillDsh01: true, alpha2CatalogStillCompatible: true, userDataRollback: true, nodeRuntimeUnchanged: true, packageManagerUnchanged: true,
    testedAt: '2026-10-10T08:01:00.000Z', realTask: { kind: 'real-model', passed: true, report: 'output/qa/real-task.json' },
    evidence: [{ file: 'output/qa/real-task.json', size: 100, sha256: digest('a') }]
  }
  return { gate, plan, candidates }
}
test('pointer QA is tied to plan, channel and public installer', () => {
  const { gate, plan, candidates } = qaFixture()
  assert.doesNotThrow(() => assertPublicQa(gate, plan, digest('f'), candidates))
  for (const mutate of [
    value => { value.realTask.kind = 'synthetic' },
    value => { value.emptyDirectoryInstall = false },
    value => { value.sourceId = 'runtime-v2' },
    value => { value.bootstrapSha256 = digest('b') },
    value => { value.installedDshVersion = '0.1.1-rc.2' },
    value => { value.evidence[0].file = 'output/../secret.json' },
    value => { value.testedAt = '2026-09-01T00:00:00.000Z' },
    value => { value.realTask.report = 'unbound-report.json' }
  ]) {
    const value = qaFixture(); mutate(value.gate)
    assert.throws(() => assertPublicQa(value.gate, value.plan, digest('f'), value.candidates))
  }
})

test('alpha2 receives only the new launcher announcement, never RC2 runtime modules', () => {
  const value = payloads()
  assert.deepEqual(value.alpha.runtimeModules, alphaBefore.runtimeModules)
  assert.deepEqual(value.alpha.harness, alphaBefore.harness)
  assertAlphaAnnouncement(alphaBefore, value.alpha, value.legacy)
  value.alpha.runtimeModules[1] = replacements[0]
  assert.throws(() => assertAlphaAnnouncement(alphaBefore, value.alpha, value.legacy))
})

test('only the RC2 catalog gets canonical Flash models and current capabilities', () => {
  const value = payloads()
  assert.deepEqual(value.legacy.modelTemplates, before.modelTemplates)
  assert.deepEqual(value.alpha.modelTemplates, alphaBefore.modelTemplates)
  assert.equal(value.channel.modelTemplates[0].suggestedModels[0].id, 'deepseek-flash')
  assert.deepEqual(value.channel.modelTemplates[0].suggestedModels[0].inputModalities, ['text', 'image'])
  value.channel.modelTemplates = []
  assert.throws(() => assertPayloadPair(before, value.legacy, value.channel, online, alphaBefore, metadata))
})
