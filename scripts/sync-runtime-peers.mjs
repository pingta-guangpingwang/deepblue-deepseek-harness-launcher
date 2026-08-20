import { access, cp, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const projectRoot = path.resolve(import.meta.dirname, '..')
const packagedModules = path.join(projectRoot, 'release', 'win-unpacked', 'resources', 'app', 'node_modules')
const sourceModules = path.join(projectRoot, 'node_modules')
const lock = JSON.parse(await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8'))

function rootPackageName(lockPath) {
  const match = /^node_modules\/(?:@[^/]+\/)?[^/]+$/.exec(lockPath)
  return match ? lockPath.slice('node_modules/'.length) : undefined
}

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

await mkdir(packagedModules, { recursive: true })
const copied = []
for (const [lockPath, metadata] of Object.entries(lock.packages)) {
  const packageName = rootPackageName(lockPath)
  if (!packageName || metadata.dev === true || metadata.devOptional === true) continue

  const relative = packageName.split('/')
  const source = path.join(sourceModules, ...relative)
  const destination = path.join(packagedModules, ...relative)
  if (!(await exists(source)) || (await exists(destination))) continue

  await mkdir(path.dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true })
  copied.push(packageName)
}

console.log(`Synchronized ${copied.length} production peer packages omitted by the Electron dependency collector.`)
if (copied.length > 0) console.log(copied.join('\n'))
