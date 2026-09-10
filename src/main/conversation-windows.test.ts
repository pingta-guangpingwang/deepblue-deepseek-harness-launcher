import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { ConversationWindows } from './conversation-windows'
import { normalizeConversationTarget } from '../shared/conversation'
import { normalizeLauncherSkin } from '../shared/launcher-skins'
function fixture() {
  const windows: any[] = [], empty = vi.fn()
  const create = vi.fn(() => {
    let destroyed = false
    const window = Object.assign(new EventEmitter(), { id: windows.length + 1, webContents: { id: windows.length + 101, send: vi.fn() }, show: vi.fn(), focus: vi.fn(), isDestroyed: () => destroyed, close: () => { destroyed = true; window.emit('closed') } })
    windows.push(window); return window as unknown as BrowserWindow
  })
  return { registry: new ConversationWindows(create, empty), windows, create, empty }
}
describe('conversation window ownership and lifecycle', () => {
  const target = { kind: 'local-room', roomId: 'room-1', title: '测试群聊' }
  it('focuses the same conversation and enforces owner scope', () => {
    const { registry, create, windows } = fixture(), first = registry.open(target, 'owner')
    expect(registry.open({ ...target, title: '新标题' }, 'owner')).toEqual({ ...first, reused: true })
    expect(create).toHaveBeenCalledTimes(1); expect(windows[0].focus).toHaveBeenCalledOnce()
    expect(registry.context(101, 'owner')?.roomId).toBe('room-1')
    expect(registry.context(101, 'other')).toBeUndefined(); expect(registry.context(999, 'owner')).toBeUndefined()
  })
  it('broadcasts settings and removes closed views', () => {
    const { registry, windows, empty } = fixture()
    registry.open(target, 'owner'); registry.open({ ...target, roomId: 'room-2' }, 'owner')
    registry.broadcast('launcher:snapshot', { settings: { launcherSkin: 'jade' } })
    expect(windows.every(window => window.webContents.send.mock.calls.length === 1)).toBe(true)
    windows[0].close(); expect(registry.size).toBe(1)
    registry.closeAll(); expect(registry.size).toBe(0); expect(empty).toHaveBeenCalledOnce()
  })
  it('limits windows and rejects paths or missing identifiers', () => {
    const { registry, create } = fixture()
    for (let i = 0; i < 6; i++) registry.open({ ...target, roomId: `room-${i}` }, 'owner')
    expect(() => registry.open({ ...target, roomId: 'room-7' }, 'owner')).toThrow('6'); expect(create).toHaveBeenCalledTimes(6)
    for (const value of [{ kind: 'local-session' }, { kind: 'cloud-session', agentId: 'agent' }, { ...target, roomId: '../../secret' }, { ...target, roomId: 'https://example.com' }]) expect(() => normalizeConversationTarget(value)).toThrow()
  })
  it('normalizes skin choices', () => {
    expect(normalizeLauncherSkin('jade')).toBe('jade'); expect(normalizeLauncherSkin('url(secret)')).toBe('deepseek'); expect(normalizeLauncherSkin(undefined)).toBe('deepseek')
  })
})
