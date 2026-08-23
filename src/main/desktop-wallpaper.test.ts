import { describe, expect, it } from 'vitest'
import bundledCatalog from '../../skin-store/catalog.payload.json'
import { desktopWallpaperSource, imageExtensionFromBytes, setWindowsDesktopWallpaper } from './desktop-wallpaper'
import { desktopWallpaperCapability } from '../shared/desktop-wallpaper'
import { dynamicWallpaperDocument } from './dynamic-wallpaper'
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

  it('routes static images to Windows and original animated media to the dynamic renderer', () => {
    const base = catalogItems[0]!
    expect(desktopWallpaperCapability({ ...base, mediaKind: 'image', media: { ...base.media, mime: 'image/webp' } })).toMatchObject({ supported: true, mode: 'static', label: '设为电脑桌面' })
    expect(desktopWallpaperCapability({ ...base, mediaKind: 'animated-image', media: { ...base.media, mime: 'image/gif' } })).toMatchObject({ supported: true, mode: 'dynamic', label: '设为动态桌面', asset: { mime: 'image/gif' } })
    expect(desktopWallpaperCapability({ ...base, mediaKind: 'video', media: { ...base.media, mime: 'video/mp4' }, poster: undefined, thumbnail: { ...base.thumbnail, mime: 'image/jpeg' } })).toMatchObject({ supported: true, mode: 'dynamic', label: '设为动态桌面', asset: { mime: 'video/mp4' } })
    expect(desktopWallpaperCapability({ ...base, mediaKind: 'video', media: { ...base.media, mime: 'video/mp4' }, poster: { ...base.media, mime: 'video/webm' }, thumbnail: { ...base.thumbnail, mime: 'image/jpeg' } })).toMatchObject({ supported: true, asset: { mime: 'video/mp4' } })
    expect(desktopWallpaperCapability({ ...base, mediaKind: 'video', media: { ...base.media, mime: 'image/jpeg' } })).toMatchObject({ supported: false })
  })

  it('keeps a supported desktop action for all 680 bundled catalog entries', () => {
    expect(catalogItems).toHaveLength(680)
    expect(catalogItems.filter(item => !desktopWallpaperCapability(item).supported)).toEqual([])
  })

  it('calls the real Windows wallpaper API with persistence and broadcast flags', () => {
    const calls: unknown[][] = []
    setWindowsDesktopWallpaper('C:\\skins\\wallpaper.png', (...args) => {
      calls.push(args)
      return true
    })
    expect(calls).toEqual([[0x0014, 0, 'C:\\skins\\wallpaper.png', 0x0003]])
    expect(() => setWindowsDesktopWallpaper('C:\\skins\\blocked.png', () => false)).toThrow('SystemParametersInfoW')
  })
})

describe('dynamic wallpaper host document', () => {
  it('renders video as muted autoplay loop without interpolating the file URL into markup', () => {
    const document = dynamicWallpaperDocument('file:///C:/skins/a%20b.mp4', 'video')
    expect(document).toContain('<video id="wallpaper" autoplay muted loop playsinline></video>')
    expect(document).toContain('media.play().catch(() => undefined)')
    expect(document).toContain('"file:///C:/skins/a%20b.mp4"')
  })

  it('renders animated images and escapes markup-shaped characters in the URL', () => {
    const document = dynamicWallpaperDocument('file:///C:/skins/<motion>.gif', 'animated-image')
    expect(document).toContain('<img id="wallpaper" alt="" />')
    expect(document).toContain('file:///C:/skins/\\u003cmotion>.gif')
    expect(document).not.toContain('file:///C:/skins/<motion>.gif')
  })
})
