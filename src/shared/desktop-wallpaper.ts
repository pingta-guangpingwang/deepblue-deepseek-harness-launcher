import type { SkinAsset, SkinCatalogItem } from './types'

const WINDOWS_DESKTOP_IMAGE_MIMES = new Set<SkinAsset['mime']>([
  'image/png',
  'image/jpeg',
  'image/webp'
])

const DYNAMIC_DESKTOP_MIMES = new Set<SkinAsset['mime']>([
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm'
])

export type DesktopWallpaperCapability =
  | {
      supported: true
      asset: SkinAsset
      mode: 'static' | 'dynamic'
      label: '设为电脑桌面' | '设为动态桌面'
      explanation: string
    }
  | {
      supported: false
      reason: string
    }

/**
 * Static images use Windows' built-in desktop service. Animated images and
 * videos use the launcher's resident desktop renderer, so the original signed
 * media is selected instead of silently degrading it to a still frame.
 */
export function desktopWallpaperCapability(
  item: Pick<SkinCatalogItem, 'mediaKind' | 'media' | 'poster' | 'thumbnail'>
): DesktopWallpaperCapability {
  const dynamic = item.mediaKind !== 'image'
  const asset = dynamic
    ? DYNAMIC_DESKTOP_MIMES.has(item.media.mime) ? item.media : undefined
    : WINDOWS_DESKTOP_IMAGE_MIMES.has(item.media.mime) ? item.media : undefined
  if (!asset) {
    return {
      supported: false,
      reason: dynamic
        ? '这款动态资源不是启动器支持的 GIF、WebP、MP4 或 WebM 格式'
        : '这款资源不是 Windows 桌面支持的图片格式，只能应用到 Harness'
    }
  }
  if (dynamic) {
    return {
      supported: true,
      asset,
      mode: 'dynamic',
      label: '设为动态桌面',
      explanation: item.mediaKind === 'video'
        ? '下载原视频并在桌面图标后循环播放；关闭主窗口后由托盘继续运行'
        : '下载原动图并在桌面图标后持续播放；关闭主窗口后由托盘继续运行'
    }
  }
  return {
    supported: true,
    asset,
    mode: 'static',
    label: '设为电脑桌面',
    explanation: '将高清图片设为 Windows 电脑桌面'
  }
}
