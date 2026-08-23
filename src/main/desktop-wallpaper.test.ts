import { describe, expect, it } from 'vitest'
import bundledCatalog from '../../skin-store/catalog.payload.json'
import { desktopWallpaperSource, imageExtensionFromBytes } from './desktop-wallpaper'
import { desktopWallpaperCapability } from '../shared/desktop-wallpaper'
import type { SkinCatalogItem } from '../shared/types'

const catalogItems = bundledCatalog.items as unknown as SkinCatalogItem[]

describe('desktop wallpaper source selection', () => {
  it('uses the original local file for static and animated image skins', () => {
    expect(desktopWallpaperSource('image', 'C:\\skins\\still.webp')).toEqual({ sourcePath: 'C:\\skins\\still.webp', sourceKind: 'media' })
    expect(desktopWallpaperSource('animated-image', 'C:\\skins\\motion.gif')).toEqual({ sourcePath: 'C:\\skins\\motion.gif', sourceKind: 'media' })
  })

  it('uses the downloaded HD poster for video skins', () => {
    expect(desktopWallpaperSource('video', 'C:\\skins\\motion.mp4', 'C:\\skins\\poster.webp', 'C:\\skins\\thumbnail.webp')).toEqual({ sourcePath: 'C:\\skins\\poster.webp', sourceKind: 'poster' })
  })

  it('falls back to the signed preview image when a video has no separate poster', () => {
    expect(desktopWallpaperSource('video', 'C:\\skins\\motion.mp4', undefined, 'C:\\skins\\thumbnail.webp')).toEqual({ sourcePath: 'C:\\skins\\thumbnail.webp', sourceKind: 'thumbnail' })
  })

  it('only rejects a video when neither a poster nor preview image is available', () => {
    expect(() => desktopWallpaperSource('video', 'C:\\skins\\motion.mp4')).toThrow('暂无可用的封面或预览图')
  })

  it('resolves every bundled video including entries without a separate poster', () => {
    const videos = catalogItems.filter(item => item.mediaKind === 'video')
    expect(videos.some(item => !item.poster)).toBe(true)
    for (const item of videos) {
      const selected = desktopWallpaperSource('video', 'C:\\skins\\motion.mp4', item.poster ? 'C:\\skins\\poster.webp' : undefined, 'C:\\skins\\thumbnail.webp')
      expect(['poster', 'thumbnail']).toContain(selected.sourceKind)
    }
  })

  it('detects the real image format when a CDN returns WebP under a JPG file name', () => {
    expect(imageExtensionFromBytes(Buffer.from('524946460400000057454250', 'hex'))).toBe('.webp')
    expect(imageExtensionFromBytes(Buffer.from('89504e470d0a1a0a', 'hex'))).toBe('.png')
    expect(imageExtensionFromBytes(Buffer.from('ffd8ff', 'hex'))).toBe('.jpg')
    expect(imageExtensionFromBytes(Buffer.from('474946383961', 'hex'))).toBe('.gif')
  })

  it('only exposes a truthful Windows desktop action for decodable static assets', () => {
    const base = catalogItems[0]!
    expect(desktopWallpaperCapability({ ...base, mediaKind: 'image', media: { ...base.media, mime: 'image/webp' } })).toMatchObject({ supported: true, label: '设为电脑桌面' })
    expect(desktopWallpaperCapability({ ...base, mediaKind: 'animated-image', media: { ...base.media, mime: 'image/gif' } })).toMatchObject({ supported: true, label: '首帧设为桌面' })
    expect(desktopWallpaperCapability({ ...base, mediaKind: 'video', media: { ...base.media, mime: 'video/mp4' }, poster: undefined, thumbnail: { ...base.thumbnail, mime: 'image/jpeg' } })).toMatchObject({ supported: true, label: '封面设为桌面' })
    expect(desktopWallpaperCapability({ ...base, mediaKind: 'video', media: { ...base.media, mime: 'video/mp4' }, poster: { ...base.media, mime: 'video/webm' }, thumbnail: { ...base.thumbnail, mime: 'image/jpeg' } })).toMatchObject({ supported: true, asset: { mime: 'image/jpeg' } })
    expect(desktopWallpaperCapability({ ...base, mediaKind: 'video', media: { ...base.media, mime: 'video/mp4' }, poster: undefined, thumbnail: { ...base.thumbnail, mime: 'video/webm' } })).toMatchObject({ supported: false })
  })

  it('keeps a supported desktop action for all 680 bundled catalog entries', () => {
    expect(catalogItems).toHaveLength(680)
    expect(catalogItems.filter(item => !desktopWallpaperCapability(item).supported)).toEqual([])
  })
})
