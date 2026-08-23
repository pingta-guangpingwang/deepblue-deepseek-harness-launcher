import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { SkinMediaKind } from '../shared/types'

const execFileAsync = promisify(execFile)

export type DesktopWallpaperSourceKind = 'media' | 'poster' | 'thumbnail'

export function desktopWallpaperSource(
  mediaKind: SkinMediaKind,
  mediaPath: string,
  posterPath?: string,
  thumbnailPath?: string
): { sourcePath: string; sourceKind: DesktopWallpaperSourceKind } {
  if (mediaKind !== 'video') return { sourcePath: mediaPath, sourceKind: 'media' }
  if (posterPath) return { sourcePath: posterPath, sourceKind: 'poster' }
  if (thumbnailPath) return { sourcePath: thumbnailPath, sourceKind: 'thumbnail' }
  throw new Error('这款视频壁纸暂无可用的封面或预览图，请刷新目录后重试')
}

async function runWindowsTool(executable: string, args: string[]): Promise<void> {
  await execFileAsync(executable, args, { windowsHide: true, timeout: 12_000 })
}

async function decodeImageWithChromium(sourcePath: string): Promise<Buffer> {
  const { BrowserWindow } = await import('electron')
  const decoder = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  try {
    await decoder.loadFile(sourcePath)
    const dataUrl = await decoder.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const image = document.querySelector('img')
        if (!image) return reject(new Error('image element missing'))
        const convert = () => {
          try {
            const maxDimension = 8192
            const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight))
            const canvas = document.createElement('canvas')
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
            canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
            resolve(canvas.toDataURL('image/png'))
          } catch (error) {
            reject(error)
          }
        }
        if (image.complete && image.naturalWidth > 0) convert()
        else {
          image.addEventListener('load', convert, { once: true })
          image.addEventListener('error', () => reject(new Error('image decode failed')), { once: true })
        }
      })
    `, true) as string
    const match = /^data:image\/png;base64,(.+)$/s.exec(dataUrl)
    if (!match) throw new Error('浏览器图片解码未返回 PNG')
    return Buffer.from(match[1]!, 'base64')
  } finally {
    decoder.destroy()
  }
}

export function imageExtensionFromBytes(bytes: Buffer): '.png' | '.jpg' | '.webp' | '.gif' | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return '.gif'
  return undefined
}

/**
 * Windows does not support video or animated desktop wallpaper without a
 * resident third-party process. Convert the selected image (or video poster)
 * to a stable PNG, then ask the built-in per-user desktop service to apply it.
 */
export async function applyWindowsDesktopWallpaper(sourcePath: string, targetDirectory: string): Promise<string> {
  if (process.platform !== 'win32') throw new Error('“设为电脑桌面”目前支持 Windows 10/11')
  await access(sourcePath)
  await mkdir(targetDirectory, { recursive: true })
  const { nativeImage } = await import('electron')
  const sourceBytes = await readFile(sourcePath)
  let image = nativeImage.createFromBuffer(sourceBytes)
  let decodePath: string | undefined
  let png: Buffer | undefined
  try {
    if (image.isEmpty()) {
      const actualExtension = imageExtensionFromBytes(sourceBytes)
      if (actualExtension) {
        const sourceDigest = createHash('sha256').update(sourceBytes).digest('hex').slice(0, 20)
        decodePath = path.join(targetDirectory, `.decode-${sourceDigest}${actualExtension}`)
        await writeFile(decodePath, sourceBytes)
        image = nativeImage.createFromPath(decodePath)
        if (image.isEmpty()) png = await decodeImageWithChromium(decodePath)
      }
    }
  } finally {
    if (decodePath) await unlink(decodePath).catch(() => undefined)
  }
  if (!png && image.isEmpty()) throw new Error('无法读取这款壁纸，请重新下载后再试')
  png ||= image.toPNG()
  if (!png.length) throw new Error('壁纸转换失败，请换一款图片或检查本机资源')

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
