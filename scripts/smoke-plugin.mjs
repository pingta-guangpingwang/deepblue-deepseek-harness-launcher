import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const node = path.join(root, 'node_modules', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
const dsh = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const temporary = await mkdtemp(path.join(os.tmpdir(), 'deepblue-plugin-smoke-'))
const plugin = path.join(temporary, 'plugin')
const dshHome = path.join(temporary, 'home')
const profileManifest = path.join(dshHome, 'profiles', 'web', 'package.json')

const env = { ...process.env, DSH_HOME: dshHome, npm_config_registry: 'https://registry.npmmirror.com' }
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
env[pathKey] = `${path.join(root, 'node_modules', '.bin')}${path.delimiter}${process.env.Path || process.env.PATH || ''}`

async function run(args) {
  const child = spawn(node, [dsh, ...args], { cwd: root, env, windowsHide: true })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk.toString() })
  child.stderr.on('data', (chunk) => { output += chunk.toString() })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0) throw new Error(`dsh ${args.join(' ')} failed (${code})\n${output}`)
  return output
}

async function writePlugin(version) {
  await writeFile(path.join(plugin, 'package.json'), `${JSON.stringify({
    name: 'deepblue-dsh-smoke-plugin',
    version,
    type: 'module',
    files: ['cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' } }
  }, null, 2)}\n`)
  await writeFile(path.join(plugin, 'cordis.patch.yml'), '[]\n')
}

function bundles(manifest) {
  return manifest.dsh?.profile?.bundles || []
}

try {
  await import('node:fs/promises').then(({ mkdir }) => mkdir(plugin, { recursive: true }))
  await writePlugin('1.0.0')
  await run(['plugin', '--profile', 'web', 'add', `file:${plugin}`])
  let manifest = JSON.parse(await readFile(profileManifest, 'utf8'))
  if (!bundles(manifest).includes('deepblue-dsh-smoke-plugin')) throw new Error('Plugin bundle was not activated after install')
  await run(['--profile', 'web', '--dump-config'])

  await writePlugin('1.0.1')
  await run(['plugin', '--profile', 'web', 'update', 'deepblue-dsh-smoke-plugin'])
  manifest = JSON.parse(await readFile(profileManifest, 'utf8'))
  if (!bundles(manifest).includes('deepblue-dsh-smoke-plugin')) throw new Error('Plugin bundle disappeared after update')

  await run(['plugin', '--profile', 'web', 'remove', 'deepblue-dsh-smoke-plugin'])
  manifest = JSON.parse(await readFile(profileManifest, 'utf8'))
  if (bundles(manifest).includes('deepblue-dsh-smoke-plugin')) throw new Error('Plugin bundle remained after remove')
  console.log('Plugin smoke passed: install -> compose -> update -> remove')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
