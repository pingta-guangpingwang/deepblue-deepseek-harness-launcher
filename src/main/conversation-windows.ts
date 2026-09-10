import type { BrowserWindow } from 'electron'
import { conversationKey, normalizeConversationTarget, type ConversationTarget } from '../shared/conversation'

export class ConversationWindows {
  private entries = new Map<string, { window: BrowserWindow; target: ConversationTarget; owner: string }>()
  constructor(private create: (target: ConversationTarget) => BrowserWindow, private onEmpty: () => void = () => {}) {}
  get size(): number { return this.entries.size }
  open(value: unknown, owner: string): { windowId: number; reused: boolean } {
    const target = normalizeConversationTarget(value), key = conversationKey(target, owner), existing = this.entries.get(key)
    if (existing && !existing.window.isDestroyed()) { existing.window.show(); existing.window.focus(); return { windowId: existing.window.id, reused: true } }
    if (this.entries.size >= 6) throw new Error('最多同时打开 6 个独立会话窗口，请先关闭不用的窗口')
    const window = this.create(target); this.entries.set(key, { window, target, owner })
    window.once('closed', () => { if (this.entries.get(key)?.window === window) this.entries.delete(key); if (!this.entries.size) this.onEmpty() })
    return { windowId: window.id, reused: false }
  }
  context(senderId: number, owner: string): ConversationTarget | undefined {
    for (const entry of this.entries.values()) if (!entry.window.isDestroyed() && entry.window.webContents.id === senderId && entry.owner === owner) return entry.target
    return undefined
  }
  broadcast(channel: string, payload?: unknown): void { for (const entry of this.entries.values()) if (!entry.window.isDestroyed()) entry.window.webContents.send(channel, payload) }
  closeAll(): void { for (const entry of this.entries.values()) if (!entry.window.isDestroyed()) entry.window.close(); this.entries.clear() }
}
