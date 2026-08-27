import { BrowserWindow, session, shell } from 'electron'
import type { LauncherAccountState, LauncherCommunityRequest, LauncherCommunityUpload, LauncherResourceEngagement, LauncherResourceItem } from '../shared/types'
import { parseFavoriteIds, validFavoriteId } from './account-favorites'

const ACCOUNT_URL = 'https://account.ailishishu.com/'
const SESSION_URL = 'https://ailishishu.com/ailishishu-stats/api/auth-session.php'
const FAVORITES_URL = 'https://ailishishu.com/ailishishu-stats/api/practice-assets.php'
const ENGAGEMENT_URL = 'https://ailishishu.com/ailishishu-stats/api/content-engagement.php'
const COMMUNITY_FORUM_URL = 'https://ailishishu.com/ailishishu-stats/api/community.php'
const COMMUNITY_CHAT_URL = 'https://ailishishu.com/ailishishu-stats/api/community-playground.php'
const TRUSTED_HOSTS = new Set(['ailishishu.com', 'account.ailishishu.com', 'id.ailishishu.com'])
const COMMUNITY_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const COMMUNITY_IMAGE_MAX_BYTES = 5 * 1024 * 1024
const COMMUNITY_FORUM_GET_ACTIONS = new Set(['bootstrap', 'feed', 'thread'])
const COMMUNITY_FORUM_POST_ACTIONS = new Set(['create_thread', 'create_reply', 'toggle_bookmark', 'toggle_reaction'])
const COMMUNITY_CHAT_POST_ACTIONS = new Set(['send_chat', 'save_sticker', 'delete_sticker'])

function communityError(payload: Record<string, unknown>, fallback: string): string {
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim()
  if (typeof payload.error === 'string' && /[^a-z0-9_.-]/i.test(payload.error) && payload.error.trim()) return payload.error.trim()
  const code = typeof payload.error === 'string' ? payload.error : typeof payload.code === 'string' ? payload.code : ''
  if (/login_required|unauthorized|token_/i.test(code)) return '登录已过期，请重新登录 AI历史书'
  if (/rate_limit/i.test(code)) return '操作有些频繁，请稍后再试'
  return fallback
}

function validateCommunityUpload(upload: LauncherCommunityUpload): void {
  if (!COMMUNITY_IMAGE_TYPES.has(upload.mimeType)) throw new Error('图片只支持 JPG、PNG、WebP 或 GIF')
  if (!(upload.bytes instanceof ArrayBuffer) || upload.bytes.byteLength < 1 || upload.bytes.byteLength > COMMUNITY_IMAGE_MAX_BYTES) throw new Error('图片大小需在 5 MB 以内')
  if (!upload.name.trim() || upload.name.length > 180) throw new Error('图片文件名无效')
}

function appendCommunityImage(form: FormData, upload: LauncherCommunityUpload): void {
  validateCommunityUpload(upload)
  form.set('image', new Blob([upload.bytes], { type: upload.mimeType }), upload.name.trim())
}

function assertCommunityRequest(value: unknown): asserts value is LauncherCommunityRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('社区请求无效')
  const request = value as Record<string, unknown>
  if (request.scope !== 'forum' && request.scope !== 'chat') throw new Error('社区请求范围无效')
  if (request.method !== 'GET' && request.method !== 'POST') throw new Error('社区请求方式无效')
  if (request.scope === 'chat') {
    if (request.method === 'GET' && request.channel !== 'deepseek' && request.channel !== 'plaza') throw new Error('聊天频道无效')
    if (request.method === 'POST' && !COMMUNITY_CHAT_POST_ACTIONS.has(String(request.action || ''))) throw new Error('聊天操作无效')
    return
  }
  const action = String(request.action || '')
  if (request.method === 'GET' && !COMMUNITY_FORUM_GET_ACTIONS.has(action)) throw new Error('社区读取操作无效')
  if (request.method === 'POST' && !COMMUNITY_FORUM_POST_ACTIONS.has(action)) throw new Error('社区写入操作无效')
}

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
        signal: AbortSignal.timeout(10_000),
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

  async communityRequest(request: LauncherCommunityRequest): Promise<Record<string, unknown>> {
    assertCommunityRequest(request)
    const endpoint = request.scope === 'forum' ? COMMUNITY_FORUM_URL : COMMUNITY_CHAT_URL
    const token = this.accessToken
    const ownerId = this.account.user?.id
    const epoch = this.authEpoch
    const headers = new Headers({ accept: 'application/json', 'x-requested-with': 'deepblue-harness-launcher' })
    if (token && ownerId && this.account.status === 'signed_in') headers.set('authorization', `Bearer ${token}`)

    let url = endpoint
    let init: RequestInit = { method: request.method, headers }
    if (request.method === 'GET') {
      const query = new URLSearchParams()
      if (request.scope === 'chat') query.set('channel', request.channel)
      else {
        query.set('action', request.action)
        if (request.action === 'thread') query.set('id', request.id)
        else {
          if (request.realm) query.set('realm', request.realm)
          if (request.circle) query.set('circle', request.circle)
          if (request.sort) query.set('sort', request.sort)
          if (request.query) query.set('q', request.query.slice(0, 80))
          if (request.page) query.set('page', String(Math.max(1, Math.min(1000, Math.trunc(request.page)))))
        }
      }
      url += `?${query.toString()}`
    } else {
      if (!token || this.account.status !== 'signed_in' || !ownerId) throw new Error('请先登录 AI历史书账号')
      const payload = { ...request } as Record<string, unknown>
      delete payload.scope
      delete payload.method
      const upload = 'image' in request ? request.image : undefined
      delete payload.image
      if (upload) {
        const form = new FormData()
        for (const [key, value] of Object.entries(payload)) {
          if (value == null) continue
          form.set(key, Array.isArray(value) ? JSON.stringify(value) : String(value))
        }
        appendCommunityImage(form, upload)
        init = { method: 'POST', headers, body: form }
      } else {
        headers.set('content-type', 'application/json')
        init = { method: 'POST', headers, body: JSON.stringify(payload) }
      }
    }

    let response: Response
    try {
      response = await session.defaultSession.fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
    } catch {
      throw new Error('社区连接超时，请检查网络后重试')
    }
    const result = await response.json().catch(() => ({})) as Record<string, unknown>
    if (token && (epoch !== this.authEpoch || token !== this.accessToken || ownerId !== this.account.user?.id)) throw new Error('账号已切换，请重试')
    if (response.status === 401) {
      this.accessToken = ''
      this.authEpoch += 1
      this.account = { status: 'signed_out', sessionRemembered: false }
      throw new Error('登录已过期，请重新登录 AI历史书')
    }
    if (!response.ok || result.ok !== true) throw new Error(communityError(result, request.method === 'GET' ? '社区服务暂时不可用，请稍后重试' : '操作没有完成，请稍后再试'))
    return result
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
