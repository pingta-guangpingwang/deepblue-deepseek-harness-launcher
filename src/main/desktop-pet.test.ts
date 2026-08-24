import { describe, expect, it } from 'vitest'
import { desktopPetDocument } from './desktop-pet'

const base = {
  schemaVersion: 1 as const,
  petId: 'px-0001',
  name: '像素伙伴',
  mediaKind: 'animated' as const,
  packKind: 'pixel-atlas' as const,
  mediaPath: 'C:\\pets\\cache\\pet.webp',
  behavior: {
    widthPx: 168,
    idleMotion: 'float' as const,
    clickMotion: 'heart' as const,
    speechLines: ['一起工作吧'],
    autoSpeakIntervalSec: 60
  },
  appliedAt: '2026-08-24T00:00:00.000Z'
}

describe('desktop pet host', () => {
  it('renders a sandboxed pixel-atlas animation and desktop interactions', () => {
    const document = desktopPetDocument(base)
    expect(document).toContain("default-src 'none'")
    expect(document).toContain("pet.classList.add('pixel')")
    expect(document).toContain('const columns=8')
    expect(document).toContain('拖动位置')
    expect(document).toContain("pet.addEventListener('click',react)")
    expect(document).not.toContain('nodeIntegration')
  })

  it('escapes pet copy before embedding it into executable HTML', () => {
    const document = desktopPetDocument({ ...base, behavior: { ...base.behavior, speechLines: ['</script><script>alert(1)</script>'] } })
    expect(document).not.toContain('</script><script>alert(1)</script>')
    expect(document).toContain('\\u003c/script>')
  })
})
