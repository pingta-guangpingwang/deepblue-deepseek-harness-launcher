import { app } from 'electron'
import { access, mkdir, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { RuntimeModuleStore } from './runtime-modules'

export interface RuntimePaths {
  node: string
  pnpm: string
  dsh: string
  appRoot: string
  source: 'updated' | 'bundled'
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function appRoot(): string {
  return app.getAppPath()
}

function bundledNode(root: string): string {
  return path.join(root, 'node_modules', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
}

function bundledHarness(root: string): string {
  return path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/** Reports whether this launcher distribution carries a complete Harness runtime. */
export async function hasBundledHarness(): Promise<boolean> {
  return exists(bundledHarness(appRoot()))
}

export async function resolveRuntime(runtimeRoot: string, activeVersion: string): Promise<RuntimePaths> {
  const root = appRoot()
  const moduleStore = new RuntimeModuleStore(runtimeRoot)
  const [nodeModuleRoot, harnessModuleRoot, packageManagerRoot] = await Promise.all([
    moduleStore.activeRoot('node-runtime'),
    moduleStore.activeRoot('harness-core'),
    moduleStore.activeRoot('package-manager')
  ])
  const versionRoot = path.join(runtimeRoot, 'versions', activeVersion)
  const updatedDsh = path.join(versionRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const updatedPnpm = path.join(versionRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  const bundledDsh = bundledHarness(root)
  const bundledPnpm = path.join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  const modularNode = nodeModuleRoot ? path.join(nodeModuleRoot, 'bin', process.platform === 'win32' ? 'node.exe' : 'node') : ''
  const modularDsh = harnessModuleRoot ? path.join(harnessModuleRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') : ''
  const modularPnpm = packageManagerRoot ? path.join(packageManagerRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs') : ''
  const node = modularNode && await exists(modularNode)
    ? modularNode
    : (await exists(bundledNode(root))) ? bundledNode(root) : process.execPath
  const pnpm = modularPnpm && await exists(modularPnpm) ? modularPnpm : bundledPnpm
  const modularPackage = harnessModuleRoot ? path.join(harnessModuleRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json') : ''
  if (modularDsh && await exists(modularDsh) && await readPackageVersion(modularPackage) === activeVersion) {
    return { node, pnpm, dsh: modularDsh, appRoot: harnessModuleRoot!, source: 'updated' }
  }
  if (await exists(updatedDsh)) {
    return {
      node,
      pnpm: (await exists(updatedPnpm)) ? updatedPnpm : pnpm,
      dsh: updatedDsh,
      appRoot: versionRoot,
      source: 'updated'
    }
  }
  return { node, pnpm, dsh: bundledDsh, appRoot: root, source: 'bundled' }
}

export function sanitizedProcessEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key]
  }
  env[process.platform === 'win32' ? 'Path' : 'PATH'] = process.env.Path || process.env.PATH || ''
  return env
}

export function childEnvironment(root: string, dshHome: string): NodeJS.ProcessEnv {
  const binPath = path.join(root, 'node_modules', '.bin')
  const env = sanitizedProcessEnvironment()
  env.ELECTRON_RUN_AS_NODE = undefined
  env.DSH_HOME = dshHome
  env[process.platform === 'win32' ? 'Path' : 'PATH'] = `${binPath}${path.delimiter}${env[process.platform === 'win32' ? 'Path' : 'PATH'] || ''}`
  return env
}

export async function readPackageVersion(packageJson: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(packageJson, 'utf8')) as { version?: string }
    return parsed.version
  } catch {
    return undefined
  }
}

export async function isExecutable(target: string): Promise<boolean> {
  try {
    const info = await stat(target)
    return info.isFile()
  } catch {
    return false
  }
}

export function spawnNode(
  runtime: RuntimePaths,
  args: string[],
  options: { cwd: string; dshHome: string; env?: NodeJS.ProcessEnv }
): ChildProcessWithoutNullStreams {
  const env = { ...childEnvironment(runtime.appRoot, options.dshHome), ...options.env }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key]
  }
  if (runtime.node === process.execPath) env.ELECTRON_RUN_AS_NODE = '1'
  return spawn(runtime.node, args, {
    cwd: options.cwd,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

export async function ensureRuntimeDirectory(runtimeRoot: string, version: string): Promise<string> {
  const target = path.join(runtimeRoot, 'versions', version)
  await mkdir(target, { recursive: true })
  return target
}
