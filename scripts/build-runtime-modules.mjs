import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as tar from 'tar'

const root = path.resolve(import.meta.dirname, '..')
const expectedPackage = path.join(root, 'release', 'win-unpacked')
const packagedRoot = path.resolve(process.argv[2] || expectedPackage)
const appRoot = path.join(packagedRoot, 'resources', 'app')
const modulesRoot = path.join(root, 'release', 'modules')
const generatedFile = path.join(root, 'release', 'runtime-modules.generated.json')

if (packagedRoot.toLowerCase() !== expectedPackage.toLowerCase()) {
  throw new Error(`Refusing to package runtime modules outside the generated Windows package: ${packagedRoot}`)
}

async function json(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function bytesUnder(target) {
  const info = await stat(target)
  if (info.isFile()) return info.size
  if (!info.isDirectory()) return 0
  let total = 0
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isDirectory()) continue
    total += await bytesUnder(path.join(target, entry.name))
  }
  return total
}

async function sha256(file) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}

async function pack({ id, version, cwd, entries }) {
  const temporary = path.join(modulesRoot, `${id}-${version}-win-x64.next.tar.gz`)
  await rm(temporary, { force: true })
  await tar.c({
    cwd,
    file: temporary,
    gzip: { level: 9, mtime: 0 },
    portable: true,
    mtime: new Date(0),
    noMtime: false,
    strict: true
  }, [...entries].sort())
  const digest = await sha256(temporary)
  const fileName = `${id}-${version}-win-x64-${digest.slice(0, 16)}.tar.gz`
  const target = path.join(modulesRoot, fileName)
  await rm(target, { force: true })
  await rename(temporary, target)
  const unpackedSize = (await Promise.all(entries.map((entry) => bytesUnder(path.join(cwd, entry))))).reduce((sum, value) => sum + value, 0)
  return { id, version, fileName, file: target, sha256: digest, size: (await stat(target)).size, unpackedSize }
}

const launcher = await json(path.join(root, 'package.json'))
const nodePackageRoot = path.join(appRoot, 'node_modules', 'node')
const pnpmPackageRoot = path.join(appRoot, 'node_modules', 'pnpm')
const harnessPackageRoot = path.join(appRoot, 'node_modules', '@deepseek-ai', 'dsh')
const [nodePackage, pnpmPackage, harnessPackage] = await Promise.all([
  json(path.join(nodePackageRoot, 'package.json')),
  json(path.join(pnpmPackageRoot, 'package.json')),
  json(path.join(harnessPackageRoot, 'package.json'))
])

await mkdir(modulesRoot, { recursive: true })
for (const entry of await readdir(modulesRoot)) {
  if (entry.endsWith('.tar.gz')) await rm(path.join(modulesRoot, entry), { force: true })
}

const productionEntries = (await readdir(path.join(appRoot, 'node_modules'), { withFileTypes: true }))
  .filter((entry) => (entry.isDirectory() || entry.isFile()) && !['node', 'pnpm'].includes(entry.name))
  .map((entry) => `node_modules/${entry.name}`)

const [nodeArtifact, harnessArtifact, packageManagerArtifact] = await Promise.all([
  pack({ id: 'node-runtime', version: nodePackage.version, cwd: nodePackageRoot, entries: ['bin', 'package.json'] }),
  pack({ id: 'harness-core', version: harnessPackage.version, cwd: appRoot, entries: productionEntries }),
  pack({ id: 'package-manager', version: pnpmPackage.version, cwd: appRoot, entries: ['node_modules/pnpm'] })
])

function mirrors(artifact) {
  const tag = `runtime-v${launcher.version}`
  return [
    { id: 'gitee', url: `https://gitee.com/wanggp123/deepseek-harness-launcher/raw/runtime-assets/${tag}/${artifact.fileName}` },
    { id: 'oss', url: `https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/modules/${artifact.fileName}` },
    { id: 'github', url: `https://github.com/pingta-guangpingwang/deepblue-deepseek-harness-launcher/releases/download/${tag}/${artifact.fileName}` }
  ]
}

function definition(artifact, required, installWhen, dependencies, probe) {
  return {
    id: artifact.id,
    version: artifact.version,
    required,
    installWhen,
    dependencies,
    artifacts: [{
      platform: 'win32',
      arch: 'x64',
      format: 'tar.gz',
      sha256: artifact.sha256,
      size: artifact.size,
      unpackedSize: artifact.unpackedSize,
      mirrors: mirrors(artifact)
    }],
    ...(probe ? { probe } : {})
  }
}

const modules = [
  definition(nodeArtifact, true, 'harness', [], {
    path: 'bin/node.exe',
    args: ['--version'],
    expectedPattern: `^v${nodePackage.version.replaceAll('.', '\\.')}$`,
    timeoutMs: 10_000
  }),
  definition(harnessArtifact, true, 'harness', ['node-runtime']),
  definition(packageManagerArtifact, false, 'plugin-manager', ['node-runtime'])
]

await writeFile(generatedFile, `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), modules }, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ generatedFile, artifacts: [nodeArtifact, harnessArtifact, packageManagerArtifact] }, null, 2))
