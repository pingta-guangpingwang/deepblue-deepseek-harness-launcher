#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(import.meta.dirname, '..')

async function requiredText(target, label) {
  try {
    return await readFile(target, 'utf8')
  } catch (error) {
    throw new Error(`${label} is missing: ${target}`, { cause: error })
  }
}

async function requiredJson(target, label) {
  const source = await requiredText(target, label)
  try {
    return JSON.parse(source)
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${target}`, { cause: error })
  }
}

async function requiredFile(target, label) {
  try {
    const info = await stat(target)
    if (!info.isFile()) throw new Error('not a file')
  } catch (error) {
    throw new Error(`${label} is missing: ${target}`, { cause: error })
  }
}

export function electronExecutableRelativePath(platform) {
  switch (platform) {
    case 'darwin':
    case 'mas':
      return 'Electron.app/Contents/MacOS/Electron'
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron'
    case 'win32':
      return 'electron.exe'
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`)
  }
}

async function resolveInstallContext(root, env) {
  const launcherManifestPath = path.join(root, 'package.json')
  const launcherManifest = await requiredJson(launcherManifestPath, 'Launcher package manifest')
  const expectedVersion = launcherManifest.devDependencies?.electron
  if (typeof expectedVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
    throw new Error('package.json must pin devDependencies.electron to an exact version')
  }

  const electronRoot = path.join(root, 'node_modules', 'electron')
  const electronManifestPath = path.join(electronRoot, 'package.json')
  const electronManifest = await requiredJson(electronManifestPath, 'Installed Electron package manifest')
  if (electronManifest.version !== expectedVersion) {
    throw new Error(`Installed Electron package ${electronManifest.version || 'unknown'} does not match pinned ${expectedVersion}`)
  }

  const installScript = path.join(electronRoot, 'install.js')
  await requiredFile(installScript, 'Pinned Electron installer')
  const platform = env.ELECTRON_INSTALL_PLATFORM || env.npm_config_platform || process.platform
  const arch = env.ELECTRON_INSTALL_ARCH || env.npm_config_arch || process.arch
  return {
    root,
    electronRoot,
    installScript,
    distRoot: path.join(electronRoot, 'dist'),
    expectedVersion,
    platform,
    arch,
    env,
    executableRelativePath: electronExecutableRelativePath(platform)
  }
}

async function probeElectronVersion(executable, expectedVersion, sourceEnv) {
  const env = { ...sourceEnv }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, ['--version'], {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const timeout = setTimeout(() => child.kill(), 30_000)
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  }).finally(() => clearTimeout(timeout))
  const actualVersion = stdout.trim().replace(/^v/, '')
  if (result.code !== 0 || result.signal || actualVersion !== expectedVersion) {
    throw new Error(`Electron binary version probe failed: expected ${expectedVersion}, got ${actualVersion || stderr.trim() || `${result.code}/${result.signal}`}`)
  }
  return actualVersion
}

async function verifyContext(context, probeVersion) {
  const installedVersion = (await requiredText(path.join(context.distRoot, 'version'), 'Electron distribution version')).trim().replace(/^v/, '')
  if (installedVersion !== context.expectedVersion) {
    throw new Error(`Electron distribution ${installedVersion || 'unknown'} does not match pinned ${context.expectedVersion}`)
  }
  const installedPath = (await requiredText(path.join(context.electronRoot, 'path.txt'), 'Electron executable pointer')).trim()
  if (installedPath !== context.executableRelativePath) {
    throw new Error(`Electron executable pointer ${installedPath || 'unknown'} does not match ${context.executableRelativePath}`)
  }
  const executable = path.join(context.distRoot, context.executableRelativePath)
  await requiredFile(executable, 'Electron platform binary')
  if (context.platform === process.platform) await probeVersion(executable, context.expectedVersion, context.env)
  return {
    version: context.expectedVersion,
    platform: context.platform,
    arch: context.arch,
    executable
  }
}

async function runPinnedInstaller(context) {
  const child = spawn(process.execPath, [context.installScript], {
    cwd: context.electronRoot,
    env: context.env,
    windowsHide: true,
    stdio: 'inherit'
  })
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  if (result.code !== 0 || result.signal) {
    throw new Error(`Pinned Electron installer failed: ${result.code ?? 'null'}/${result.signal || 'none'}`)
  }
}

export async function verifyElectronDist(options = {}) {
  const root = options.projectRoot || projectRoot
  const env = options.env || process.env
  const context = await resolveInstallContext(root, env)
  return verifyContext(context, options.probeVersion || probeElectronVersion)
}

export async function ensureElectronDist(options = {}) {
  const root = options.projectRoot || projectRoot
  const env = options.env || process.env
  const context = await resolveInstallContext(root, env)
  try {
    return await verifyContext(context, options.probeVersion || probeElectronVersion)
  } catch (error) {
    process.stderr.write(`Electron ${context.expectedVersion} distribution is absent or invalid; running its pinned local installer.\n`)
    await (options.runInstaller || runPinnedInstaller)(context)
    try {
      return await verifyContext(context, options.probeVersion || probeElectronVersion)
    } catch (verificationError) {
      throw new Error(`Electron ${context.expectedVersion} installer completed without a valid ${context.platform}-${context.arch} distribution`, { cause: verificationError })
    }
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath && invokedPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try {
    const result = await ensureElectronDist()
    process.stdout.write(`Electron distribution ready: ${result.version} ${result.platform}-${result.arch} ${result.executable}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
