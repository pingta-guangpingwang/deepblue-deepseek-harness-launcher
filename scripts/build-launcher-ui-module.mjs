import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as tar from 'tar'
import { launcherUiMetadata } from './launcher-ui-version.mjs'

const root = path.resolve(import.meta.dirname, '..')
const rendererRoot = path.resolve(process.argv[2] || path.join(root, 'out', 'renderer'))
const releaseRoot = path.join(root, 'release')
const modulesRoot = path.join(releaseRoot, 'modules')
const generatedFile = path.join(releaseRoot, 'runtime-modules.generated.json')
const GITEE_PART_BYTES = 5 * 1024 * 1024

async function sha256File(file) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}

async function bytesUnder(target) {
  const info = await stat(target)
  if (info.isFile()) return info.size
  let total = 0
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.isFile() || entry.isDirectory()) total += await bytesUnder(path.join(target, entry.name))
  }
  return total
}

async function splitForGitee(file, fileName, tag) {
  const targetRoot = path.join(releaseRoot, 'gitee-parts', tag)
  await mkdir(targetRoot, { recursive: true })
  for (const entry of await readdir(targetRoot)) {
    if (entry.startsWith('launcher-ui-')) await rm(path.join(targetRoot, entry), { force: true })
  }
  const handle = await open(file, 'r')
  const parts = []
  try {
    let offset = 0
    let index = 1
    while (true) {
      const buffer = Buffer.allocUnsafe(GITEE_PART_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (bytesRead === 0) break
      const body = buffer.subarray(0, bytesRead)
      const partName = `${fileName}.part${String(index).padStart(3, '0')}`
      await writeFile(path.join(targetRoot, partName), body)
      parts.push({
        url: `https://gitee.com/wanggp123/deepseek-harness-skins-video/raw/runtime-assets/${tag}/${partName}`,
        sha256: createHash('sha256').update(body).digest('hex'),
        size: bytesRead
      })
      offset += bytesRead
      index += 1
    }
  } finally {
    await handle.close()
  }
  if (!parts.length) throw new Error('Refusing to publish an empty launcher UI module')
  return parts
}

const metadata = await launcherUiMetadata(rendererRoot)
await mkdir(modulesRoot, { recursive: true })
const temporary = path.join(modulesRoot, `launcher-ui-${metadata.version}.next.tar.gz`)
await rm(temporary, { force: true })
await tar.c({
  cwd: path.dirname(rendererRoot),
  file: temporary,
  gzip: { level: 9, mtime: 0 },
  portable: true,
  mtime: new Date(0),
  noMtime: false,
  strict: true
}, [path.basename(rendererRoot)])
const archiveSha256 = await sha256File(temporary)
const fileName = `launcher-ui-${metadata.version}-win-x64-${archiveSha256.slice(0, 16)}.tar.gz`
const archive = path.join(modulesRoot, fileName)
await rm(archive, { force: true })
await rename(temporary, archive)
const tag = `launcher-ui-${metadata.version}`
const parts = await splitForGitee(archive, fileName, tag)
const artifact = {
  platform: 'win32',
  arch: 'x64',
  format: 'tar.gz',
  sha256: archiveSha256,
  size: (await stat(archive)).size,
  unpackedSize: await bytesUnder(rendererRoot),
  mirrors: [
    { id: 'gitee', url: parts[0].url, parts },
    { id: 'oss', url: `https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/modules/${fileName}` },
    { id: 'github', url: `https://github.com/pingta-guangpingwang/deepblue-deepseek-harness-launcher/releases/download/${tag}/${fileName}` }
  ]
}
let catalog
try {
  catalog = JSON.parse(await readFile(generatedFile, 'utf8'))
} catch (error) {
  throw new Error(
    `UI-only release requires the existing runtime catalog at ${generatedFile}; run modules:build once or restore the current production catalog before publishing. ${error instanceof Error ? error.message : String(error)}`
  )
}
const preservedModuleIds = new Set(catalog.modules?.map((entry) => entry.id) ?? [])
for (const requiredId of ['node-runtime', 'harness-core', 'package-manager']) {
  if (!preservedModuleIds.has(requiredId)) {
    throw new Error(`Refusing to publish an incomplete UI-only catalog: missing preserved module ${requiredId}`)
  }
}
const release = {
  id: 'launcher-ui',
  version: metadata.version,
  required: true,
  installWhen: 'launcher',
  dependencies: [],
  artifacts: [artifact]
}
catalog.generatedAt = new Date().toISOString()
catalog.modules = [...catalog.modules.filter((entry) => entry.id !== release.id), release]
await writeFile(generatedFile, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
await writeFile(path.join(releaseRoot, 'launcher-ui.generated.json'), `${JSON.stringify({ ...release, treeSha256: metadata.sha256, fileName }, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ generatedFile, archive, tag, version: metadata.version, sha256: archiveSha256, size: artifact.size, unpackedSize: artifact.unpackedSize, parts: parts.length }, null, 2))
