import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import YAML from 'yaml'

const qa = await import('./release-040-qa.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url?.endsWith('/release-040-qa.mjs')) return undefined
  throw error
})
test('040 release policy exists and publishes only the new UI module', () => {
  assert.ok(qa, '040 release policy is missing')
  assert.equal(qa.VERSION, '0.10.40')
  assert.deepEqual(qa.REPLACED_IDS, ['launcher-ui'])
})

if (qa) {
  const { VERSION, DSH_VERSION, CHANNEL_KEY, SOURCE_ID, makePayloads, assertPayloadPair,
    assertAlphaAnnouncement, assertGithubReadback, assertPublicQa, publicUrl, pointerState } = qa
  const hash = letter => letter.repeat(64)
  const module = (id, version, letter = 'a') => {
    const file = id === 'agent-host' ? `${id}-${version}-win-x64.tar.gz` : `${id}-${version}-win-x64-${hash(letter).slice(0, 16)}.tar.gz`
    const tag = id === 'agent-host' ? `agent-host-${version}` : id === 'launcher-ui' ? `launcher-ui-${version}` : `runtime-module-${id}-${version}-${hash(letter).slice(0, 16)}`
    return { id, version, required: !['agent-host', 'package-manager'].includes(id),
      installWhen: id === 'package-manager' ? 'plugin-manager' : ['agent-host', 'launcher-ui'].includes(id) ? 'launcher' : 'harness',
      dependencies: ['harness-core', 'package-manager'].includes(id) ? ['node-runtime'] : [],
      artifacts: [{ platform: 'win32', arch: 'x64', format: 'tar.gz', sha256: hash(letter), size: 100, unpackedSize: 200,
        mirrors: [{ id: 'oss', url: publicUrl(`modules/${file}`) },
          { id: 'github', url: `https://github.com/pingta-guangpingwang/deepblue-deepseek-harness-launcher/releases/download/${tag}/${file}` }] }] }
  }
  const baseline = core => ({ schemaVersion: 2, generatedAt: '2026-10-20T01:00:00.000Z',
    launcher: { version: '0.10.39', notes: ['previous release'], artifacts: [] },
    runtimeModules: [module('node-runtime', '24.16.0'), module('harness-core', core), module('package-manager', '11.22.0'),
      module('launcher-ui', 'ui-1111111111111111'), module('agent-host', '1.0.0+111111111111')],
    harness: [{ version: core, notes: ['existing runtime'] }], modelTemplates: [{ id: 'unchanged' }], models: [{ id: 'deepseek-flash' }] })
  const legacy = baseline('0.1.1-rc.2'), alpha = baseline('0.2.1-alpha.2'), rc = baseline(DSH_VERSION)
  const online = { sha256: hash('b'), size: 123 }
  const ui = module('launcher-ui', 'ui-2222222222222222', 'c')
  const payloads = () => makePayloads(legacy, [ui], online, '2026-10-22T02:00:00.000Z', alpha, {}, rc)
  test('40 preserves legacy/alpha graphs and all four non-UI RC2 production descriptors', () => {
    const p = payloads()
    assert.equal(p.channel.launcher.version, VERSION)
    assert.deepEqual(p.channel.harness, rc.harness)
    assert.deepEqual(p.channel.models, rc.models)
    assert.deepEqual(p.legacy.runtimeModules, legacy.runtimeModules)
    assert.deepEqual(p.alpha.runtimeModules, alpha.runtimeModules)
    assert.equal(p.channel.runtimeModules.find(item => item.id === 'launcher-ui').version, ui.version)
    assertAlphaAnnouncement(alpha, p.alpha, p.legacy)
  })
  test('core, Node, pnpm, Host, old runtime graphs and unrelated catalog drift fail closed', () => {
    for (const index of [0, 1, 2, 4]) {
      const p = payloads()
      p.channel.runtimeModules[index].artifacts[0].sha256 = hash('d')
      assert.throws(() => assertPayloadPair(legacy, p.legacy, p.channel, online, alpha, {}, rc))
    }
    for (const field of ['models', 'modelTemplates', 'harness']) {
      const p = payloads(); p.channel[field] = []
      assert.throws(() => assertPayloadPair(legacy, p.legacy, p.channel, online, alpha, {}, rc))
    }
    const p = payloads(); p.legacy.runtimeModules[3] = ui
    assert.throws(() => assertPayloadPair(legacy, p.legacy, p.channel, online, alpha, {}, rc))
    const a = payloads(); a.alpha.runtimeModules[3] = ui
    assert.throws(() => assertAlphaAnnouncement(alpha, a.alpha, a.legacy))
  })
  test('preflight rejects stale baselines, duplicate/unrelated replacements and unchanged UI', () => {
    for (const version of ['0.10.38', '0.10.40']) {
      for (const position of ['legacy', 'alpha', 'rc']) {
        const old = structuredClone({ legacy, alpha, rc }); old[position].launcher.version = version
        assert.throws(() => makePayloads(old.legacy, [ui], online, '2026-10-22T02:00:00.000Z', old.alpha, {}, old.rc))
      }
    }
    for (const replacements of [[ui, ui], [ui, rc.runtimeModules[1]], [rc.runtimeModules[3]]]) {
      assert.throws(() => makePayloads(legacy, replacements, online, '2026-10-22T02:00:00.000Z', alpha, {}, rc))
    }
    assert.throws(() => qa.replacementItem(rc.runtimeModules[1]))
    assert.throws(() => qa.replacementItem(rc.runtimeModules[4]))
    const wrongCore = structuredClone(rc)
    wrongCore.runtimeModules[1].version = '0.2.1-rc.3'
    assert.throws(() => makePayloads(legacy, [ui], online, '2026-10-22T02:00:00.000Z', alpha, {}, wrongCore))
  })
  test('remote pointer conflicts and source/workflow mismatches reject publication evidence', () => {
    assert.equal(pointerState({ status: 200, sha256: hash('a') }, { status: 200, sha256: hash('a') }, hash('b')), 'baseline')
    assert.throws(() => pointerState({ status: 200, sha256: hash('c') }, { status: 200, sha256: hash('a') }, hash('b')))
    const plan = { sourceCommit: 'a'.repeat(40), items: [{ role: 'shell', file: 'shell.7z', sha256: hash('b'), size: 100 }] }
    const run = { head_sha: plan.sourceCommit, path: '.github/workflows/verify-040-public-artifacts.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' }
    const logs = `job PUBLIC_PLAN_VERIFIED ${qa.sha(qa.jsonBytes(plan))}\njob PUBLIC_READBACK_VERIFIED shell.7z ${hash('b')} 100`
    assertGithubReadback(run, logs, plan)
    for (const overrides of [{ head_sha: 'c'.repeat(40) }, { path: '.github/workflows/verify-039-public-artifacts.yml' }, { conclusion: 'failure' }]) {
      assert.throws(() => assertGithubReadback({ ...run, ...overrides }, logs, plan))
    }
    assert.throws(() => assertGithubReadback(run, '', plan))
  })
  const plan = { sourceCommit: 'a'.repeat(40), createdAt: '2026-10-22T01:00:00.000Z', alias: online, items: [{ role: 'shell', sha256: hash('c') }] }
  const gate = () => ({ schemaVersion: 1, passed: true, planSha256: hash('d'), sourceCommit: plan.sourceCommit,
    catalogUrl: publicUrl(CHANNEL_KEY), catalogSha256: hash('e'), bootstrapSha256: online.sha256, shellSha256: hash('c'),
    installedLauncherVersion: VERSION, installedDshVersion: DSH_VERSION, sourceId: SOURCE_ID,
    emptyDirectoryInstall: true, realPublicDownload: true, authenticatedBrowser: true, legacyCatalogStillDsh01: true,
    alpha2CatalogStillCompatible: true, userDataRollback: true, nodeRuntimeUnchanged: true, packageManagerUnchanged: true,
    harnessCoreUnchanged: true, agentHostUnchanged: true,
    realTask: { kind: 'public-shenlan-guest-gameplay', passed: true, report: 'output/qa/gameplay.json', gameSlug: 'sample-game', interactionVerified: true, guestSessionEnded: true },
    gameWindow: { passed: true, report: 'output/qa/sandbox.json', sandboxed: true, contextIsolated: true, nodeIntegrationDisabled: true,
      noPreload: true, popupsDenied: true, unexpectedNavigationDenied: true, downloadsBlocked: true, failureRecovery: true, parentCloseCleanup: true },
    gamesCatalog: { source: 'https://shenlanai.com/api/games.php?action=list', count: 27, serverOrderPreserved: true },
    externalLearningCta: { url: 'https://shenlanai.com/ai-games/', passed: true },
    selfUpdate: { passed: true, report: 'output/qa/self-update.json', proactivePrompt: true, automaticModules: true, interruptedRetry: true,
      kernelDownloadVerified: true, inPlaceInstallerHandoff: true, profilePreserved: true },
    testedAt: '2026-10-22T02:00:00Z', evidence: [{ file: 'output/qa/gameplay.json', size: 10, sha256: hash('a') }, { file: 'output/qa/sandbox.json', size: 10, sha256: hash('b') }, { file: 'output/qa/self-update.json', size: 10, sha256: hash('c') }] })
  test('public gate requires actual guest interaction and a sandboxed native popup with hash-bound evidence', () => {
    assertPublicQa(gate(), plan, hash('d'), { channel: { sha256: hash('e') } })
    for (const change of [g => { g.realTask.kind = 'mocked-api' }, g => { g.realTask.interactionVerified = false },
      g => { g.realTask.guestSessionEnded = false }, g => { g.gameWindow.sandboxed = false }, g => { g.gameWindow.noPreload = false },
      g => { g.gameWindow.downloadsBlocked = false }, g => { g.evidence.pop() }, g => { g.emptyDirectoryInstall = false },
      g => { g.harnessCoreUnchanged = false }, g => { g.agentHostUnchanged = false }, g => { g.gamesCatalog.count = 0 },
      g => { g.externalLearningCta.url = 'https://example.com/' }]) {
      const bad = gate(); change(bad)
      assert.throws(() => assertPublicQa(bad, plan, hash('d'), { channel: { sha256: hash('e') } }))
    }
  })
  test('public gate requires isolated-profile self-update evidence and every updater behavior', () => {
    for (const field of ['passed', 'proactivePrompt', 'automaticModules', 'interruptedRetry', 'kernelDownloadVerified', 'inPlaceInstallerHandoff', 'profilePreserved']) {
      const bad = gate(); bad.selfUpdate[field] = false
      assert.throws(() => assertPublicQa(bad, plan, hash('d'), { channel: { sha256: hash('e') } }))
    }
    const bad = gate(); bad.evidence = bad.evidence.filter(item => item.file !== bad.selfUpdate.report)
    assert.throws(() => assertPublicQa(bad, plan, hash('d'), { channel: { sha256: hash('e') } }))
  })
  test('workflow executes its real plan validator and rejects hash/source/tag/core tuple changes', async () => {
    const workflow = YAML.parse(await readFile(new URL('../.github/workflows/verify-040-public-artifacts.yml', import.meta.url), 'utf8'))
    const shell = workflow.jobs.verify.steps[0].run
    const validator = shell.split("node --input-type=module <<'NODE'\n")[1]?.split('\nNODE')[0]
    assert.ok(validator, 'Workflow plan validator must be an executable inline Node module')
    const file = (role, sha256) => ({ role, sha256, size: 100,
      file: `deepblue-deepseek-harness-launcher-0.10.40-win-x64-${role}.exe`,
      key: `download/deepblue-deepseek-harness-launcher-0.10.40-win-x64-${role}.exe`, githubTag: 'v0.10.40' })
    const shellName = `launcher-shell-0.10.40-win-x64-${hash('a').slice(0, 16)}.7z`
    const candidate = { schemaVersion: 1, version: VERSION, dshVersion: DSH_VERSION, policy: 'legacy-alpha2-preserved-rc2-ui-only-040-v1',
      sourceCommit: 'a'.repeat(40), source: { id: SOURCE_ID, url: publicUrl(CHANNEL_KEY) }, items: [
        { role: 'shell', key: `modules/${shellName}`, file: shellName, githubTag: 'runtime-v0.10.40', sha256: hash('a'), size: 100 },
        file('online', hash('b')), file('offline', hash('c')), qa.replacementItem(ui)] }
    const directory = await mkdtemp(path.join(tmpdir(), 'release-040-workflow-'))
    const validate = (value, overrides = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', validator], {
      cwd: directory, encoding: 'utf8', windowsHide: true, env: { ...process.env, PLAN_JSON: JSON.stringify(value),
        PLAN_SHA256: qa.sha(qa.jsonBytes(value)), GITHUB_SHA: candidate.sourceCommit, ...overrides } })
    try {
      const result = validate(candidate)
      assert.equal(result.status, 0, result.stderr)
      assert.ok(result.stdout.includes(`PUBLIC_PLAN_VERIFIED ${qa.sha(qa.jsonBytes(candidate))}`))
      assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'release-040-plan.json'), 'utf8')), candidate)
      for (const change of [p => { p.items[0].githubTag = 'runtime-v0.10.39' }, p => { p.items[3].role = 'harness-core' },
        p => { p.items[1].key = '../outside.exe' }, p => { p.items.push(p.items[0]) }, p => { p.sourceCommit = 'c'.repeat(40) }]) {
        const bad = structuredClone(candidate); change(bad)
        assert.notEqual(validate(bad).status, 0)
      }
      assert.notEqual(validate(candidate, { PLAN_SHA256: hash('f') }).status, 0)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  test('040 publisher stages four items and preserves frozen 039 helpers', async () => {
    const [prepare, publish, workflow] = await Promise.all(['prepare-release-040.mjs', 'publish-release-040.mjs', '../.github/workflows/verify-040-public-artifacts.yml']
      .map(file => readFile(new URL(file, import.meta.url), 'utf8')))
    assert.ok(prepare.includes("normalizeReplacement(uiRecord.value)"))
    assert.ok(!prepare.includes("generated('agent-host.generated.json')"))
    assert.ok(publish.includes('assert.equal(plan.items.length, 4)'))
    assert.ok(!publish.includes('CONFIRM_RELEASE_039'))
    assert.ok(workflow.includes('release-040-plan.json'))
    assert.ok(!workflow.includes('runtime-v0.10.39'))
  })
}
