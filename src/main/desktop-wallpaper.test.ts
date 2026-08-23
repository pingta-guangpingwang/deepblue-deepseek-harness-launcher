import { describe, expect, it } from 'vitest'
import { desktopWallpaperSource } from './desktop-wallpaper'

describe('desktop wallpaper source selection', () => {
  it('uses the original local file for static and animated image skins', () => {
    expect(desktopWallpaperSource('image', 'C:\\skins\\still.webp')).toEqual({ sourcePath: 'C:\\skins\\still.webp', usedPoster: false })
    expect(desktopWallpaperSource('animated-image', 'C:\\skins\\motion.gif')).toEqual({ sourcePath: 'C:\\skins\\motion.gif', usedPoster: false })
  })

  it('uses the downloaded HD poster for video skins', () => {
    expect(desktopWallpaperSource('video', 'C:\\skins\\motion.mp4', 'C:\\skins\\poster.webp')).toEqual({ sourcePath: 'C:\\skins\\poster.webp', usedPoster: true })
  })

  it('rejects video skins that do not provide a safe desktop image', () => {
    expect(() => desktopWallpaperSource('video', 'C:\\skins\\motion.mp4')).toThrow('没有高清封面')
  })
})
