#!/usr/bin/env node
/**
 * Packs the bundled appearance plugin into resources/plugins/ under the exact
 * filename the launcher looks for at first Harness start.
 *
 * This step used to be manual, which made it easy to bump the plugin manifest
 * without producing a matching tarball. The launcher only logs a warning in that
 * case, so skins and pets would silently stop working.
 *
 * Usage:
 *   npm run plugin:pack
 */

import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, rename } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_ROOT = path.join(ROOT, 'bundled-plugins', 'deepblue-dsh-skin-runtime')
const OUTPUT_ROOT = path.join(ROOT, 'resources', 'plugins')

const manifest = JSON.parse(await readFile(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'))
const version = manifest.version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`插件版本号格式不正确：${version}`)

const controller = await readFile(path.join(ROOT, 'src', 'main', 'controller.ts'), 'utf8')
const expected = controller.match(/const expectedVersion = '([^']+)'/)?.[1]
if (expected !== version) {
  throw new Error(`插件版本 ${version} 与 controller.ts 中的 ${expected} 不一致，请同步后重新打包`)
}

await mkdir(OUTPUT_ROOT, { recursive: true })

// Previous versions stay in the repository on purpose so an already-installed
// profile can still resolve the archive it was set up with.
//
// Windows needs a shell to run the npm.cmd shim, and passing arguments through a
// shell concatenates rather than escapes them, so no path is passed here: npm
// writes into the plugin directory and the archive is moved afterwards.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
execFileSync(npm, ['pack'], {
  cwd: PLUGIN_ROOT,
  stdio: ['ignore', 'pipe', 'inherit'],
  shell: process.platform === 'win32'
})

const staged = (await readdir(PLUGIN_ROOT)).find((entry) => entry.endsWith(`${version}.tgz`))
if (!staged) throw new Error('npm pack 没有产出预期的压缩包')

// npm derives the filename from the scoped package name, so normalize it to the
// unscoped form the launcher resolves at startup.
const produced = path.join(OUTPUT_ROOT, `deepblue-dsh-skin-runtime-${version}.tgz`)
await rename(path.join(PLUGIN_ROOT, staged), produced)

process.stderr.write(`已打包 ${path.relative(ROOT, produced)}\n`)
