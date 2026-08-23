import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const node = path.join(root, 'node_modules', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
const pnpm = path.join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
const bundledDsh = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'deepblue-version-smoke-'))
const versionRoot = path.join(temporaryRoot, 'versions', '0.1.0-rc.3')
const dshHome = path.join(temporaryRoot, 'dsh-home')
const allowedBuilds = ['@deepseek-ai/dsh-subprocess-local', '@google/genai', 'koffi', 'node-pty', 'protobufjs']

function environment(appRoot) {
  const env = { ...process.env, DSH_HOME: dshHome }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  env[process.platform === 'win32' ? 'Path' : 'PATH'] = `${path.join(appRoot, 'node_modules', '.bin')}${path.delimiter}${process.env.Path || process.env.PATH || ''}`
  return env
}

async function run(command, args, options) {
  const child = spawn(command, args, { ...options, windowsHide: true })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk.toString() })
  child.stderr.on('data', (chunk) => { output += chunk.toString() })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0) throw new Error(`Command failed with ${code}\n${output}`)
  return output
}

async function stop(child, env) {
  if (process.platform === 'win32' && child.pid) {
    await run('taskkill', ['/pid', String(child.pid), '/t', '/f'], { env }).catch(() => undefined)
  } else {
    child.kill('SIGTERM')
  }
}

async function boot(dsh, appRoot, port) {
  const env = environment(appRoot)
  const child = spawn(node, [dsh, 'web', '--port', String(port), '--no-open'], { cwd: temporaryRoot, env, windowsHide: true })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk.toString() })
  child.stderr.on('data', (chunk) => { output += chunk.toString() })
  try {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Harness exited early with ${child.exitCode}\n${output}`)
      try {
        const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(700) })
        if (response.ok) return response.status
      } catch {
        // The Web bundle normally needs several polling attempts.
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error(`Harness did not become ready\n${output}`)
  } finally {
    await stop(child, env)
  }
}

try {
  await mkdir(versionRoot, { recursive: true })
  await run(node, [pnpm, ...allowedBuilds.map((packageName) => `--allow-build=${packageName}`), 'add', '--dir', versionRoot, '--prod', '--config.node-linker=hoisted', '--registry=https://registry.npmmirror.com', '@deepseek-ai/dsh@0.1.0-rc.3', 'pnpm@11.22.0'], {
    cwd: versionRoot,
    env: environment(root)
  })
  const installedPackage = JSON.parse(await readFile(path.join(versionRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
  if (installedPackage.version !== '0.1.0-rc.3') throw new Error(`Unexpected installed version: ${installedPackage.version}`)
  const installedDsh = path.join(versionRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const installedStatus = await boot(installedDsh, versionRoot, 4314)
  const rollbackStatus = await boot(bundledDsh, root, 4315)
  console.log(`Version smoke passed: install ${installedPackage.version} (HTTP ${installedStatus}) -> rollback 0.1.0-rc.8 (HTTP ${rollbackStatus})`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
