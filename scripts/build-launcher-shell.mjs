import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const releaseRoot = path.join(root, 'release')
const packagedRoot = path.join(releaseRoot, 'win-unpacked')
const stagingRoot = path.join(releaseRoot, '.launcher-shell-stage')
const generatedFile = path.join(releaseRoot, 'launcher-shell.generated.json')
const launcherPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function locate(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return target
    if (entry.isDirectory()) {
      const match = await locate(target, name)
      if (match) return match
    }
  }
  return undefined
}

async function packageClosure(modulesRoot, roots) {
  const selected = new Set()
  const pending = [...roots]
  while (pending.length > 0) {
    const name = pending.pop()
    if (!name || selected.has(name)) continue
    const packageRoot = path.join(modulesRoot, ...name.split('/'))
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
    selected.add(name)
    for (const dependency of Object.keys({ ...(manifest.dependencies || {}), ...(manifest.optionalDependencies || {}) })) {
      if (!selected.has(dependency)) pending.push(dependency)
    }
  }
  return selected
}

async function pruneModules(modulesRoot, selected) {
  for (const entry of await readdir(modulesRoot, { withFileTypes: true })) {
    const target = path.join(modulesRoot, entry.name)
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const child of await readdir(target, { withFileTypes: true })) {
        const packageName = `${entry.name}/${child.name}`
        if (!selected.has(packageName)) await rm(path.join(target, child.name), { recursive: true, force: true })
      }
      if ((await readdir(target)).length === 0) await rm(target, { recursive: true, force: true })
      continue
    }
    if (!selected.has(entry.name)) await rm(target, { recursive: true, force: true })
  }
}

async function run(executable, args) {
  const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0) throw new Error(`${path.basename(executable)} failed with exit code ${code}`)
}

async function sha256(file) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Launcher shell artifacts must be built on Windows x64')
await access(path.join(packagedRoot, '深蓝DeepSeekHarness启动器.exe'))
await rm(stagingRoot, { recursive: true, force: true })
await cp(packagedRoot, stagingRoot, { recursive: true, dereference: true })

const appRoot = path.join(stagingRoot, 'resources', 'app')
const modulesRoot = path.join(appRoot, 'node_modules')
const selected = await packageClosure(modulesRoot, ['tar', 'yaml'])
await pruneModules(modulesRoot, selected)
const packagedManifestPath = path.join(appRoot, 'package.json')
const packagedManifest = JSON.parse(await readFile(packagedManifestPath, 'utf8'))
packagedManifest.dependencies = { tar: launcherPackage.dependencies.tar, yaml: launcherPackage.dependencies.yaml }
await writeFile(packagedManifestPath, `${JSON.stringify(packagedManifest, null, 2)}\n`, 'utf8')

for (const forbidden of ['node', 'pnpm', '@deepseek-ai/dsh']) {
  if (await exists(path.join(modulesRoot, ...forbidden.split('/')))) throw new Error(`Launcher shell still contains ${forbidden}`)
}
for (const required of selected) await access(path.join(modulesRoot, ...required.split('/'), 'package.json'))

const sevenZip = await locate(path.join(root, 'build-cache', '7zip@1.0.0'), '7za.exe')
if (!sevenZip) throw new Error('Bundled 7za.exe was not found; run electron-builder once before packaging the shell')
const temporaryArchive = path.join(releaseRoot, `launcher-shell-${launcherPackage.version}-win-x64.next.7z`)
await rm(temporaryArchive, { force: true })
await run(sevenZip, ['a', '-t7z', '-mx=9', '-mmt=on', temporaryArchive, path.join(stagingRoot, '*')])
const digest = await sha256(temporaryArchive)
const fileName = `launcher-shell-${launcherPackage.version}-win-x64-${digest.slice(0, 16)}.7z`
const archive = path.join(releaseRoot, fileName)
await rm(archive, { force: true })
await rename(temporaryArchive, archive)
const size = (await stat(archive)).size
const unpackedSize = await (async function sizeUnder(target) {
  const info = await stat(target)
  if (info.isFile()) return info.size
  let total = 0
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.isFile() || entry.isDirectory()) total += await sizeUnder(path.join(target, entry.name))
  }
  return total
})(stagingRoot)
const tag = `runtime-v${launcherPackage.version}`
const payload = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  version: launcherPackage.version,
  platform: 'win32',
  arch: 'x64',
  format: '7z',
  fileName,
  sha256: digest,
  size,
  unpackedSize,
  executable: '深蓝DeepSeekHarness启动器.exe',
  mirrors: [
    { id: 'github', url: `https://github.com/pingta-guangpingwang/deepblue-deepseek-harness-launcher/releases/download/${tag}/${fileName}` }
  ],
  includedPackages: [...selected].sort()
}
await writeFile(generatedFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
await rm(stagingRoot, { recursive: true, force: true })
console.log(JSON.stringify({ generatedFile, archive, sha256: digest, size, unpackedSize, includedPackages: payload.includedPackages }, null, 2))
