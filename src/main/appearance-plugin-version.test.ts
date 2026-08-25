import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const PLUGIN_MANIFEST = path.resolve('bundled-plugins', 'deepblue-dsh-skin-runtime', 'package.json')
const CONTROLLER = path.resolve('src', 'main', 'controller.ts')
const CLIENT = path.resolve('bundled-plugins', 'deepblue-dsh-skin-runtime', 'lib', 'client.js')
const SERVER = path.resolve('bundled-plugins', 'deepblue-dsh-skin-runtime', 'lib', 'index.js')

async function pluginVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(PLUGIN_MANIFEST, 'utf8')) as { version: string }
  return manifest.version
}

describe('appearance plugin version', () => {
  it('matches the version the launcher looks for, so a bump cannot silently disable skins and pets', async () => {
    const version = await pluginVersion()
    const controller = await readFile(CONTROLLER, 'utf8')
    const expected = controller.match(/const expectedVersion = '([^']+)'/)
    expect(expected?.[1]).toBe(version)
  })

  it('ships a packaging script so the tarball name cannot drift from the manifest', async () => {
    const version = await pluginVersion()
    const script = await readFile(path.resolve('scripts', 'pack-appearance-plugin.mjs'), 'utf8')
    expect(script).toContain('deepblue-dsh-skin-runtime')
    const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(packageJson.scripts['plugin:pack']).toContain('pack-appearance-plugin.mjs')
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('animated wallpaper and pet frame hold', () => {
  it('replaces decoder-driven frames with a still canvas instead of relying on CSS', async () => {
    const client = await readFile(CLIENT, 'utf8')
    expect(client).toContain('useAnimationHold')
    expect(client).toContain('prefers-reduced-motion: reduce')
    expect(client).toContain('visibilitychange')
    expect(client).toContain('drawImage')
  })

  it('hides the animated source and shows the canvas while held, for both wallpaper and pet', async () => {
    const client = await readFile(CLIENT, 'utf8')
    expect(client).toContain(".deepblue-skin-wallpaper[data-held='true'] > canvas { display: block; }")
    expect(client).toContain(".deepblue-skin-wallpaper[data-held='true'] > img { display: none; }")
    expect(client).toContain(".deepblue-pet[data-held='true'] .deepblue-pet-visual > canvas { display: block; }")
    expect(client).toContain(".deepblue-pet[data-held='true'] .deepblue-pet-visual > img { display: none; }")
  })

  it('only holds animated media, leaving static skins and video on their existing paths', async () => {
    const client = await readFile(CLIENT, 'utf8')
    expect(client).toContain("const animated = config.mediaKind === 'animated-image'")
    expect(client).toContain("const animated = config.mediaKind === 'animated'")
    expect(client).toContain('return active && held')
  })
})

describe('wallpaper clarity control', () => {
  it('registers the two-state control in the always-mounted shell overlay and persists the choice', async () => {
    const client = await readFile(CLIENT, 'utf8')
    expect(client).toContain("name: 'shell.overlay', id: 'deepblue-skin-clarity-toggle'")
    expect(client).toContain("id: 'deepblue-skin-clarity-toggle'")
    expect(client).toContain("localStorage.setItem(CLARITY_STORAGE_KEY")
    expect(client).toContain("'清透壁纸'")
    expect(client).toContain("'恢复蒙版'")
  })

  it('renders signed pixel atlases as individual animated frames', async () => {
    const client = await readFile(CLIENT, 'utf8')
    expect(client).toContain("config.packKind === 'pixel-atlas'")
    expect(client).toContain("image.naturalHeight % 11 === 0")
    expect(client).toContain("data-pack-kind='pixel-atlas'")
    expect(client).toContain('visibleAtlasFrames')
    expect(client).toContain('chooseDifferent(rows, lastInteractionRow.current)')
    expect(client).toContain("interactRef.current?.('presence')")
  })

  it('keeps pet execution limited to images and verified pixel atlases', async () => {
    const client = await readFile(CLIENT, 'utf8')
    expect(client).toContain("['image', 'pixel-atlas'].includes(pet.packKind)")
    expect(client).not.toContain('import(config.runtimeUrl)')
    expect(client).not.toContain('model.playMotion')
  })

  it('queries DeepSeek balance on every third direct pet click without exposing the API key to browser code', async () => {
    const [client, server] = await Promise.all([readFile(CLIENT, 'utf8'), readFile(SERVER, 'utf8')])
    expect(client).toContain("clickCount.current = clickCount.current % 3 + 1")
    expect(client).toContain('clickCount.current === 3')
    expect(client).toContain("fetch('/deepblue-pet/balance'")
    expect(server).toContain("const PET_BALANCE_PATH = '/deepblue-pet/balance'")
    expect(server).toContain('DEEPBLUE_DSH_PET_BALANCE_TOKEN')
    expect(client).not.toContain('DEEPSEEK_API_KEY')
  })

  it('removes both the wallpaper overlay and opaque content surfaces in clear mode', async () => {
    const client = await readFile(CLIENT, 'utf8')
    expect(client).toContain("clear ? 'transparent'")
    expect(client).toContain('--deepblue-skin-bg-layer-1-light')
    expect(client).toContain("var(--deepblue-skin-bg-layer-1-light)")
  })
})
