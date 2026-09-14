import assert from 'node:assert/strict'
import { createHash, createPublicKey } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fetchBoundedBytes } from './bounded-fetch.mjs'
import { verifyRuntimeCatalogManifest } from './runtime-catalog-validation.mjs'

const root = path.resolve(import.meta.dirname, '..')
const release = path.join(root, 'release')
const sourceCommit = 'ec5ec468ba2f8dc05616b324d5e1b21e5a133c94'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async file => JSON.parse(await readFile(path.join(release, file), 'utf8'))
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceCommit)
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '?? scripts/prepare-release-036.mjs')

const catalogUrl = 'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/release-v2/launcher-manifest.json'
const aliasUrl = 'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/download/deepblue-deepseek-harness-launcher-win-x64-online.exe'
const response = await fetchBoundedBytes(catalogUrl, { maxBytes: 256 * 1024, redirect: 'error', timeoutMs: 30_000 })
assert.equal(response.response.status, 200)
const before = JSON.parse(response.bytes)
const key = createPublicKey(await readFile(path.join(root, 'resources/runtime-update-public-key.pem')))
assert.ok(verifyRuntimeCatalogManifest(before, key))
assert.equal(before.payload.launcher.version, '0.10.35')

const shell = await json('launcher-shell.generated.json')
const windows = await json('windows-artifacts.json')
const embedded = JSON.parse(await readFile(path.join(release, 'win-unpacked/resources/resources/runtime-modules.generated.json'), 'utf8'))
assert.equal(shell.version, '0.10.36')
assert.equal(shell.sha256, '947d57a2d71a392d5c4841b076bb4ca545787dbc21fbbab3ab6a461d9fa08a67')
const online = windows.find(item => item.edition === 'online')
const offline = windows.find(item => item.edition === 'offline')
assert.deepEqual(online, { edition: 'online', fileName: 'deepblue-deepseek-harness-launcher-0.10.36-win-x64-online.exe', size: 698942, sha256: 'deff3a272491a62799a88e4a09f59dee3d74884c8c55ce7acd86a75b4ea47c04' })
assert.deepEqual(offline, { edition: 'offline', fileName: 'deepblue-deepseek-harness-launcher-0.10.36-win-x64-offline.exe', size: 176581722, sha256: 'ebeee98c3a870e55655b6d2f3f9b4b3cbac561fc1942106c8b826dc2ce436817' })
for (const id of ['node-runtime', 'harness-core', 'package-manager']) assert.deepEqual(embedded.modules.find(item => item.id === id), before.payload.runtimeModules.find(item => item.id === id))

const payload = structuredClone(before.payload)
payload.generatedAt = new Date().toISOString()
payload.launcher = {
  ...payload.launcher,
  version: '0.10.36',
  notes: [
    '自动兼容 DSH 0.1.0 的扁平密钥文件与 0.1.1 的 version 1/refs 文件，升级前后按实际核心版本原子迁移且不显示密钥。',
    '发现无可信安装回执的非活动残留模块时先保留隔离副本，再从签名镜像重新下载；当前正在使用的无回执模块仍拒绝覆盖。',
    'Harness 端口必须连续通过稳定期才显示已就绪；首次皮肤插件离线安装失败时改用安装包内归档原子恢复。',
    ...payload.launcher.notes
  ],
  artifacts: [{ platform: 'win32', arch: 'x64', distribution: 'online', url: aliasUrl, sha256: online.sha256, size: online.size }]
}
assert.deepEqual(payload.runtimeModules, before.payload.runtimeModules)

const items = [
  { key: `modules/${shell.fileName}`, file: shell.fileName, sha256: shell.sha256, size: shell.size, githubTag: 'runtime-v0.10.36' },
  ...windows.map(item => ({ key: `download/${item.fileName}`, file: item.fileName, sha256: item.sha256, size: item.size, githubTag: 'v0.10.36' }))
]
for (const item of items) {
  const body = await readFile(path.join(release, item.file))
  assert.equal(body.length, item.size)
  assert.equal(sha(body), item.sha256)
}
const alias = await fetchBoundedBytes(aliasUrl, { maxBytes: 2 * 1024 * 1024, redirect: 'error', timeoutMs: 30_000 })
assert.equal(alias.response.status, 200)
const plan = { schemaVersion: 1, version: '0.10.36', sourceCommit, baselineSha256: sha(response.bytes), baselineGeneratedAt: before.payload.generatedAt, previousAliasSha256: sha(alias.bytes), items, alias: { key: 'download/deepblue-deepseek-harness-launcher-win-x64-online.exe', file: online.fileName, sha256: online.sha256, size: online.size } }
await writeFile(path.join(release, 'launcher-manifest.before-036.json'), response.bytes)
await writeFile(path.join(release, 'launcher-online.before-036.exe'), alias.bytes)
await writeFile(path.join(release, 'launcher-catalog-036-payload.json'), `${JSON.stringify(payload, null, 2)}\n`)
await writeFile(path.join(release, 'release-036-plan.json'), `${JSON.stringify(plan, null, 2)}\n`)
console.log(JSON.stringify({ baselineSha256: plan.baselineSha256, planSha256: sha(await readFile(path.join(release, 'release-036-plan.json'))), items }))
