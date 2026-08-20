import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const expectedSource = path.resolve(projectRoot, 'release', 'win-unpacked')
const source = path.resolve(process.argv[2] || expectedSource)

if (source.toLowerCase() !== expectedSource.toLowerCase()) {
  throw new Error(`Refusing to prune outside the generated package: ${source}`)
}

const appRoot = path.join(source, 'resources', 'app')
const nodeModules = path.join(appRoot, 'node_modules')
await access(path.join(nodeModules, 'node', 'bin', 'node.exe'))
await access(path.join(nodeModules, 'pnpm', 'bin', 'pnpm.cjs'))

for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
  if (entry.name === 'node' || entry.name === 'pnpm') continue
  await rm(path.join(nodeModules, entry.name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

const sourceManifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
const packagedManifestPath = path.join(appRoot, 'package.json')
const packagedManifest = JSON.parse(await readFile(packagedManifestPath, 'utf8'))
packagedManifest.dependencies = {
  node: sourceManifest.dependencies.node,
  pnpm: sourceManifest.dependencies.pnpm
}
await writeFile(packagedManifestPath, `${JSON.stringify(packagedManifest, null, 2)}\n`, 'utf8')

try {
  await access(path.join(nodeModules, '@deepseek-ai', 'dsh'))
  throw new Error('Harness remained in the online lightweight package after pruning.')
} catch (error) {
  if (error instanceof Error && error.message.startsWith('Harness remained')) throw error
}

console.log('Online package pruning kept only Node.js and pnpm runtime dependencies.')
