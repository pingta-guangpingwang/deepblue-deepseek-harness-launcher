import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { SkinMediaKind } from '../shared/types'

const execFileAsync = promisify(execFile)

export function desktopWallpaperSource(mediaKind: SkinMediaKind, mediaPath: string, posterPath?: string): { sourcePath: string; usedPoster: boolean } {
  if (mediaKind !== 'video') return { sourcePath: mediaPath, usedPoster: false }
  if (!posterPath) throw new Error('这款视频壁纸没有高清封面，暂时不能设为电脑桌面')
  return { sourcePath: posterPath, usedPoster: true }
}

async function runWindowsTool(executable: string, args: string[]): Promise<void> {
  await execFileAsync(executable, args, { windowsHide: true, timeout: 12_000 })
}

/**
 * Windows does not support video or animated desktop wallpaper without a
 * resident third-party process. Convert the selected image (or video poster)
 * to a stable PNG, then ask the built-in per-user desktop service to apply it.
 */
export async function applyWindowsDesktopWallpaper(sourcePath: string, targetDirectory: string): Promise<string> {
  if (process.platform !== 'win32') throw new Error('“设为电脑桌面”目前支持 Windows 10/11')
  await access(sourcePath)
  const { nativeImage } = await import('electron')
  const image = nativeImage.createFromPath(sourcePath)
  if (image.isEmpty()) throw new Error('无法读取这款壁纸，请重新下载后再试')
  const png = image.toPNG()
  if (!png.length) throw new Error('壁纸转换失败，请换一款图片或检查本机资源')

  await mkdir(targetDirectory, { recursive: true })
  const digest = createHash('sha256').update(png).digest('hex').slice(0, 20)
  const targetPath = path.join(targetDirectory, `wallpaper-${digest}.png`)
  await writeFile(targetPath, png, { flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })

  const systemRoot = path.resolve(process.env.SystemRoot || 'C:\\Windows')
  const reg = path.join(systemRoot, 'System32', 'reg.exe')
  const rundll32 = path.join(systemRoot, 'System32', 'rundll32.exe')
  const desktopKey = 'HKCU\\Control Panel\\Desktop'
  await runWindowsTool(reg, ['add', desktopKey, '/v', 'Wallpaper', '/t', 'REG_SZ', '/d', targetPath, '/f'])
  await runWindowsTool(reg, ['add', desktopKey, '/v', 'WallpaperStyle', '/t', 'REG_SZ', '/d', '10', '/f'])
  await runWindowsTool(reg, ['add', desktopKey, '/v', 'TileWallpaper', '/t', 'REG_SZ', '/d', '0', '/f'])
  await runWindowsTool(rundll32, ['user32.dll,UpdatePerUserSystemParameters', '1', 'True'])
  return targetPath
}
