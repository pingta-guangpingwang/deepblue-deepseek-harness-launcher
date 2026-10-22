import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { GameWindows, gamePlayerUrl, isGamePlayerUrl } from './game-window'

function fixture() {
  const windows: any[] = [], options: any[] = [], menus: any[] = []
  const external = vi.fn(async () => {})
  const parent = Object.assign(new EventEmitter(), { id: 9, isDestroyed: () => false })
  const createWindow = vi.fn((input: any) => {
    options.push(input)
    let destroyed = false
    const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn(), session: Object.assign(new EventEmitter(), { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }) })
    const window = Object.assign(new EventEmitter(), { webContents: contents, loadURL: vi.fn(async () => {}), setTitle: vi.fn(), focus: vi.fn(), show: vi.fn(), isMinimized: () => false, restore: vi.fn(), isDestroyed: () => destroyed, setFullScreen: vi.fn(), isFullScreen: () => false, close: () => { destroyed = true; window.emit('closed') } })
    windows.push(window)
    return window as unknown as BrowserWindow
  })
  const onClosed = vi.fn()
  const registry = new GameWindows({ createWindow, openExternal: external, setMenu: (_window, items) => { menus.push(items) }, onClosed })
  return { registry, parent: parent as unknown as BrowserWindow, windows, options, menus, external, createWindow, onClosed }
}

describe('isolated Shenlan trial windows', () => {
  it('defers snapshot notification until the native parent destruction has finished', async () => {
    const h = fixture(); h.registry.open(h.parent, 'game-one', '测试游戏')
    h.windows[0].close()
    expect(h.registry.size).toBe(0)
    expect(h.onClosed).not.toHaveBeenCalled()
    await new Promise(resolve => setImmediate(resolve))
    expect(h.onClosed).toHaveBeenCalledOnce()
  })
  it('constructs the player destination from a strict slug and rejects URL steering', () => {
    expect(gamePlayerUrl('batch-a-turbo-kart-rush')).toBe('https://shenlanai.com/ai-games/player.html?slug=batch-a-turbo-kart-rush')
    for (const slug of ['', '../secret', 'https://evil.test/', 'game?next=x', 'bad%2fslug', '<script>', null]) expect(() => gamePlayerUrl(slug as string)).toThrow()
    for (const url of ['http://shenlanai.com/ai-games/player.html?slug=game-one', 'https://shenlanai.com.evil.test/ai-games/player.html?slug=game-one', 'https://evil@shenlanai.com/ai-games/player.html?slug=game-one', 'https://shenlanai.com:8443/ai-games/player.html?slug=game-one', 'https://shenlanai.com/ai-games/player.html?slug=other-one', 'https://shenlanai.com/ai-games/player.html?slug=game-one&next=https://evil.test', 'file:///secret', 'javascript:alert(1)']) expect(isGamePlayerUrl(url, 'game-one')).toBe(false)
    expect(isGamePlayerUrl(gamePlayerUrl('game-one') + '#controls', 'game-one')).toBe(true)
  })

  it('opens the game inside an isolated child and reuses its window without logging in or launching a browser', async () => {
    const h = fixture(), first = h.registry.open(h.parent, 'game-one', '测试游戏')
    await Promise.resolve()
    expect(h.windows[0].loadURL).toHaveBeenCalledWith(gamePlayerUrl('game-one'))
    expect(h.options[0]).toMatchObject({ parent: h.parent, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    expect(h.options[0].webPreferences.preload).toBeUndefined()
    expect(h.options[0].webPreferences.partition).not.toMatch(/^persist:/)
    expect(h.registry.open(h.parent, 'game-one', '测试游戏')).toBe(first)
    expect(h.createWindow).toHaveBeenCalledOnce()
    expect(h.external).not.toHaveBeenCalled()
  })

  it('blocks top-level redirects, popups, downloads and private device permissions while keeping runtime frames usable', async () => {
    const h = fixture(); h.registry.open(h.parent, 'game-one', '测试游戏')
    const contents = h.windows[0].webContents
    const popup = contents.setWindowOpenHandler.mock.calls[0][0]
    expect(popup({ url: 'https://evil.test/' })).toEqual({ action: 'deny' })
    const allowed = { url: gamePlayerUrl('game-one'), isMainFrame: true, preventDefault: vi.fn() }
    contents.emit('will-navigate', allowed); expect(allowed.preventDefault).not.toHaveBeenCalled()
    const blocked = { url: 'https://evil.test/', isMainFrame: true, preventDefault: vi.fn() }
    contents.emit('will-navigate', blocked); expect(blocked.preventDefault).toHaveBeenCalledOnce()
    const redirect = { url: 'https://shenlanai.com/ai-games/', isMainFrame: true, preventDefault: vi.fn() }
    contents.emit('will-redirect', redirect); expect(redirect.preventDefault).toHaveBeenCalledOnce(); expect(h.external).not.toHaveBeenCalled()
    const download = { preventDefault: vi.fn() }; contents.session.emit('will-download', download); expect(download.preventDefault).toHaveBeenCalledOnce()
    const request = contents.session.setPermissionRequestHandler.mock.calls[0][0], check = contents.session.setPermissionCheckHandler.mock.calls[0][0]
    for (const permission of ['media', 'notifications', 'clipboard-read', 'geolocation', 'openExternal']) { const answer = vi.fn(); request(contents, permission, answer, { requestingUrl: gamePlayerUrl('game-one') }); expect(answer).toHaveBeenCalledWith(false) }
    expect(check(contents, 'fullscreen', 'https://play.shenlanai.com', {})).toBe(true)
    expect(check(contents, 'pointerLock', 'https://evil.test', {})).toBe(false)
  })

  it('provides explicit native retry, fullscreen, external learning and close actions', async () => {
    const h = fixture(); h.registry.open(h.parent, 'game-one', '测试游戏')
    const actions = h.menus[0][0].submenu
    actions.find((x: any) => x.label === '去深蓝试玩学习').click()
    expect(h.external).toHaveBeenCalledWith('https://shenlanai.com/ai-games/')
    actions.find((x: any) => x.label === '重新加载游戏').click()
    expect(h.windows[0].loadURL).toHaveBeenCalledTimes(2)
    actions.find((x: any) => x.label === '全屏试玩').click()
    expect(h.windows[0].setFullScreen).toHaveBeenCalledWith(true)
    actions.find((x: any) => x.label === '关闭试玩').click()
    expect(h.windows[0].isDestroyed()).toBe(true)
    expect(h.parent.listenerCount('closed')).toBe(0)
  })

  it('shows a safe retry page on load failure and closes with its parent', async () => {
    const h = fixture(); h.registry.open(h.parent, 'game-one', '<不可信标题>')
    const window = h.windows[0]; window.loadURL.mockRejectedValueOnce(new Error('DNS unavailable'))
    h.menus[0][0].submenu.find((x: any) => x.label === '重新加载游戏').click()
    await new Promise(resolve => setImmediate(resolve))
    const failure = window.loadURL.mock.calls.find((call: any[]) => call[0].startsWith('data:'))
    expect(decodeURIComponent(failure[0])).toContain('重新加载游戏')
    expect(decodeURIComponent(failure[0])).not.toContain('<不可信标题>')
    h.parent.emit('closed'); expect(window.isDestroyed()).toBe(true)
  })
})
