import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import {
  ArrowLeft,
  Bookmark,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Heart,
  Image as ImageIcon,
  LoaderCircle,
  LogIn,
  MessageCircle,
  MessagesSquare,
  Plus,
  RefreshCw,
  Search,
  Send,
  SmilePlus,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import type { LauncherCommunityRequest, LauncherCommunityUpload, LauncherSnapshot } from '../../shared/types'

type CommunityMode = 'deepseek' | 'plaza' | 'posts'
type CommunityRealm = 'tool' | 'interest' | 'agent' | 'game'

interface CommunityAuthor {
  key: string
  name: string
  avatar?: string
  isSeed: boolean
  isStaff: boolean
}

interface CommunityChatMessage {
  id: string
  body: string
  stickerId?: string
  imageUrl?: string
  createdAt: string
  mine: boolean
  isSeedData: boolean
  author: CommunityAuthor
}

interface CommunitySticker {
  id: string
  label: string
  imageUrl: string
  stickerId?: string
}

interface CommunitySpace {
  id: string
  slug: string
  name: string
  short: string
  summary: string
  realm: string
  color: string
  memberCount: number
  threadCount: number
}

interface CommunityThread {
  id: string
  title: string
  summary: string
  body: string
  type: string
  tags: string[]
  replyCount: number
  reactionCount: number
  bookmarkCount: number
  viewCount: number
  createdAt: string
  rootPostId?: string
  isSeedData: boolean
  author: CommunityAuthor
  space: CommunitySpace
  viewer: { bookmarked: boolean; reaction: boolean; isAuthor: boolean }
  comments?: CommunityComment[]
}

interface CommunityComment {
  id: string
  parentPostId?: string
  body: string
  imageUrl?: string
  stickerId?: string
  reactionCount: number
  createdAt: string
  author: CommunityAuthor
  viewerReaction: boolean
  viewerIsAuthor: boolean
}

interface ComposerDraft {
  title: string
  body: string
  tags: string
  circle: string
  type: string
}

const COMMUNITY_ASSET_ROOT = 'https://ailishishu.com/community/assets/memes'
const COMMUNITY_SITE_ROOT = 'https://ailishishu.com'
const COMMUNITY_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const COMMUNITY_IMAGE_MAX_BYTES = 5 * 1024 * 1024
const CHAT_TEXT_MAX = 300
const PUBLIC_STICKER_ROWS: Array<[string, string]> = [
  ['deepseek-cheerful', '鲸鱼娘·开心'], ['deepseek-serious', '鲸鱼娘·认真'], ['deepseek-confused', '鲸鱼娘·困惑'],
  ['deepseek-angry', '鲸鱼娘·生气'], ['deepseek-exasperated', '鲸鱼娘·无语'], ['deepseek-starry', '鲸鱼娘·星星眼'],
  ['bqb-03', '一行代码三个报错'], ['bqb-06', '这个网站不费 token'], ['bqb-08', '复杂的事简单做'], ['bqb-10', '鼓掌']
]
const PUBLIC_STICKERS: CommunitySticker[] = PUBLIC_STICKER_ROWS.map(([id, label]) => ({ id, label, stickerId: id, imageUrl: `${COMMUNITY_ASSET_ROOT}/${id}.webp` }))

const realmOptions: Array<{ id: CommunityRealm; label: string; note: string }> = [
  { id: 'tool', label: 'DeepSeek 独家', note: '模型实测与排错' },
  { id: 'interest', label: '兴趣创作', note: '图像、视频与写作' },
  { id: 'agent', label: '智能体', note: 'Skill、MCP 与协作' },
  { id: 'game', label: 'AI 游戏', note: '试玩、创作与反馈' }
]

const typeLabels: Record<string, string> = {
  discussion: '经验讨论', question: '提问求助', showcase: '作品复盘', tool_experience: '工具体验', idea: '想法提案', guide: '方法指南', playtest: '试玩反馈'
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback
}

function number(value: unknown): number {
  const result = Number(value)
  return Number.isFinite(result) && result >= 0 ? result : 0
}

function boolean(value: unknown): boolean {
  return value === true || value === 1
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function mediaUrl(value: unknown): string | undefined {
  const candidate = text(value).trim()
  if (!candidate) return undefined
  if (candidate.startsWith('/')) return `${COMMUNITY_SITE_ROOT}${candidate}`
  try {
    const parsed = new URL(candidate)
    return parsed.protocol === 'https:' ? parsed.toString() : undefined
  } catch {
    return undefined
  }
}

function parseAuthor(value: unknown): CommunityAuthor {
  const row = object(value)
  return {
    key: text(row.key),
    name: text(row.name, 'AI历史书用户'),
    avatar: mediaUrl(row.avatar),
    isSeed: boolean(row.isSeed),
    isStaff: boolean(row.isStaff)
  }
}

function parseSpace(value: unknown): CommunitySpace {
  const row = object(value)
  return {
    id: text(row.id), slug: text(row.slug), name: text(row.name, '社区圈子'), short: text(row.short, 'AI'), summary: text(row.summary),
    realm: text(row.realm, 'interest'), color: /^#[0-9a-f]{3,8}$/i.test(text(row.color)) ? text(row.color) : '#4d6bfe',
    memberCount: number(row.memberCount), threadCount: number(row.threadCount)
  }
}

function parseComment(value: unknown): CommunityComment | undefined {
  const row = object(value)
  const id = text(row.id)
  if (!id) return undefined
  return {
    id, parentPostId: text(row.parentPostId) || undefined, body: text(row.body), imageUrl: mediaUrl(row.imageUrl),
    stickerId: text(row.stickerId) || undefined, reactionCount: number(row.reactionCount), createdAt: text(row.createdAt), author: parseAuthor(row.author),
    viewerReaction: Boolean(row.viewerReaction), viewerIsAuthor: boolean(row.viewerIsAuthor)
  }
}

function parseThread(value: unknown): CommunityThread | undefined {
  const row = object(value)
  const id = text(row.id)
  const title = text(row.title)
  if (!id || !title) return undefined
  const viewer = object(row.viewer)
  return {
    id, title, summary: text(row.summary), body: text(row.body), type: text(row.type, 'discussion'), tags: list(row.tags).map((tag) => text(tag)).filter(Boolean).slice(0, 5),
    replyCount: number(row.replyCount), reactionCount: number(row.reactionCount), bookmarkCount: number(row.bookmarkCount), viewCount: number(row.viewCount), createdAt: text(row.createdAt),
    rootPostId: text(row.rootPostId) || undefined, isSeedData: boolean(row.isSeedData), author: parseAuthor(row.author), space: parseSpace(row.space),
    viewer: { bookmarked: boolean(viewer.bookmarked), reaction: Boolean(viewer.reaction), isAuthor: boolean(viewer.isAuthor) },
    comments: list(row.comments).map(parseComment).filter((item): item is CommunityComment => Boolean(item))
  }
}

function parseChatMessage(value: unknown): CommunityChatMessage | undefined {
  const row = object(value)
  const id = text(row.id)
  if (!id) return undefined
  const viewer = object(row.viewer)
  return {
    id, body: text(row.body), stickerId: text(row.stickerId) || undefined, imageUrl: mediaUrl(row.imageUrl),
    createdAt: text(row.createdAt), mine: boolean(viewer.isAuthor), isSeedData: boolean(row.isSeedData), author: parseAuthor(row.author)
  }
}

function parseSticker(value: unknown): CommunitySticker | undefined {
  const row = object(value)
  const id = text(row.id)
  const imageUrl = mediaUrl(row.imageUrl)
  const catalogId = text(row.stickerId)
  if (!id || (!imageUrl && !catalogId)) return undefined
  return { id, label: text(row.label, '我的表情'), stickerId: catalogId || undefined, imageUrl: imageUrl || `${COMMUNITY_ASSET_ROOT}/${catalogId}.webp` }
}

function relativeTime(value: string): string {
  if (!value) return ''
  const normalized = value.includes('T') ? value : value.replace(' ', 'T') + '+08:00'
  const timestamp = new Date(normalized).getTime()
  const diff = Date.now() - timestamp
  if (!Number.isFinite(diff) || diff < 0) return value.slice(0, 16)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(timestamp).toLocaleDateString('zh-CN')
}

function requestId(prefix: string): string {
  return `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
}

async function uploadFromFile(file: File): Promise<LauncherCommunityUpload> {
  if (!COMMUNITY_IMAGE_TYPES.has(file.type)) throw new Error('图片只支持 JPG、PNG、WebP 或 GIF')
  if (file.size < 1 || file.size > COMMUNITY_IMAGE_MAX_BYTES) throw new Error('图片大小需在 5 MB 以内')
  return { name: file.name.slice(0, 180), mimeType: file.type as LauncherCommunityUpload['mimeType'], bytes: await file.arrayBuffer() }
}

function demoRequest(request: LauncherCommunityRequest): Record<string, unknown> {
  const author = { key: 'demo-user', name: '深蓝用户', isSeed: false, isStaff: false }
  if (request.scope === 'chat' && request.method === 'GET') return {
    ok: true, authenticated: true, savedStickers: [], messages: [
      { id: 'demo-chat-1', body: '刚把 DeepSeek 的视觉模型接进工作流，识图和工具调用可以放在同一条任务里。', createdAt: new Date(Date.now() - 420_000).toISOString(), author: { key: 'seed-1', name: '鲸鱼研究员', isSeed: true }, viewer: { isAuthor: false }, isSeedData: true },
      { id: 'demo-chat-2', body: '我更关心失败后怎么回放，有人做过完整日志对照吗？', createdAt: new Date(Date.now() - 180_000).toISOString(), author, viewer: { isAuthor: true } },
      { id: 'demo-chat-3', body: request.channel === 'deepseek' ? '可以，把复现步骤发成帖子，聊天里继续补充实时结果。' : 'AI聊天广场已连通，值得沉淀的内容可以转成帖子。', createdAt: new Date(Date.now() - 70_000).toISOString(), author: { key: 'seed-2', name: '开源搭子', isSeed: true }, viewer: { isAuthor: false }, isSeedData: true, stickerId: 'deepseek-cheerful' }
    ]
  }
  const space = { id: 'space-deepseek', slug: 'deepseek', name: 'DeepSeek 讨论', short: 'DS', summary: '模型、接口、排错与真实项目', realm: 'tool', color: '#4d6bfe', memberCount: 126, threadCount: 48 }
  const thread = { id: 'demo-thread-1', title: 'DeepSeek 视觉模型接入 Harness 后，工具调用链怎么验证？', summary: '整理一次从图片输入、工具调用到 Session Log 回放的实测过程。', body: '这次测试不只看“能否识图”，还对照了请求、工具调用和会话日志。\n\n欢迎补充不同系统和模型版本下的结果。', type: 'tool_experience', tags: ['DeepSeek', '多模态', 'Harness'], replyCount: 3, reactionCount: 18, bookmarkCount: 7, viewCount: 126, createdAt: new Date(Date.now() - 3_600_000).toISOString(), rootPostId: 'demo-root-1', isSeedData: true, author: { key: 'seed-1', name: '鲸鱼研究员', isSeed: true }, space, viewer: { bookmarked: false, reaction: false, isAuthor: false }, comments: [{ id: 'demo-comment-1', body: '我在 Windows 11 上复现成功，图片压缩后延迟更稳定。', reactionCount: 4, createdAt: new Date(Date.now() - 1_200_000).toISOString(), author, viewerReaction: false, viewerIsAuthor: true }] }
  if (request.scope === 'forum' && request.method === 'GET' && request.action === 'thread') return { ok: true, thread }
  if (request.scope === 'forum' && request.method === 'GET') return { ok: true, authenticated: true, spaces: [space, { ...space, id: 'space-art', slug: 'ai-art', name: 'AI 视觉创作', short: '图', realm: 'interest' }], threads: [thread, { ...thread, id: 'demo-thread-2', title: '你会把聊天里的即时结论整理成长期知识吗？', summary: '讨论聊天、帖子和 Skill 之间如何形成可复用链路。', replyCount: 8, reactionCount: 26, createdAt: new Date(Date.now() - 7_200_000).toISOString() }] }
  return { ok: true, threadId: 'demo-thread-1', postId: 'demo-comment-2', messageId: `demo-${Date.now()}`, bookmarked: true, reacted: true }
}

function avatar(author: CommunityAuthor): ReactNode {
  return author.avatar ? <img src={author.avatar} alt="" /> : <span>{author.name.slice(0, 1).toUpperCase()}</span>
}

function messageSignature(items: CommunityChatMessage[]): string {
  return items.map((item) => `${item.id}\u001f${item.body}\u001f${item.imageUrl || item.stickerId || ''}`).join('\u001e')
}

export function CommunityPage({ snapshot, onLogin }: { snapshot: LauncherSnapshot; onLogin: () => void }): ReactNode {
  const [mode, setMode] = useState<CommunityMode>('deepseek')
  const [chatMessages, setChatMessages] = useState<CommunityChatMessage[]>([])
  const [savedStickers, setSavedStickers] = useState<CommunitySticker[]>([])
  const [chatDraft, setChatDraft] = useState('')
  const [chatImage, setChatImage] = useState<File>()
  const [selectedSticker, setSelectedSticker] = useState<CommunitySticker>()
  const [stickerOpen, setStickerOpen] = useState(false)
  const [chatBusy, setChatBusy] = useState(false)
  const [chatError, setChatError] = useState('')
  const [newMessageCount, setNewMessageCount] = useState(0)
  const [previewUrl, setPreviewUrl] = useState('')
  const [realm, setRealm] = useState<CommunityRealm>('tool')
  const [circle, setCircle] = useState('deepseek')
  const [spaces, setSpaces] = useState<CommunitySpace[]>([])
  const [threads, setThreads] = useState<CommunityThread[]>([])
  const [postSearch, setPostSearch] = useState('')
  const [postBusy, setPostBusy] = useState(false)
  const [postError, setPostError] = useState('')
  const [selectedThread, setSelectedThread] = useState<CommunityThread>()
  const [threadBusy, setThreadBusy] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [composerBusy, setComposerBusy] = useState(false)
  const [composerDraft, setComposerDraft] = useState<ComposerDraft>({ title: '', body: '', tags: '', circle: 'deepseek', type: 'discussion' })
  const [replyDraft, setReplyDraft] = useState('')
  const [replyImage, setReplyImage] = useState<File>()
  const [replySticker, setReplySticker] = useState<CommunitySticker>()
  const [replyBusy, setReplyBusy] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const chatSignatureRef = useRef('')
  const chatMessagesRef = useRef<CommunityChatMessage[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const replyFileRef = useRef<HTMLInputElement>(null)
  const authenticated = snapshot.account.status === 'signed_in'

  const request = async (payload: LauncherCommunityRequest): Promise<Record<string, unknown>> => {
    if (!window.launcher?.communityRequest) return demoRequest(payload)
    return window.launcher.communityRequest(payload)
  }

  const channel: 'deepseek' | 'plaza' = mode === 'plaza' ? 'plaza' : 'deepseek'

  const loadChat = async (silent = false): Promise<void> => {
    const listNode = chatScrollRef.current
    const atBottom = !listNode || listNode.scrollHeight - listNode.scrollTop - listNode.clientHeight < 64
    if (!silent) setChatBusy(true)
    try {
      const payload = await request({ scope: 'chat', method: 'GET', channel })
      const next = list(payload.messages).map(parseChatMessage).filter((item): item is CommunityChatMessage => Boolean(item)).slice(-100)
      const nextSignature = messageSignature(next)
      const incoming = next.filter((item) => !chatMessagesRef.current.some((current) => current.id === item.id)).length
      if (nextSignature !== chatSignatureRef.current) {
        chatSignatureRef.current = nextSignature
        chatMessagesRef.current = next
        setChatMessages(next)
        if (!atBottom && incoming) setNewMessageCount((current) => current + incoming)
        window.setTimeout(() => {
          const node = chatScrollRef.current
          if (node && (atBottom || !silent)) {
            node.scrollTop = node.scrollHeight
            setNewMessageCount(0)
          }
        }, 0)
      }
      setSavedStickers(list(payload.savedStickers).map(parseSticker).filter((item): item is CommunitySticker => Boolean(item)))
      setChatError('')
    } catch (error) {
      if (!silent) setChatError(error instanceof Error ? error.message : '聊天广场暂时不可用')
    } finally {
      if (!silent) setChatBusy(false)
    }
  }

  const loadPosts = async (nextRealm = realm, nextCircle = circle): Promise<void> => {
    setPostBusy(true)
    try {
      const payload = await request({ scope: 'forum', method: 'GET', action: 'bootstrap', realm: nextRealm, circle: nextCircle, sort: nextCircle ? 'latest' : 'recommended', query: postSearch })
      const nextSpaces = list(payload.spaces).map(parseSpace).filter((item) => item.id)
      const validSpaces = nextSpaces.filter((item) => item.realm === nextRealm)
      const resolvedCircle = validSpaces.some((item) => item.slug === nextCircle) ? nextCircle : validSpaces[0]?.slug || ''
      setSpaces(nextSpaces)
      if (resolvedCircle !== circle) setCircle(resolvedCircle)
      setThreads(list(payload.threads).map(parseThread).filter((item): item is CommunityThread => Boolean(item)))
      setPostError('')
    } catch (error) {
      setPostError(error instanceof Error ? error.message : '帖子目录暂时不可用')
    } finally {
      setPostBusy(false)
    }
  }

  useEffect(() => {
    if (mode === 'posts') void loadPosts()
    else void loadChat()
  }, [mode, realm, circle, snapshot.account.status])

  useEffect(() => {
    if (mode === 'posts') return
    const timer = window.setInterval(() => { if (!document.hidden) void loadChat(true) }, 12_000)
    return () => window.clearInterval(timer)
  }, [mode, channel])

  const changeMode = (next: CommunityMode): void => {
    setMode(next)
    setChatError('')
    setPostError('')
    setNewMessageCount(0)
  }

  const chooseImage = (event: ChangeEvent<HTMLInputElement>, target: 'chat' | 'reply'): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!COMMUNITY_IMAGE_TYPES.has(file.type)) { setChatError('图片只支持 JPG、PNG、WebP 或 GIF'); return }
    if (file.size < 1 || file.size > COMMUNITY_IMAGE_MAX_BYTES) { setChatError('图片大小需在 5 MB 以内'); return }
    if (target === 'chat') { setChatImage(file); setSelectedSticker(undefined); setStickerOpen(false) }
    else { setReplyImage(file); setReplySticker(undefined) }
  }

  const sendChat = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    if (!authenticated) { onLogin(); return }
    const normalized = chatDraft.trim()
    if (!normalized && !chatImage && !selectedSticker) { setChatError('写一句话，或选择一张图片、表情'); return }
    if (Array.from(normalized).length > CHAT_TEXT_MAX) { setChatError(`实时聊天最多发送 ${CHAT_TEXT_MAX} 字`); return }
    setChatBusy(true)
    try {
      const base = { scope: 'chat' as const, method: 'POST' as const, action: 'send_chat' as const, channel, body: normalized }
      const payload: LauncherCommunityRequest = chatImage
        ? { ...base, image: await uploadFromFile(chatImage) }
        : selectedSticker?.stickerId ? { ...base, stickerId: selectedSticker.stickerId } : selectedSticker ? { ...base, savedStickerId: selectedSticker.id } : base
      await request(payload)
      setChatDraft('')
      setChatImage(undefined)
      setSelectedSticker(undefined)
      setStickerOpen(false)
      await loadChat()
    } catch (error) {
      setChatError(error instanceof Error ? error.message : '消息发送失败')
    } finally {
      setChatBusy(false)
    }
  }

  const chatKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void sendChat()
    }
  }

  const saveSticker = async (sourceType: 'chat' | 'post', sourceKey: string): Promise<void> => {
    if (!authenticated) { onLogin(); return }
    try {
      await request({ scope: 'chat', method: 'POST', action: 'save_sticker', sourceType, sourceKey })
      await loadChat(true)
    } catch (error) {
      setChatError(error instanceof Error ? error.message : '表情收藏失败')
    }
  }

  const deleteSticker = async (stickerId: string): Promise<void> => {
    try {
      await request({ scope: 'chat', method: 'POST', action: 'delete_sticker', stickerId })
      setSavedStickers((current) => current.filter((item) => item.id !== stickerId))
      if (selectedSticker?.id === stickerId) setSelectedSticker(undefined)
    } catch (error) {
      setChatError(error instanceof Error ? error.message : '表情删除失败')
    }
  }

  const openThread = async (threadId: string): Promise<void> => {
    setThreadBusy(true)
    setSelectedThread(threads.find((item) => item.id === threadId))
    try {
      const payload = await request({ scope: 'forum', method: 'GET', action: 'thread', id: threadId })
      const detail = parseThread(payload.thread)
      if (detail) setSelectedThread(detail)
    } catch (error) {
      setPostError(error instanceof Error ? error.message : '讨论暂时无法打开')
    } finally {
      setThreadBusy(false)
    }
  }

  const openComposer = (): void => {
    if (!authenticated) { onLogin(); return }
    const currentCircle = circle || spaces.find((item) => item.realm === realm)?.slug || 'deepseek'
    setComposerDraft({ title: '', body: '', tags: '', circle: currentCircle, type: realm === 'tool' ? 'tool_experience' : realm === 'game' ? 'playtest' : 'discussion' })
    setComposerOpen(true)
  }

  const createThread = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (composerDraft.title.trim().length < 4 || composerDraft.body.trim().length < 10) { setPostError('标题至少 4 个字，正文至少 10 个字'); return }
    setComposerBusy(true)
    try {
      const payload = await request({
        scope: 'forum', method: 'POST', action: 'create_thread', clientRequestId: requestId('thread'), circle: composerDraft.circle,
        threadType: composerDraft.type, title: composerDraft.title.trim(), body: composerDraft.body.trim(),
        tags: composerDraft.tags.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 5)
      })
      setComposerOpen(false)
      await loadPosts()
      const threadId = text(payload.threadId)
      if (threadId) await openThread(threadId)
    } catch (error) {
      setPostError(error instanceof Error ? error.message : '讨论发布失败')
    } finally {
      setComposerBusy(false)
    }
  }

  const submitReply = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!authenticated) { onLogin(); return }
    if (!selectedThread) return
    const normalized = replyDraft.trim()
    if (!normalized && !replyImage && !replySticker) { setPostError('回复文字、图片或表情至少需要一项'); return }
    setReplyBusy(true)
    try {
      const base = { scope: 'forum' as const, method: 'POST' as const, action: 'create_reply' as const, clientRequestId: requestId('reply'), threadId: selectedThread.id, body: normalized }
      const payload: LauncherCommunityRequest = replyImage
        ? { ...base, image: await uploadFromFile(replyImage) }
        : replySticker?.stickerId ? { ...base, stickerId: replySticker.stickerId } : replySticker ? { ...base, savedStickerId: replySticker.id } : base
      await request(payload)
      setReplyDraft('')
      setReplyImage(undefined)
      setReplySticker(undefined)
      await openThread(selectedThread.id)
      await loadPosts()
    } catch (error) {
      setPostError(error instanceof Error ? error.message : '回复发布失败')
    } finally {
      setReplyBusy(false)
    }
  }

  const toggleThreadAction = async (kind: 'bookmark' | 'reaction'): Promise<void> => {
    if (!authenticated) { onLogin(); return }
    if (!selectedThread) return
    try {
      if (kind === 'bookmark') await request({ scope: 'forum', method: 'POST', action: 'toggle_bookmark', threadId: selectedThread.id })
      else if (selectedThread.rootPostId) await request({ scope: 'forum', method: 'POST', action: 'toggle_reaction', postId: selectedThread.rootPostId, reactionType: 'helpful' })
      await openThread(selectedThread.id)
    } catch (error) {
      setPostError(error instanceof Error ? error.message : '互动没有完成')
    }
  }

  const filteredSpaces = useMemo(() => spaces.filter((item) => item.realm === realm), [spaces, realm])
  const chatImageUrl = useMemo(() => chatImage ? URL.createObjectURL(chatImage) : '', [chatImage])
  const replyImageUrl = useMemo(() => replyImage ? URL.createObjectURL(replyImage) : '', [replyImage])
  useEffect(() => () => { if (chatImageUrl) URL.revokeObjectURL(chatImageUrl) }, [chatImageUrl])
  useEffect(() => () => { if (replyImageUrl) URL.revokeObjectURL(replyImageUrl) }, [replyImageUrl])

  return <div className="community-page">
    <header className="community-switcher">
      <div className="community-tabs" role="tablist" aria-label="兴趣社区频道">
        <button role="tab" aria-selected={mode === 'deepseek'} onClick={() => changeMode('deepseek')}><MessageCircle />DeepSeek 房间</button>
        <button role="tab" aria-selected={mode === 'plaza'} onClick={() => changeMode('plaza')}><MessagesSquare />AI 聊天广场</button>
        <button role="tab" aria-selected={mode === 'posts'} onClick={() => changeMode('posts')}><Sparkles />兴趣帖子</button>
      </div>
      <div className="community-account-state">
        {authenticated ? <><CheckCircle2 /><span>{snapshot.account.user?.name} · 已同步网站账号</span></> : <button onClick={onLogin}><LogIn />登录后发言</button>}
      </div>
    </header>

    {mode !== 'posts' ? <section className="community-chat-layout">
      <div className="community-chat-main">
        <div className="community-room-heading">
          <div><strong>{mode === 'deepseek' ? 'DeepSeek 房间' : 'AI 聊天广场'}</strong><span>{mode === 'deepseek' ? '围绕模型、Harness、接口与排错即时交流' : '不同模型用户一起聊天、发图与斗图'}</span></div>
          <button className="quiet-button" disabled={chatBusy} onClick={() => void loadChat()}><RefreshCw className={chatBusy ? 'spin' : ''} />刷新</button>
        </div>
        <div className="community-message-list" ref={chatScrollRef} aria-live="polite">
          {chatBusy && !chatMessages.length && <div className="community-loading"><LoaderCircle className="spin" />正在连接同一聊天室…</div>}
          {!chatBusy && !chatMessages.length && <div className="community-empty"><MessageCircle /><strong>这里还很安静</strong><span>发第一条短消息，值得沉淀的方法再整理成帖子。</span></div>}
          {chatMessages.map((message) => {
            const mediaUrl = message.imageUrl || (message.stickerId ? `${COMMUNITY_ASSET_ROOT}/${message.stickerId}.webp` : '')
            return <article className="community-message" data-mine={message.mine} key={message.id}>
              <div className="community-avatar">{avatar(message.author)}</div>
              <div className="community-message-content">
                <div className="community-message-meta"><strong>{message.author.name}</strong>{message.isSeedData && <span>共建样例</span>}{message.author.isStaff && <span>管理员</span>}<time>{relativeTime(message.createdAt)}</time></div>
                <div className="community-message-bubble">{message.body && <p>{message.body}</p>}{mediaUrl && <button className="community-message-media" onClick={() => setPreviewUrl(mediaUrl)}><img src={mediaUrl} alt={`${message.author.name}发送的图片`} /></button>}</div>
                {mediaUrl && !message.mine && <button className="community-save-sticker" onClick={() => void saveSticker('chat', message.id)}>添加到我的表情</button>}
              </div>
            </article>
          })}
          {newMessageCount > 0 && <button className="community-new-message" onClick={() => { const node = chatScrollRef.current; if (node) node.scrollTop = node.scrollHeight; setNewMessageCount(0) }}>{newMessageCount} 条新消息 · 回到最新</button>}
        </div>
        <form className="community-chat-composer" onSubmit={(event) => void sendChat(event)}>
          {stickerOpen && <div className="community-sticker-tray">
            {savedStickers.length > 0 && <section><strong>我的表情</strong><div>{savedStickers.map((sticker) => <span key={sticker.id}><button type="button" aria-pressed={selectedSticker?.id === sticker.id} onClick={() => { setSelectedSticker(sticker); setChatImage(undefined) }}><img src={sticker.imageUrl} alt={sticker.label} /></button><button type="button" className="community-sticker-delete" aria-label={`删除${sticker.label}`} onClick={() => void deleteSticker(sticker.id)}><Trash2 /></button></span>)}</div></section>}
            <section><strong>公共表情</strong><div>{PUBLIC_STICKERS.map((sticker) => <button type="button" key={sticker.id} aria-pressed={selectedSticker?.id === sticker.id} onClick={() => { setSelectedSticker(sticker); setChatImage(undefined) }}><img src={sticker.imageUrl} alt={sticker.label} /></button>)}</div></section>
          </div>}
          {(chatImage || selectedSticker) && <div className="community-selected-media">{chatImage ? <img src={chatImageUrl} alt="待发送图片" /> : <img src={selectedSticker?.imageUrl} alt={selectedSticker?.label} />}<span>{chatImage ? `${chatImage.name} · ${Math.max(1, Math.round(chatImage.size / 1024))} KB` : `已选择：${selectedSticker?.label}`}</span><button type="button" onClick={() => { setChatImage(undefined); setSelectedSticker(undefined) }}><X /></button></div>}
          <div className="community-composer-row">
            <button type="button" aria-label="发送图片" onClick={() => authenticated ? fileInputRef.current?.click() : onLogin()}><ImageIcon /></button>
            <button type="button" aria-label="选择表情" aria-expanded={stickerOpen} onClick={() => authenticated ? setStickerOpen((current) => !current) : onLogin()}><SmilePlus /></button>
            <textarea value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} onKeyDown={chatKeyDown} maxLength={CHAT_TEXT_MAX} readOnly={!authenticated} onClick={() => { if (!authenticated) onLogin() }} placeholder={authenticated ? '说点短的；Enter 发送，Shift + Enter 换行' : '登录 AI历史书账号后直接聊天'} />
            <button type="submit" className="community-send-button" disabled={chatBusy}>{chatBusy ? <LoaderCircle className="spin" /> : <Send />}<span>{authenticated ? '发送' : '登录'}</span></button>
            <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={(event) => chooseImage(event, 'chat')} />
          </div>
          <div className="community-composer-foot"><span>文字统一检查违禁词，新图先经 DeepSeek 视觉审核</span><b>{Array.from(chatDraft).length}/{CHAT_TEXT_MAX}</b></div>
          {chatError && <p className="community-inline-error"><CircleAlert />{chatError}</p>}
        </form>
      </div>
      <aside className="community-room-aside">
        <strong>这个房间怎么用</strong>
        <p>聊天适合即时交流；可复用的方法、排错过程和作品复盘，请转到帖子长期沉淀。</p>
        <dl><div><dt>消息保留</dt><dd>最新 100 条</dd></div><div><dt>账号</dt><dd>与网站双向同步</dd></div><div><dt>发图</dt><dd>最大 5 MB</dd></div></dl>
        <div className="community-aside-stickers"><strong>我的表情</strong>{savedStickers.length ? <div>{savedStickers.slice(0, 8).map((sticker) => <button key={sticker.id} onClick={() => { setSelectedSticker(sticker); setStickerOpen(true) }}><img src={sticker.imageUrl} alt={sticker.label} /></button>)}</div> : <span>{authenticated ? '在聊天图片上点击“添加到我的表情”' : '登录后同步网站收藏的表情'}</span>}</div>
      </aside>
    </section> : <section className="community-post-layout">
      <aside className="community-realm-rail">
        <strong>讨论分区</strong>
        {realmOptions.map((item) => <button key={item.id} aria-pressed={realm === item.id} onClick={() => { setRealm(item.id); setCircle(item.id === 'tool' ? 'deepseek' : '') }}><span>{item.label}</span><small>{item.note}</small><ChevronRight /></button>)}
        <button className="community-compose-button" onClick={openComposer}><Plus />发布讨论</button>
      </aside>
      <div className="community-thread-feed">
        <header className="community-feed-toolbar">
          <div className="community-circle-tabs">{filteredSpaces.map((space) => <button key={space.id} aria-pressed={circle === space.slug} onClick={() => setCircle(space.slug)}>{space.name}</button>)}</div>
          <form onSubmit={(event) => { event.preventDefault(); void loadPosts() }}><Search /><input value={postSearch} onChange={(event) => setPostSearch(event.target.value)} maxLength={80} placeholder="搜讨论" /><button type="submit">搜索</button></form>
          <button className="quiet-button" onClick={() => void loadPosts()} disabled={postBusy}><RefreshCw className={postBusy ? 'spin' : ''} />刷新</button>
        </header>
        {postError && <p className="community-inline-error"><CircleAlert />{postError}</p>}
        {postBusy && !threads.length && <div className="community-loading"><LoaderCircle className="spin" />正在同步网站帖子…</div>}
        {!postBusy && !threads.length && <div className="community-empty"><Sparkles /><strong>这个圈子正等第一篇讨论</strong><span>把真实任务、尝试过程和问题写下来。</span><button onClick={openComposer}>发布讨论</button></div>}
        <div className="community-thread-list">{threads.map((thread) => <article key={thread.id} tabIndex={0} onClick={() => void openThread(thread.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void openThread(thread.id) } }}>
          <div className="community-thread-author"><div className="community-avatar">{avatar(thread.author)}</div><span><strong>{thread.author.name}</strong><small>{relativeTime(thread.createdAt)} · {thread.space.name}</small></span>{thread.isSeedData && <em>共建样例</em>}</div>
          <h2>{thread.title}</h2><p>{thread.summary || thread.body}</p>
          <footer><div>{thread.tags.map((tag) => <span key={tag}># {tag}</span>)}</div><b><MessageCircle />{thread.replyCount}<Heart />{thread.reactionCount}<Bookmark />{thread.bookmarkCount}</b></footer>
        </article>)}</div>
      </div>
      <aside className="community-post-aside">
        <strong>启动器与网站同一社区</strong>
        <p>帖子、回复、收藏和账号身份实时同步。你在这里发布的内容，网页端也会直接显示。</p>
        <div><span>当前分区</span><b>{realmOptions.find((item) => item.id === realm)?.label}</b></div>
        <div><span>当前圈子</span><b>{filteredSpaces.find((item) => item.slug === circle)?.name || '全部讨论'}</b></div>
        <div><span>内容审核</span><b>文字 + 图片统一检测</b></div>
      </aside>
    </section>}

    {selectedThread && <div className="community-sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedThread(undefined) }}>
      <section className="community-thread-sheet" role="dialog" aria-modal="true" aria-labelledby="community-thread-title">
        <header><button className="icon-button" aria-label="返回帖子列表" onClick={() => setSelectedThread(undefined)}><ArrowLeft /></button><div><span>{selectedThread.space.name} · {typeLabels[selectedThread.type] || '讨论'}</span><h2 id="community-thread-title">{selectedThread.title}</h2></div><button className="icon-button" aria-label="关闭讨论" onClick={() => setSelectedThread(undefined)}><X /></button></header>
        <div className="community-thread-reader">
          {threadBusy && <div className="community-loading"><LoaderCircle className="spin" />正在读取同一篇帖子…</div>}
          <div className="community-reader-author"><div className="community-avatar">{avatar(selectedThread.author)}</div><span><strong>{selectedThread.author.name}</strong><small>{relativeTime(selectedThread.createdAt)} · {selectedThread.viewCount} 次浏览</small></span></div>
          <article className="community-reader-body"><p>{selectedThread.body || selectedThread.summary}</p></article>
          <div className="community-reader-actions"><button aria-pressed={selectedThread.viewer.reaction} onClick={() => void toggleThreadAction('reaction')}><Heart fill={selectedThread.viewer.reaction ? 'currentColor' : 'none'} />{selectedThread.viewer.reaction ? '已有帮助' : '有帮助'} {selectedThread.reactionCount}</button><button aria-pressed={selectedThread.viewer.bookmarked} onClick={() => void toggleThreadAction('bookmark')}><Bookmark fill={selectedThread.viewer.bookmarked ? 'currentColor' : 'none'} />{selectedThread.viewer.bookmarked ? '已收藏' : '收藏'} {selectedThread.bookmarkCount}</button></div>
          <section className="community-replies"><h3>全部回复 <span>{selectedThread.replyCount}</span></h3>{selectedThread.comments?.length ? selectedThread.comments.map((comment) => {
            const mediaUrl = comment.imageUrl || (comment.stickerId ? `${COMMUNITY_ASSET_ROOT}/${comment.stickerId}.webp` : '')
            return <article key={comment.id}><div className="community-avatar">{avatar(comment.author)}</div><div><header><strong>{comment.author.name}</strong><time>{relativeTime(comment.createdAt)}</time></header>{comment.body && <p>{comment.body}</p>}{mediaUrl && <button className="community-comment-media" onClick={() => setPreviewUrl(mediaUrl)}><img src={mediaUrl} alt={`${comment.author.name}回复中的图片`} /></button>}{mediaUrl && !comment.viewerIsAuthor && <button className="community-save-sticker" onClick={() => void saveSticker('post', comment.id)}>添加到我的表情</button>}</div></article>
          }) : <div className="community-empty compact"><MessageCircle /><strong>还没有回复</strong><span>可以补充一个具体方法或继续追问。</span></div>}</section>
        </div>
        <form className="community-reply-composer" onSubmit={(event) => void submitReply(event)}>
          {(replyImage || replySticker) && <div className="community-selected-media">{replyImage ? <img src={replyImageUrl} alt="待发布图片" /> : <img src={replySticker?.imageUrl} alt={replySticker?.label} />}<span>{replyImage ? replyImage.name : replySticker?.label}</span><button type="button" onClick={() => { setReplyImage(undefined); setReplySticker(undefined) }}><X /></button></div>}
          <div><button type="button" onClick={() => authenticated ? replyFileRef.current?.click() : onLogin()}><ImageIcon />发图</button><button type="button" onClick={() => authenticated ? setReplySticker(PUBLIC_STICKERS[Math.floor(Math.random() * PUBLIC_STICKERS.length)]) : onLogin()}><SmilePlus />随机表情</button><textarea value={replyDraft} onChange={(event) => setReplyDraft(event.target.value)} readOnly={!authenticated} onClick={() => { if (!authenticated) onLogin() }} maxLength={20_000} placeholder={authenticated ? '补充信息、方法或继续追问…' : '登录后参与讨论'} /><button className="primary-button" type="submit" disabled={replyBusy}>{replyBusy ? <LoaderCircle className="spin" /> : <Send />}发布回复</button><input ref={replyFileRef} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif" onChange={(event) => chooseImage(event, 'reply')} /></div>
        </form>
      </section>
    </div>}

    {composerOpen && <div className="community-sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !composerBusy) setComposerOpen(false) }}>
      <form className="community-create-dialog" role="dialog" aria-modal="true" aria-labelledby="community-create-title" onSubmit={(event) => void createThread(event)}>
        <header><div><span>与网站同步发布</span><h2 id="community-create-title">新讨论</h2></div><button type="button" className="icon-button" aria-label="关闭发布讨论" onClick={() => setComposerOpen(false)}><X /></button></header>
        <div className="community-create-grid"><label><span>圈子</span><select value={composerDraft.circle} onChange={(event) => setComposerDraft((current) => ({ ...current, circle: event.target.value }))}>{spaces.map((space) => <option value={space.slug} key={space.id}>{space.name}</option>)}</select></label><label><span>类型</span><select value={composerDraft.type} onChange={(event) => setComposerDraft((current) => ({ ...current, type: event.target.value }))}>{Object.entries(typeLabels).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label></div>
        <label><span>标题 <small>{Array.from(composerDraft.title).length}/180</small></span><input autoFocus value={composerDraft.title} onChange={(event) => setComposerDraft((current) => ({ ...current, title: event.target.value }))} maxLength={180} placeholder="具体写清问题、方法或作品" /></label>
        <label><span>正文 <small>{Array.from(composerDraft.body).length}/30000</small></span><textarea value={composerDraft.body} onChange={(event) => setComposerDraft((current) => ({ ...current, body: event.target.value }))} maxLength={30_000} placeholder="说明真实任务、过程、关键条件与遇到的问题…" /></label>
        <label><span>标签 <small>最多 5 个，用逗号分隔</small></span><input value={composerDraft.tags} onChange={(event) => setComposerDraft((current) => ({ ...current, tags: event.target.value }))} placeholder="DeepSeek，多模态，Harness" /></label>
        <footer><span>文字会经过与网站相同的违禁词检测</span><button type="button" className="quiet-button" onClick={() => setComposerOpen(false)}>取消</button><button type="submit" className="primary-button" disabled={composerBusy}>{composerBusy ? <LoaderCircle className="spin" /> : <Plus />}发布讨论</button></footer>
      </form>
    </div>}

    {previewUrl && <div className="community-media-lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewUrl('') }}><button aria-label="关闭图片预览" onClick={() => setPreviewUrl('')}><X /></button><img src={previewUrl} alt="社区图片高清预览" /></div>}
  </div>
}
