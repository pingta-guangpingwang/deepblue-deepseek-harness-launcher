import { describe, expect, it } from 'vitest'
import { supportsNativeGameWindow } from './games-version'

describe('native game window kernel compatibility', () => {
  it('requires the window-enabled kernel release', () => {
    expect(supportsNativeGameWindow('0.10.39')).toBe(false)
    expect(supportsNativeGameWindow('0.10.40')).toBe(true)
    expect(supportsNativeGameWindow('0.11.0')).toBe(true)
    expect(supportsNativeGameWindow('unknown')).toBe(false)
  })
})
