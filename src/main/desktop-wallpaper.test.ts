import { describe, expect, it } from 'vitest'
import bundledCatalog from '../../skin-store/catalog.payload.json'
import { desktopWallpaperSource, imageExtensionFromBytes } from './desktop-wallpaper'

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
    const videos = bundledCatalog.items.filter(item => item.mediaKind === 'video')
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
})
