import { BrowserWindow, screen } from 'electron'
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { load } from 'koffi'
import type { SkinMediaKind, SkinStoreState } from '../shared/types'

type Hwnd = number | bigint | null

interface DynamicWallpaperConfig {
  schemaVersion: 1
  skinId: string
  mode: 'static' | 'dynamic'
  mediaKind?: Extract<SkinMediaKind, 'animated-image' | 'video'>
  mediaPath?: string
  appliedAt: string
}

function sameHandle(left: Hwnd, right: Hwnd): boolean {
  return left !== null && right !== null && String(left) === String(right)
}

function electronWindowHandle(window: BrowserWindow): number | bigint {
  const bytes = window.getNativeWindowHandle()
  return bytes.length >= 8 ? bytes.readBigUInt64LE(0) : bytes.readUInt32LE(0)
}

function rectFromBuffer(bytes: Buffer): { left: number; top: number; right: number; bottom: number } {
  return {
    left: bytes.readInt32LE(0),
    top: bytes.readInt32LE(4),
    right: bytes.readInt32LE(8),
    bottom: bytes.readInt32LE(12)
  }
}

export function dynamicWallpaperDocument(mediaUrl: string, mediaKind: 'animated-image' | 'video'): string {
  const encodedUrl = JSON.stringify(mediaUrl).replaceAll('<', '\\u003c')
  const media = mediaKind === 'video'
    ? '<video id="wallpaper" autoplay muted loop playsinline></video>'
    : '<img id="wallpaper" alt="" />'
  const startup = mediaKind === 'video'
    ? `const media = document.getElementById('wallpaper'); media.src = ${encodedUrl}; media.play().catch(() => undefined);`
    : `document.getElementById('wallpaper').src = ${encodedUrl};`
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; media-src file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#000}#wallpaper{width:100%;height:100%;display:block;object-fit:cover;object-position:center;user-select:none}
</style></head><body>${media}<script>${startup}</script></body></html>`
}

export function attachToWindowsDesktop(window: BrowserWindow, layer: 'wallpaper' | 'pet' = 'wallpaper'): void {
  if (process.platform !== 'win32') throw new Error('动态桌面目前支持 Windows 10/11')
  const user32 = load('user32.dll')
  try {
    const findWindow = user32.func('void * __stdcall FindWindowW(str16, str16)') as unknown as (className: string, title: string | null) => Hwnd
    const findWindowEx = user32.func('void * __stdcall FindWindowExW(void *, void *, str16, str16)') as unknown as (parent: Hwnd, after: Hwnd, className: string | null, title: string | null) => Hwnd
    const sendMessageTimeout = user32.func('uintptr __stdcall SendMessageTimeoutW(void *, uint32, uintptr, intptr, uint32, uint32, void *)') as unknown as (window: Hwnd, message: number, wParam: number, lParam: number, flags: number, timeout: number, result: null) => number | bigint
    const getWindowLongPtr = user32.func('intptr __stdcall GetWindowLongPtrW(void *, int32)') as unknown as (window: Hwnd, index: number) => number | bigint
    const setWindowLongPtr = user32.func('intptr __stdcall SetWindowLongPtrW(void *, int32, intptr)') as unknown as (window: Hwnd, index: number, value: number) => number | bigint
    const setLayeredWindowAttributes = user32.func('bool __stdcall SetLayeredWindowAttributes(void *, uint32, uint8, uint32)') as unknown as (window: Hwnd, color: number, alpha: number, flags: number) => boolean
    const setParent = user32.func('void * __stdcall SetParent(void *, void *)') as unknown as (window: Hwnd, parent: Hwnd) => Hwnd
    const getParent = user32.func('void * __stdcall GetParent(void *)') as unknown as (window: Hwnd) => Hwnd
    const getWindowRect = user32.func('bool __stdcall GetWindowRect(void *, void *)') as unknown as (window: Hwnd, rect: Buffer) => boolean
    const setWindowPos = user32.func('bool __stdcall SetWindowPos(void *, void *, int32, int32, int32, int32, uint32)') as unknown as (window: Hwnd, after: Hwnd, x: number, y: number, width: number, height: number, flags: number) => boolean

    const progman = findWindow('Progman', null)
    if (!progman) throw new Error('未找到 Windows Progman 桌面窗口')
    sendMessageTimeout(progman, 0x052c, 0x0d, 0x01, 0, 1000, null)

    const wsExNoRedirectionBitmap = 0x00200000
    const raisedDesktop = (Number(getWindowLongPtr(progman, -20)) & wsExNoRedirectionBitmap) !== 0
    let desktopParent: Hwnd
    let shellView: Hwnd = null
    let workerW: Hwnd = null
    if (raisedDesktop) {
      shellView = findWindowEx(progman, null, 'SHELLDLL_DefView', null)
      workerW = findWindowEx(progman, null, 'WorkerW', null)
      desktopParent = progman
    } else {
      let after: Hwnd = null
      for (let index = 0; index < 512; index += 1) {
        const top = findWindowEx(null, after, null, null)
        if (!top) break
        const candidateView = findWindowEx(top, null, 'SHELLDLL_DefView', null)
        if (candidateView) {
          shellView = candidateView
          workerW = findWindowEx(null, top, 'WorkerW', null)
          break
        }
        after = top
      }
      desktopParent = workerW || progman
    }

    const hwnd = electronWindowHandle(window)
    const windowRectBytes = Buffer.alloc(16)
    const parentRectBytes = Buffer.alloc(16)
    if (!getWindowRect(hwnd, windowRectBytes) || !getWindowRect(desktopParent, parentRectBytes)) {
      throw new Error('无法读取动态桌面窗口位置')
    }
    const windowRect = rectFromBuffer(windowRectBytes)
    const parentRect = rectFromBuffer(parentRectBytes)

    const wsChild = 0x40000000
    const wsPopup = 0x80000000
    const wsExLayered = 0x00080000
    const lwaAlpha = 0x00000002
    const currentStyle = Number(getWindowLongPtr(hwnd, -16)) >>> 0
    setWindowLongPtr(hwnd, -16, ((currentStyle | wsChild) & ~wsPopup) >>> 0)
    if (raisedDesktop) {
      const currentExtendedStyle = Number(getWindowLongPtr(hwnd, -20)) >>> 0
      setWindowLongPtr(hwnd, -20, (currentExtendedStyle | wsExLayered) >>> 0)
      setLayeredWindowAttributes(hwnd, 0, 255, lwaAlpha)
    }
    setParent(hwnd, desktopParent)
    if (!sameHandle(getParent(hwnd), desktopParent)) throw new Error('Windows 拒绝把动态画面放到桌面图标后方')

    const swpNoActivate = 0x0010
    const swpShowWindow = 0x0040
    const width = Math.max(1, windowRect.right - windowRect.left)
    const height = Math.max(1, windowRect.bottom - windowRect.top)
    const x = windowRect.left - parentRect.left
    const y = windowRect.top - parentRect.top
    const zOrder = layer === 'pet' ? 0 : raisedDesktop && shellView ? shellView : 1
    if (!setWindowPos(hwnd, zOrder, x, y, width, height, swpNoActivate | swpShowWindow)) {
      throw new Error('Windows 未能定位动态桌面画面')
    }
    if (raisedDesktop && workerW) {
      const swpNoMove = 0x0002
      const swpNoSize = 0x0001
      setWindowPos(workerW, 1, 0, 0, 0, 0, swpNoMove | swpNoSize | swpNoActivate)
    }
  } finally {
    user32.unload()
  }
}

export class DynamicWallpaperManager {
  private windows: BrowserWindow[] = []
  private active?: DynamicWallpaperConfig

  constructor(private readonly statePath: string, private readonly hostDirectory: string) {}

  state(): SkinStoreState['desktopWallpaper'] {
    if (!this.active) return undefined
    return {
      skinId: this.active.skinId,
      mode: this.active.mode,
      running: this.active.mode === 'dynamic' && this.windows.some(window => !window.isDestroyed())
    }
  }

  isRunning(): boolean {
    return this.state()?.running === true
  }

  async initialize(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.statePath, 'utf8')) as DynamicWallpaperConfig
      if (saved.schemaVersion !== 1 || !saved.skinId || (saved.mode !== 'static' && saved.mode !== 'dynamic')) return
      this.active = saved
      if (saved.mode === 'dynamic' && saved.mediaPath && saved.mediaKind) await this.start(saved.mediaPath, saved.mediaKind)
    } catch {
      await this.destroyWindows()
      this.active = undefined
      await unlink(this.statePath).catch(() => undefined)
    }
  }

  async applyDynamic(skinId: string, mediaPath: string, mediaKind: 'animated-image' | 'video'): Promise<void> {
    await access(mediaPath)
    await this.start(mediaPath, mediaKind)
    const config: DynamicWallpaperConfig = {
      schemaVersion: 1,
      skinId,
      mode: 'dynamic',
      mediaKind,
      mediaPath,
      appliedAt: new Date().toISOString()
    }
    try {
      await this.persist(config)
      this.active = config
    } catch (error) {
      await this.destroyWindows()
      throw error
    }
  }

  async recordStatic(skinId: string): Promise<void> {
    await this.destroyWindows()
    const config: DynamicWallpaperConfig = {
      schemaVersion: 1,
      skinId,
      mode: 'static',
      appliedAt: new Date().toISOString()
    }
    await this.persist(config)
    this.active = config
  }

  async stopDynamic(): Promise<void> {
    await this.destroyWindows()
    if (this.active?.mode === 'dynamic') {
      this.active = undefined
      await unlink(this.statePath).catch(() => undefined)
    }
  }

  async clear(): Promise<void> {
    await this.destroyWindows()
    this.active = undefined
    await unlink(this.statePath).catch(() => undefined)
  }

  async dispose(): Promise<void> {
    await this.destroyWindows()
  }

  private async start(mediaPath: string, mediaKind: 'animated-image' | 'video'): Promise<void> {
    if (process.platform !== 'win32') throw new Error('动态桌面目前支持 Windows 10/11')
    await this.destroyWindows()
    await mkdir(this.hostDirectory, { recursive: true })
    const hostFile = path.join(this.hostDirectory, 'dynamic-desktop-host.html')
    await writeFile(hostFile, dynamicWallpaperDocument(pathToFileURL(mediaPath).href, mediaKind), 'utf8')
    try {
      for (const display of screen.getAllDisplays()) {
        const window = new BrowserWindow({
          x: display.bounds.x,
          y: display.bounds.y,
          width: display.bounds.width,
          height: display.bounds.height,
          show: false,
          frame: false,
          focusable: false,
          skipTaskbar: true,
          resizable: false,
          movable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          backgroundColor: '#000000',
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false
          }
        })
        window.setIgnoreMouseEvents(true)
        window.webContents.setAudioMuted(true)
        await window.loadFile(hostFile)
        window.setBounds(display.bounds)
        window.showInactive()
        attachToWindowsDesktop(window, 'wallpaper')
        this.windows.push(window)
      }
      if (!this.windows.length) throw new Error('没有找到可用显示器')
    } catch (error) {
      await this.destroyWindows()
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`动态桌面启动失败：${detail}。请检查 Windows 桌面组件后重试`, { cause: error })
    }
  }

  private async persist(config: DynamicWallpaperConfig): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true })
    const temporary = `${this.statePath}.next`
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    await rename(temporary, this.statePath)
  }

  private async destroyWindows(): Promise<void> {
    for (const window of this.windows.splice(0)) {
      if (!window.isDestroyed()) window.destroy()
    }
  }
}
