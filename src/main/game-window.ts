import type { BrowserWindow, BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron'

export const GAME_CATALOG_URL = 'https://shenlanai.com/ai-games/'
const PLAYER_URL = 'https://shenlanai.com/ai-games/player.html'
const allowedOrigins = new Set(['https://shenlanai.com', 'https://play.shenlanai.com'])
let nextWindow = 0

export function gamePlayerUrl(slug: string): string {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug)) throw new Error('游戏编号无效，请刷新试玩目录')
  return PLAYER_URL + '?slug=' + encodeURIComponent(slug)
}

export function isGamePlayerUrl(value: string, slug: string): boolean {
  try {
    const expected = new URL(gamePlayerUrl(slug)), url = new URL(value)
    return !url.username && !url.password && url.origin === expected.origin && url.pathname === expected.pathname && url.searchParams.size === 1 && url.searchParams.get('slug') === slug
  } catch { return false }
}

interface GameWindowDependencies {
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow
  openExternal(url: string): Promise<unknown>
  setMenu(window: BrowserWindow, items: MenuItemConstructorOptions[]): void
  onClosed?(): void
}

const failurePage = 'data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>游戏暂时无法打开</title><style>body{font:18px system-ui;margin:12vh auto;padding:24px;max-width:640px;color:#123}a{display:inline-block;background:#1461b5;color:white;padding:12px 18px;border-radius:8px;text-decoration:none}</style><h1>游戏暂时无法打开</h1><p>请检查网络，通过上方「游戏试玩」菜单重新加载游戏，或前往深蓝网站试玩学习。</p><a href="https://shenlanai.com/ai-games/">去深蓝试玩学习</a></html>')

export class GameWindows {
  private readonly windows = new Map<string, BrowserWindow>()
  constructor(private readonly dependencies: GameWindowDependencies) {}
  get size(): number { return this.windows.size }

  open(parent: BrowserWindow, slug: string, title: string): BrowserWindow {
    const url = gamePlayerUrl(slug), key = parent.id + '/' + slug
    if (parent.isDestroyed()) throw new Error('启动器窗口已关闭')
    const existing = this.windows.get(key)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show(); existing.focus(); return existing
    }
    if (this.windows.size >= 3) throw new Error('请先关闭一个试玩窗口，最多同时打开三款游戏')
    const window = this.dependencies.createWindow({
      parent, width: 1180, height: 860, minWidth: 860, minHeight: 620,
      title: '正在加载 · ' + title, backgroundColor: '#f7f8fa', autoHideMenuBar: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'deepblue-game-trial-' + (++nextWindow) }
    })
    this.windows.set(key, window)
    const contents = window.webContents, guest = contents.session
    const allowedPermission = (permission: string, origin: string): boolean => {
      try { return ['fullscreen', 'pointerLock'].includes(permission) && allowedOrigins.has(new URL(origin).origin) } catch { return false }
    }
    guest.setPermissionRequestHandler((_contents, permission, answer, details) => answer(allowedPermission(permission, details.requestingUrl)))
    guest.setPermissionCheckHandler((_contents, permission, origin) => allowedPermission(permission, origin))
    guest.on('will-download', event => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', event => {
      if (isGamePlayerUrl(event.url, slug)) return
      event.preventDefault()
      if (event.url === GAME_CATALOG_URL) void this.dependencies.openExternal(GAME_CATALOG_URL).catch(() => {})
    })
    contents.on('will-redirect', event => { if (event.isMainFrame && !isGamePlayerUrl(event.url, slug)) event.preventDefault() })
    contents.on('will-prevent-unload', event => event.preventDefault())
    let generation = 0
    const load = async (): Promise<void> => {
      const run = ++generation
      if (window.isDestroyed()) return
      window.setTitle('正在加载 · ' + title)
      try { await window.loadURL(url); if (!window.isDestroyed() && run === generation) window.setTitle(title + ' · 深蓝游戏试玩') }
      catch {
        if (!window.isDestroyed() && run === generation) {
          window.setTitle('游戏暂时无法打开 · 深蓝')
          await window.loadURL(failurePage).catch(() => {})
        }
      }
    }
    this.dependencies.setMenu(window, [{ label: '游戏试玩', submenu: [
      { label: '重新加载游戏', click: () => { void load() } },
      { label: '全屏试玩', accelerator: 'F11', click: () => window.setFullScreen(!window.isFullScreen()) },
      { label: '去深蓝试玩学习', click: () => { void this.dependencies.openExternal(GAME_CATALOG_URL).catch(() => {}) } },
      { type: 'separator' }, { label: '关闭试玩', click: () => window.close() }
    ] }])
    const closeWithParent = (): void => { if (!window.isDestroyed()) window.close() }
    parent.once('closed', closeWithParent)
    window.once('closed', () => {
      ++generation; this.windows.delete(key); parent.removeListener('closed', closeWithParent)
      // Windows closes native children before their parent reports destroyed.
      // Sending a snapshot to that parent's webContents inside this callback
      // can deadlock Electron. Notify only after native destruction unwinds.
      setImmediate(() => this.dependencies.onClosed?.())
    })
    void load()
    return window
  }
}
