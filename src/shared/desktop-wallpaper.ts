import type { SkinAsset, SkinCatalogItem } from './types'

const WINDOWS_DESKTOP_IMAGE_MIMES = new Set<SkinAsset['mime']>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
])

export type DesktopWallpaperCapability =
  | {
      supported: true
      asset: SkinAsset
      label: '设为电脑桌面' | '首帧设为桌面' | '封面设为桌面'
      explanation: string
    }
  | {
      supported: false
      reason: string
    }

/**
 * Windows' built-in desktop service accepts a static image. The launcher can
 * therefore use original images, the first frame of an animated image, or a
 * video's signed poster/preview. It must never advertise the action when the
 * catalog does not provide a decodable image asset.
 */
export function desktopWallpaperCapability(
  item: Pick<SkinCatalogItem, 'mediaKind' | 'media' | 'poster' | 'thumbnail'>
): DesktopWallpaperCapability {
  const asset = item.mediaKind === 'video'
    ? [item.poster, item.thumbnail].find((candidate): candidate is SkinAsset => Boolean(candidate && WINDOWS_DESKTOP_IMAGE_MIMES.has(candidate.mime)))
    : WINDOWS_DESKTOP_IMAGE_MIMES.has(item.media.mime) ? item.media : undefined
  if (!asset) {
    return {
      supported: false,
      reason: item.mediaKind === 'video'
        ? '这款视频没有可用的静态封面，只能应用到 Harness'
        : '这款资源不是 Windows 桌面支持的图片格式，只能应用到 Harness'
    }
  }
  if (item.mediaKind === 'video') {
    return {
      supported: true,
      asset,
      label: '封面设为桌面',
      explanation: 'Windows 桌面将显示这款视频的静态封面；视频仍可在 Harness 内播放'
    }
  }
  if (item.mediaKind === 'animated-image') {
    return {
      supported: true,
      asset,
      label: '首帧设为桌面',
      explanation: 'Windows 桌面将显示动图的静态首帧；动画仍可在 Harness 内播放'
    }
  }
  return {
    supported: true,
    asset,
    label: '设为电脑桌面',
    explanation: '将高清图片设为 Windows 电脑桌面'
  }
}
