#!/usr/bin/env node

import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  process.stderr.write('Desktop wallpaper QA is only available on Windows.\n')
  process.exit(0)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executablePath = process.env.QA_LAUNCHER_EXE || path.join(root, 'release', 'win-unpacked', '深蓝DeepSeekHarness启动器.exe')
const outputRoot = path.resolve(root, process.env.QA_WALLPAPER_OUTPUT || path.join('output', 'playwright', 'desktop-wallpaper'))
const appDataRoot = path.join(outputRoot, 'profile', 'appdata')
const localAppDataRoot = path.join(outputRoot, 'profile', 'localappdata')
const launcherDataRoot = path.join(appDataRoot, 'deepseek-harness-launcher')
const systemRoot = path.resolve(process.env.SystemRoot || 'C:\\Windows')
const reg = path.join(systemRoot, 'System32', 'reg.exe')
const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const wallpaperHelper = path.join(root, 'scripts', 'set-desktop-wallpaper-qa.ps1')
const captureHelper = path.join(root, 'scripts', 'capture-desktop-qa.ps1')
const desktopKey = 'HKCU\\Control Panel\\Desktop'
const valueNames = ['Wallpaper', 'WallpaperStyle', 'TileWallpaper']

function readRegistryValue(name) {
  try {
    const output = execFileSync(reg, ['query', desktopKey, '/v', name], { encoding: 'utf8', windowsHide: true })
    const line = output.split(/\r?\n/).find(entry => new RegExp(`^\\s*${name}\\s+REG_`, 'i').test(entry))
    return line?.replace(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s*`, 'i'), '') ?? undefined
  } catch {
    return undefined
  }
}

function writeRegistryValue(name, value) {
  if (value === undefined) {
    try {
      execFileSync(reg, ['delete', desktopKey, '/v', name, '/f'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      // Missing values are already restored.
    }
    return
  }
  execFileSync(reg, ['add', desktopKey, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true, stdio: 'ignore' })
}

function applyWallpaper(wallpaperPath) {
  execFileSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', wallpaperHelper, '-WallpaperPath', wallpaperPath
  ], { windowsHide: true, stdio: 'pipe' })
}

function captureDesktop(filename, compareTo, minimumChangeRatio = 0) {
  const outputPath = path.join(outputRoot, filename)
  const args = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', captureHelper, '-OutputPath', outputPath
  ]
  if (compareTo) args.push('-CompareTo', compareTo, '-MinimumChangeRatio', String(minimumChangeRatio))
  const output = execFileSync(powershell, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const result = JSON.parse(output)
  process.stderr.write(`ok  桌面截图：${result.path}${typeof result.changeRatio === 'number' ? `（可见变化 ${(result.changeRatio * 100).toFixed(1)}%）` : ''}\n`)
  return result.path
}

function assertCompleted(label, skinId, snapshot, expectedMessage) {
  const transfer = snapshot.skins.transfers[skinId]
  if (transfer?.status !== 'completed') {
    throw new Error(`${label}设置失败：${transfer?.message || '未返回任务状态'}`)
  }
  if (!transfer.message.includes(expectedMessage)) {
    throw new Error(`${label}成功文案不符合预期：${transfer.message}`)
  }
}

async function verifyAppliedFile(label, previousPath) {
  const appliedPath = readRegistryValue('Wallpaper')
  if (!appliedPath || appliedPath === previousPath) throw new Error(`${label}没有更新 Windows 桌面壁纸路径`)
  await access(appliedPath)
  if (path.extname(appliedPath).toLowerCase() !== '.png') throw new Error(`${label}没有生成稳定 PNG 壁纸`)
  process.stderr.write(`ok  ${label}已真实写入 Windows 桌面：${appliedPath}\n`)
  return appliedPath
}

await rm(outputRoot, { recursive: true, force: true })
await mkdir(launcherDataRoot, { recursive: true })
await mkdir(localAppDataRoot, { recursive: true })
await writeFile(path.join(launcherDataRoot, 'launcher.json'), JSON.stringify({
  settings: {
    storageRoot: launcherDataRoot,
    storageSetupCompleted: true,
    theme: 'light'
  }
}, null, 2))

const original = Object.fromEntries(valueNames.map(name => [name, readRegistryValue(name)]))
const baselineScreenshot = captureDesktop('desktop-before.png')
let app
try {
  app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${launcherDataRoot}`],
    env: { ...process.env, APPDATA: appDataRoot, LOCALAPPDATA: localAppDataRoot }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.launcher), undefined, { timeout: 20_000 })
  const catalog = await page.evaluate(() => window.launcher.refreshSkins())
  const image = [...catalog.skins.items]
    .filter(item => item.mediaKind === 'image')
    .sort((left, right) => left.media.size - right.media.size)[0]
  const videoWithoutPoster = catalog.skins.items.find(item => item.mediaKind === 'video' && !item.poster)
  if (!image || !videoWithoutPoster) throw new Error('签名目录缺少测试所需的图片或无独立封面视频')

  const imageResult = await page.evaluate(skinId => window.launcher.applySkinToDesktop(skinId), image.id)
  assertCompleted('图片壁纸', image.id, imageResult, '高清壁纸已设为电脑桌面')
  const imagePath = await verifyAppliedFile('图片壁纸', original.Wallpaper)
  const imageScreenshot = captureDesktop('desktop-image-applied.png', baselineScreenshot, 0.18)

  const videoResult = await page.evaluate(skinId => window.launcher.applySkinToDesktop(skinId), videoWithoutPoster.id)
  assertCompleted('无独立封面视频', videoWithoutPoster.id, videoResult, '视频预览图已设为电脑桌面')
  await verifyAppliedFile('无独立封面视频', imagePath)
  captureDesktop('desktop-video-fallback-applied.png', imageScreenshot, 0.18)
  process.stderr.write(`ok  视频回退实测条目：${videoWithoutPoster.id} · ${videoWithoutPoster.name}\n`)
} finally {
  if (app) await app.close().catch(() => undefined)
  for (const name of valueNames) writeRegistryValue(name, original[name])
  if (original.Wallpaper) applyWallpaper(original.Wallpaper)
  captureDesktop('desktop-restored.png')
  process.stderr.write('ok  已恢复测试前的 Windows 桌面壁纸设置\n')
}

process.stderr.write('打包应用的图片壁纸与视频预览图桌面设置实测全部通过\n')
