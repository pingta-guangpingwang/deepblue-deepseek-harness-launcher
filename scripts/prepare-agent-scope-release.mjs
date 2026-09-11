// One-release plan: preserve the public kernel and dependency graph.
import assert from 'node:assert/strict'
import { createHash, createPublicKey } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fetchBoundedBytes } from './bounded-fetch.mjs'
import { verifyRuntimeCatalogManifest } from './runtime-catalog-validation.mjs'
const root = path.resolve(import.meta.dirname, '..'), release = path.join(root, 'release')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const getJson = async file => JSON.parse(await readFile(path.join(release, file), 'utf8'))
const response = await fetchBoundedBytes('https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/release-v2/launcher-manifest.json', { maxBytes: 256 * 1024, redirect: 'error' })
assert.equal(response.response.status, 200)
assert.equal(sha(response.bytes), '42056ba1842b92e3cccdfaacbfde772e8d5886269f0c5ace283307c466d96f28')
const before = JSON.parse(response.bytes)
assert.ok(verifyRuntimeCatalogManifest(before, createPublicKey(await readFile(path.join(root, 'resources/runtime-update-public-key.pem')))))
assert.equal(before.payload.launcher.version, '0.10.35')
const host = await getJson('agent-host.generated.json'), ui = await getJson('launcher-ui.generated.json')
assert.equal(host.version, '1.0.0+959b71ba7db1'); assert.equal(ui.version, 'ui-8592a61d157c49f8')
assert.equal(host.artifacts[0].sha256, '0dc72e26ea1e23ca4d922304b05af9a3187d3398930c13a4c603ec9859047395')
assert.equal(ui.artifacts[0].sha256, '0ec7026615e69b504439fa5443836f6c102898109056a0db685d55187c9598ef')
const payload = structuredClone(before.payload), items = []
payload.generatedAt = new Date().toISOString()
for (const module of [host, ui]) {
  const artifact = module.artifacts[0]
  artifact.mirrors = ['oss', 'github'].map(id => artifact.mirrors.find(mirror => mirror.id === id))
  assert.ok(artifact.mirrors.every(Boolean))
  const name = decodeURIComponent(new URL(artifact.mirrors[0].url).pathname.split('/').pop())
  assert.ok(!name.includes('/') && !name.includes('\\'))
  const file = 'modules/' + name, bytes = await readFile(path.join(release, file))
  assert.equal(sha(bytes), artifact.sha256); assert.equal(bytes.length, artifact.size)
  payload.runtimeModules = payload.runtimeModules.map(current => current.id === module.id ? module : current)
  items.push({ key: file, file, sha256: artifact.sha256, size: artifact.size, githubTag: (module.id === 'agent-host' ? 'agent-host-' : 'launcher-ui-') + module.version })
}
assert.deepEqual(payload.launcher, before.payload.launcher)
const plan = { schemaVersion: 1, releaseId: 'agent-scope-20260911', sourceCommit: '02d4aad294a5984ead0d11b2fc8c093467c8c00a', baselineSha256: sha(response.bytes), items }
await writeFile(path.join(release, 'launcher-manifest.before-agent-scope.json'), response.bytes, { flag: 'wx' })
await writeFile(path.join(release, 'launcher-catalog-agent-scope-payload.json'), JSON.stringify(payload, null, 2) + '\n', { flag: 'wx' })
const planBytes = Buffer.from(JSON.stringify(plan, null, 2) + '\n')
await writeFile(path.join(release, 'release-agent-scope-plan.json'), planBytes, { flag: 'wx' })
console.log(JSON.stringify({ planSha256: sha(planBytes), baselineSha256: plan.baselineSha256, items }))
