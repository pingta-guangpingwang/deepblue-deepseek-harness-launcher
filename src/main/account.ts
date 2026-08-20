import { BrowserWindow, session, shell } from 'electron'
import type { LauncherAccountState, LauncherResourceEngagement, LauncherResourceItem } from '../shared/types'
import { parseFavoriteIds, validFavoriteId } from './account-favorites'

const ACCOUNT_URL = 'https://account.ailishishu.com/'
const SESSION_URL = 'https://ailishishu.com/ailishishu-stats/api/auth-session.php'
const FAVORITES_URL = 'https://ailishishu.com/ailishishu-stats/api/practice-assets.php'
const ENGAGEMENT_URL = 'https://ailishishu.com/ailishishu-stats/api/content-engagement.php'
const TRUSTED_HOSTS = new Set(['ailishishu.com', 'account.ailishishu.com', 'id.ailishishu.com'])

function publicAccount(value: unknown): LauncherAccountState['user'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  const name = typeof row.name === 'string' ? row.name.trim() : ''
  if (!id || !name) return undefined
  return {
    id,
    name,
    email: typeof row.email === 'string' ? row.email.trim() || undefined : undefined,
    avatarUrl: typeof row.avatarUrl === 'string' ? row.avatarUrl.trim() || undefined : undefined
  }
}

function trusted(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && (TRUSTED_HOSTS.has(parsed.hostname) || parsed.hostname.endsWith('.ailishishu.com'))
  } catch {
    return false
  }
}

export class AccountService {
  private accessToken = ''
  private account: LauncherAccountState = { status: 'checking', sessionRemembered: false }
  private authEpoch = 0

  state(): LauncherAccountState {
    return structuredClone(this.account)
  }

  async refresh(): Promise<LauncherAccountState> {
    try {
      const response = await session.defaultSession.fetch(SESSION_URL, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'deepblue-harness-launcher' },
        body: JSON.stringify({ action: 'refresh' })
      })
      const payload = await response.json() as Record<string, unknown>
      const user = publicAccount(payload.user)
      if (!response.ok || payload.ok !== true || typeof payload.accessToken !== 'string' || !user) {
        this.accessToken = ''
        this.authEpoch += 1
        this.account = { status: response.status === 401 ? 'signed_out' : 'unavailable', sessionRemembered: false, message: response.status === 401 ? undefined : '账号服务暂时不可用' }
        return this.state()
      }
      this.accessToken = payload.accessToken
      this.authEpoch += 1
      this.account = {
        status: 'signed_in',
        user,
        sessionRemembered: true,
        message: '登录状态由 Windows 加密的 HttpOnly 会话保存，启动器不保存明文密码。'
      }
      return this.state()
    } catch {
      this.accessToken = ''
      this.authEpoch += 1
      this.account = { status: 'unavailable', sessionRemembered: false, message: '账号服务连接失败，可稍后重试。' }
      return this.state()
    }
  }

  async signIn(parent: BrowserWindow): Promise<LauncherAccountState> {
    if (this.account.status === 'signed_in') return this.state()
    await new Promise<void>((resolve) => {
      const window = new BrowserWindow({
        parent,
        modal: true,
        width: 520,
        height: 720,
        minWidth: 420,
        minHeight: 600,
        title: '登录 AI历史书账号',
        autoHideMenuBar: true,
        backgroundColor: '#f7f8fa',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      })
      let checking = false
      const verify = async (): Promise<void> => {
        if (checking || window.isDestroyed()) return
        checking = true
        try {
          const cookies = await session.defaultSession.cookies.get({ name: 'ailishishu_rt' })
          if (cookies.some((cookie) => (cookie.domain || '').endsWith('ailishishu.com'))) {
            const state = await this.refresh()
            if (state.status === 'signed_in' && !window.isDestroyed()) window.close()
          }
        } finally {
          checking = false
        }
      }
      const timer = setInterval(() => { void verify() }, 1200)
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (trusted(url)) return { action: 'allow' }
        if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
        return { action: 'deny' }
      })
      window.webContents.on('will-navigate', (event, url) => {
        if (trusted(url)) return
        event.preventDefault()
        if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      })
      window.on('closed', () => { clearInterval(timer); resolve() })
      void window.loadURL(ACCOUNT_URL)
    })
    return this.refresh()
  }

  async signOut(): Promise<LauncherAccountState> {
    try {
      await session.defaultSession.fetch(SESSION_URL, { method: 'DELETE', credentials: 'include', headers: { 'x-requested-with': 'deepblue-harness-launcher' } })
    } catch {
      // Local state is still cleared. The next refresh will verify the server cookie.
    }
    this.accessToken = ''
    this.authEpoch += 1
    this.account = { status: 'signed_out', sessionRemembered: false }
    return this.state()
  }

  async favoriteIds(): Promise<string[]> {
    const payload = await this.authorizedJson(`${FAVORITES_URL}?action=collections`)
    return parseFavoriteIds(payload)
  }

  async toggleFavorite(resourceKey: string): Promise<boolean> {
    if (!validFavoriteId(resourceKey)) throw new Error('资源标识无效')
    const payload = await this.authorizedJson(FAVORITES_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'toggle_collection', resourceKey, resourceSource: 'editorial' })
    })
    if (typeof payload.favorited !== 'boolean') throw new Error('收藏服务返回了无效结果')
    return payload.favorited
  }

  async resourceEngagement(item: LauncherResourceItem): Promise<LauncherResourceEngagement> {
    const url = this.engagementUrl(item)
    const token = this.accessToken
    const ownerId = this.account.user?.id
    const epoch = this.authEpoch
    const headers = new Headers({ 'x-requested-with': 'deepblue-harness-launcher' })
    if (token && ownerId && this.account.status === 'signed_in') headers.set('authorization', `Bearer ${token}`)
    const response = await session.defaultSession.fetch(url, { headers })
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>
    if (token && (epoch !== this.authEpoch || token !== this.accessToken || ownerId !== this.account.user?.id)) throw new Error('账号已切换，请重试')
    if (!response.ok || payload.ok !== true) throw new Error('评价暂时无法读取，请稍后重试')
    return this.parseEngagement(item.id, payload)
  }

  async commentResource(item: LauncherResourceItem, body: string): Promise<LauncherResourceEngagement> {
    const normalized = body.trim()
    if (normalized.length < 2 || normalized.length > 1200) throw new Error('评价需为 2—1200 个字符')
    await this.authorizedJson(ENGAGEMENT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'comment',
        module: 'tools',
        contentType: item.type,
        contentKey: item.id,
        title: item.title,
        summary: item.summary,
        url: `/tools/?type=${encodeURIComponent(item.type)}&resource=${encodeURIComponent(item.id)}`,
        body: normalized
      })
    })
    return this.resourceEngagement(item)
  }

  private engagementUrl(item: LauncherResourceItem): string {
    const url = new URL(ENGAGEMENT_URL)
    url.searchParams.set('module', 'tools')
    url.searchParams.set('contentType', item.type)
    url.searchParams.set('contentKey', item.id)
    url.searchParams.set('title', item.title)
    url.searchParams.set('summary', item.summary)
    url.searchParams.set('url', `/tools/?type=${item.type}&resource=${item.id}`)
    return url.toString()
  }

  private parseEngagement(resourceId: string, payload: Record<string, unknown>): LauncherResourceEngagement {
    const root = payload.engagement && typeof payload.engagement === 'object' && !Array.isArray(payload.engagement) ? payload.engagement as Record<string, unknown> : payload
    const rawCounts = root.counts && typeof root.counts === 'object' && !Array.isArray(root.counts) ? root.counts as Record<string, unknown> : {}
    const count = (value: unknown): number => { const result = Number(value); return Number.isFinite(result) && result >= 0 ? result : 0 }
    const comments = Array.isArray(root.comments) ? root.comments.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      const row = value as Record<string, unknown>
      const id = typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : ''
      const body = typeof row.body_text === 'string' ? row.body_text.trim() : ''
      if (!id || !body) return []
      return [{
        id,
        parentId: row.parent_id == null ? undefined : String(row.parent_id),
        body,
        createdAt: typeof row.created_at === 'string' ? row.created_at : '',
        authorName: typeof row.display_name === 'string' && row.display_name.trim() ? row.display_name.trim() : 'AI历史书用户',
        avatarUrl: typeof row.avatar_url === 'string' && row.avatar_url.startsWith('https://') ? row.avatar_url : undefined,
        mine: row.is_mine === true || row.is_mine === 1
      }]
    }).slice(0, 80) : []
    return {
      resourceId,
      counts: { favorite: count(rawCounts.favorite), like: count(rawCounts.like), comment: count(rawCounts.comment), share: count(rawCounts.share) },
      comments
    }
  }

  private async authorizedJson(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const token = this.accessToken
    const ownerId = this.account.user?.id
    const epoch = this.authEpoch
    if (!token || this.account.status !== 'signed_in' || !ownerId) throw new Error('请先登录 AI历史书账号')
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    headers.set('x-requested-with', 'deepblue-harness-launcher')
    const response = await session.defaultSession.fetch(url, { ...init, headers })
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>
    if (epoch !== this.authEpoch || token !== this.accessToken || ownerId !== this.account.user?.id) throw new Error('账号已切换，请重试')
    if (response.status === 401) {
      this.accessToken = ''
      this.authEpoch += 1
      this.account = { status: 'signed_out', sessionRemembered: false }
      throw new Error('登录已过期，请重新登录 AI历史书')
    }
    if (!response.ok || payload.ok !== true) throw new Error(typeof payload.error === 'string' ? payload.error : 'AI历史书收藏同步失败')
    return payload
  }
}

export async function openContentWindow(parent: BrowserWindow, url: string, title = 'AI历史书内容'): Promise<void> {
  if (!trusted(url)) {
    await shell.openExternal(url)
    return
  }
  const window = new BrowserWindow({
    parent,
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 620,
    title,
    autoHideMenuBar: true,
    backgroundColor: '#f7f8fa',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (trusted(target)) return { action: 'allow' }
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, target) => {
    if (trusted(target)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
  })
  void window.loadURL(url).catch(() => {
    if (!window.isDestroyed()) void window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<main style="font:16px system-ui;padding:40px"><h1>内容暂时无法打开</h1><p>请检查网络后关闭此窗口并重试。</p></main>'))
  })
}
