import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { RuntimeModuleRelease } from '../shared/types'
import { RuntimeModuleStore } from './runtime-modules'

const enabled = process.env.RUNTIME_MODULE_SMOKE === '1'
const installationRoots: string[] = []
const nativeFetch = globalThis.fetch

async function run(executable: string, args: string[]): Promise<{ code: number | null; output: string }> {
  const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  return { code, output }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local smoke port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

async function stopTree(pid: number | undefined): Promise<void> {
  if (!pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    await new Promise<void>((resolve) => killer.once('exit', () => resolve()))
    return
  }
  process.kill(pid, 'SIGTERM')
}

afterAll(async () => {
  vi.unstubAllGlobals()
  await Promise.all(installationRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(!enabled)('generated runtime modules', () => {
  it('installs the exact release artifacts and boots the packaged Harness CLI and Web service', { timeout: 240_000 }, async () => {
    const releaseRoot = path.resolve('release')
    const generated = JSON.parse(await readFile(path.join(releaseRoot, 'runtime-modules.generated.json'), 'utf8')) as { modules: RuntimeModuleRelease[] }
    const installationRoot = await mkdtemp(path.join(tmpdir(), 'deepblue-generated-modules-'))
    installationRoots.push(installationRoot)
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url))
      const file = path.join(releaseRoot, 'modules', path.basename(parsed.pathname))
      const bytes = await readFile(file)
      return new Response(Uint8Array.from(bytes).buffer, { status: 200 })
    }))
    const store = new RuntimeModuleStore(installationRoot)
    const harness = generated.modules.find((module) => module.id === 'harness-core')
    const packageManager = generated.modules.find((module) => module.id === 'package-manager')
    if (!harness || !packageManager) throw new Error('Generated catalog is missing required modules')
    const harnessResult = await store.install(harness, generated.modules, 'win32', 'x64')
    const packageManagerResult = await store.install(packageManager, generated.modules, 'win32', 'x64')
    const nodeRoot = await store.activeRoot('node-runtime')
    if (!nodeRoot) throw new Error('Node module was not activated')
    const node = path.join(nodeRoot, 'bin', 'node.exe')
    const nodeResult = await run(node, ['--version'])
    expect(nodeResult.code).toBe(0)
    expect(nodeResult.output.trim()).toBe('v24.16.0')
    const dsh = path.join(harnessResult.root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const harnessVersion = await run(node, [dsh, '--version'])
    expect(harnessVersion.code, harnessVersion.output).toBe(0)
    expect(harnessVersion.output).toContain('0.1.0-rc.8')
    const pnpm = path.join(packageManagerResult.root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    const pnpmVersion = await run(node, [pnpm, '--version'])
    expect(pnpmVersion.code, pnpmVersion.output).toBe(0)
    expect(pnpmVersion.output.trim()).toBe('11.22.0')

    const port = await freePort()
    const dshHome = path.join(installationRoot, 'dsh-home')
    const workspace = path.join(installationRoot, 'workspace')
    await Promise.all([mkdir(dshHome, { recursive: true }), mkdir(workspace, { recursive: true })])
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
    const environment: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: dshHome }
    for (const key of Object.keys(environment)) if (key.toLowerCase() === 'path') delete environment[key]
    environment[pathKey] = process.env[pathKey] || process.env.PATH || ''
    const web = spawn(node, [dsh, 'web', '--port', String(port)], {
      cwd: workspace,
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let webOutput = ''
    web.stdout.on('data', (chunk: Buffer) => { webOutput += chunk.toString() })
    web.stderr.on('data', (chunk: Buffer) => { webOutput += chunk.toString() })
    try {
      let ready = false
      for (let attempt = 0; attempt < 90; attempt += 1) {
        if (web.exitCode !== null) throw new Error(`Harness Web exited with ${web.exitCode}\n${webOutput}`)
        try {
          const response = await nativeFetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(700) })
          if (response.ok) {
            ready = true
            break
          }
        } catch {
          // Startup normally spans several polling attempts.
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      expect(ready, webOutput).toBe(true)
    } finally {
      await stopTree(web.pid)
    }
  })
})
