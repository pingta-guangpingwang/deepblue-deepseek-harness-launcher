import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
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
    expect(document).toContain('visible>=minimum')
    expect(document).toContain('pickDifferent(rows,lastInteractionRow)')
    expect(document).toContain('canvas.dataset.animationRow')
    expect(document).toContain('拖动位置 · 三击看余额')
    expect(document).toContain("window.desktopPetHost?.beginDrag")
    expect(document).toContain("triggerPresence:()=>playInteraction('presence')")
    expect(document).toContain('clickCount=clickCount%3+1')
    expect(document).toContain('if(clickCount===3)')
    expect(document).toContain('window.desktopPetHost?.getDeepSeekBalance()')
    expect(document).toContain('正在查询 DeepSeek 余额…')
    expect(document).not.toContain('nodeIntegration')
  })

  it('escapes pet copy before embedding it into executable HTML', () => {
    const document = desktopPetDocument({ ...base, behavior: { ...base.behavior, speechLines: ['</script><script>alert(1)</script>'] } })
    expect(document).not.toContain('</script><script>alert(1)</script>')
    expect(document).toContain('\\u003c/script>')
  })

  it('keeps the desktop pet above regular windows instead of parenting it behind desktop icons', async () => {
    const source = await readFile(new URL('./desktop-pet.ts', import.meta.url), 'utf8')
    expect(source).toContain("window.setAlwaysOnTop(true, 'screen-saver')")
    expect(source).toContain('visibleOnFullScreen: true')
    expect(source).not.toContain("attachToWindowsDesktop(window, 'pet')")
  })
})
