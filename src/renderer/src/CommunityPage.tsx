import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react'
import { ArrowLeft, ExternalLink, Image as ImageIcon, LoaderCircle, MessageCircle, Plus, RefreshCw, Search, Send, SmilePlus, X } from 'lucide-react'
import type { LauncherCommunityRequest, LauncherCommunityUpload, LauncherSnapshot } from '../../shared/types'

type SavedSticker = { id: string; label: string; imageUrl?: string; stickerId?: string }
type Author = { name: string }
type Reply = { id: string; body: string; imageUrl?: string; stickerId?: string; createdAt: string; author: Author; mediaModerationStatus?: string; mediaBlocked?: boolean }
type Thread = { id: string; title: string; summary: string; body: string; replyCount: number; createdAt: string; author: Author; readOnly?: boolean; status?: string; comments?: Reply[]; viewer?: { bookmarked?: boolean } }
const ROOT = 'https://ailishishu.com'
const STICKERS = [['deepseek-cheerful','开心'],['deepseek-serious','认真'],['deepseek-confused','困惑'],['deepseek-angry','生气'],['deepseek-exasperated','无语'],['deepseek-starry','星星眼'],['bqb-03','一行代码三个报错'],['bqb-06','这个网站不费 token'],['bqb-08','复杂的事简单做'],['bqb-10','鼓掌']] as const
const stickerUrl = (id: string): string => `${ROOT}/community/assets/memes/${encodeURIComponent(id)}.webp`
function mediaUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try { const url = new URL(value, ROOT); return url.protocol === 'https:' ? url.href : undefined } catch { return undefined }
}
function date(value: string): string { const d = new Date(value.includes('T') ? value : value.replace(' ', 'T') + '+08:00'); return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '' }
function parseThread(value: unknown): Thread | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || typeof row.title !== 'string') return undefined
  const author = row.author as Author | undefined
  return { id: row.id, title: row.title, body: typeof row.body === 'string' ? row.body : '', summary: typeof row.summary === 'string' ? row.summary : '', replyCount: Number(row.replyCount) || 0, createdAt: String(row.createdAt || ''), author: { name: author?.name || '社区成员' }, readOnly: row.readOnly === true, status: String(row.status || ''), viewer: row.viewer as Thread['viewer'], comments: Array.isArray(row.comments) ? row.comments.filter(x => x && typeof x.id === 'string').map(x => ({ id: x.id, body: typeof x.body === 'string' ? x.body : '', imageUrl: mediaUrl(x.imageUrl), stickerId: typeof x.stickerId === 'string' ? x.stickerId : undefined, createdAt: String(x.createdAt || ''), author: { name: x.author?.name || '社区成员' }, mediaModerationStatus: x.mediaModerationStatus, mediaBlocked: x.mediaBlocked === true })) : [] }
}
export function CommunityPage({ snapshot, onLogin }: { snapshot: LauncherSnapshot; onLogin: () => void }): ReactNode {
  const [threads, setThreads] = useState<Thread[]>([]), [thread, setThread] = useState<Thread>(), [error, setError] = useState('')
  const [loading, setLoading] = useState(false), [sending, setSending] = useState(false), [compose, setCompose] = useState(false)
  const [title, setTitle] = useState(''), [body, setBody] = useState(''), [reply, setReply] = useState(''), [query, setQuery] = useState('')
  const [sort, setSort] = useState<'recommended' | 'latest'>('recommended'), [page, setPage] = useState(1), [hasMore, setHasMore] = useState(false)
  const [saved, setSaved] = useState<SavedSticker[]>([]), [savedId, setSavedId] = useState('')
  const [picker, setPicker] = useState(false), [sticker, setSticker] = useState(''), [file, setFile] = useState<File>(), [filePreview, setFilePreview] = useState('')
  const sequence = useRef(0), alive = useRef(true), pending = useRef<{ signature: string; id: string } | undefined>(undefined), imageInput = useRef<HTMLInputElement>(null)
  const authenticated = snapshot.account.status === 'signed_in'
  const request = async (value: LauncherCommunityRequest): Promise<Record<string, unknown>> => { if (!window.launcher?.communityRequest) throw new Error('社区功能需要新版基础内核，请升级启动器'); return window.launcher.communityRequest(value) }
  const login = (): boolean => { if (authenticated) return true; onLogin(); return false }
  const idFor = (signature: string): string => { if (pending.current?.signature === signature) return pending.current.id; const id = `fish-${crypto.randomUUID()}`; pending.current = { signature, id }; return id }
  const clearMedia = (): void => { setFile(undefined); setSticker(''); setSavedId(''); if (imageInput.current) imageInput.current.value = '' }
  const loadFeed = async (nextPage = 1): Promise<void> => {
    const seq = ++sequence.current; setLoading(true); setError(''); setThread(undefined)
    try { const result = await request({ scope: 'forum', method: 'GET', action: nextPage === 1 ? 'bootstrap' : 'feed', realm: 'tool', circle: 'deepseek', query, sort, page: nextPage }); if (!alive.current || seq !== sequence.current) return
      if (Array.isArray(result.savedStickers)) setSaved(result.savedStickers as SavedSticker[])
      const rows = (Array.isArray(result.threads) ? result.threads : []).map(parseThread).filter((x): x is Thread => !!x)
      setThreads(previous => nextPage === 1 ? rows : [...previous, ...rows.filter(x => !previous.some(y => y.id === x.id))]); setPage(nextPage); setHasMore(rows.length === 24)
    } catch (e) { if (alive.current && seq === sequence.current) setError(e instanceof Error ? e.message : '话题加载失败') }
    finally { if (alive.current && seq === sequence.current) setLoading(false) }
  }
  const openThread = async (id: string): Promise<void> => {
    const seq = ++sequence.current; setLoading(true); setError(''); setCompose(false)
    try { const result = await request({ scope: 'forum', method: 'GET', action: 'thread', id }); if (!alive.current || seq !== sequence.current) return; const selected = parseThread(result.thread); if (!selected) throw new Error('话题数据不完整，请刷新重试'); setThread(selected); if (Array.isArray(result.savedStickers)) setSaved(result.savedStickers as SavedSticker[]) }
    catch (e) { if (alive.current && seq === sequence.current) setError(e instanceof Error ? e.message : '无法打开话题') }
    finally { if (alive.current && seq === sequence.current) setLoading(false) }
  }
  useEffect(() => { alive.current = true; void loadFeed(); return () => { alive.current = false; sequence.current++ } }, [sort])
  useEffect(() => { if (!file) { setFilePreview(''); return }; const url = URL.createObjectURL(file); setFilePreview(url); return () => URL.revokeObjectURL(url) }, [file])
  useEffect(() => { if (!picker) return; const close = (event: PointerEvent): void => { const target = event.target as Element; if (!target.closest('.fish-sticker-panel') && !target.closest('[aria-expanded]')) setPicker(false) }; window.addEventListener('pointerdown', close); return () => window.removeEventListener('pointerdown', close) }, [picker])
  const createTopic = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); if (sending || !login()) return
    const cleanTitle = title.trim(), cleanBody = body.trim(); if (cleanTitle.length < 2 || !cleanBody) { setError('请填写标题和正文'); return }
    setSending(true); setError('')
    try { const result = await request({ scope: 'forum', method: 'POST', action: 'create_thread', clientRequestId: idFor(JSON.stringify(['topic', cleanTitle, cleanBody])), circle: 'deepseek', threadType: 'discussion', title: cleanTitle, body: cleanBody, tags: [] }); if (!alive.current) return; pending.current = undefined; setTitle(''); setBody(''); setCompose(false); await openThread(String(result.threadId)) }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '发布未完成，内容已保留') }
    finally { if (alive.current) setSending(false) }
  }
  const sendReply = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); if (sending || !thread || !login()) return
    if (!reply.trim() && !sticker && !savedId && !file) { setError('写点留言，或者选一张图片、表情'); return }
    const threadId = thread.id; setSending(true); setError('')
    try {
      let image: LauncherCommunityUpload | undefined
      if (file) image = { name: file.name.slice(0, 180), mimeType: file.type as LauncherCommunityUpload['mimeType'], bytes: await file.arrayBuffer() }
      await request({ scope: 'forum', method: 'POST', action: 'create_reply', clientRequestId: idFor(JSON.stringify(['reply', threadId, reply, sticker, savedId, file?.name, file?.size, file?.lastModified])), threadId, body: reply.trim(), ...(sticker ? { stickerId: sticker } : {}), ...(savedId ? { savedStickerId: savedId } : {}), ...(image ? { image } : {}) })
      if (!alive.current) return; pending.current = undefined; setReply(''); clearMedia(); await openThread(threadId)
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '发送未完成，留言已保留') }
    finally { if (alive.current) setSending(false) }
  }
  const refreshSaved = async (): Promise<void> => { const result = await request({ scope: 'chat', method: 'GET', channel: 'deepseek' }); if (alive.current && Array.isArray(result.savedStickers)) setSaved(result.savedStickers as SavedSticker[]) }
  const saveSticker = async (postId: string): Promise<void> => { if (!login()) return; try { await request({ scope: 'chat', method: 'POST', action: 'save_sticker', sourceType: 'post', sourceKey: postId }); await refreshSaved() } catch(e) { if (alive.current) setError(e instanceof Error ? e.message : '表情收藏失败') } }
  const removeSticker = async (id: string): Promise<void> => { if (!login() || !confirm('从我的表情中删除这一张？')) return; try { await request({ scope: 'chat', method: 'POST', action: 'delete_sticker', stickerId: id }); if (savedId === id) clearMedia(); await refreshSaved() } catch(e) { if (alive.current) setError(e instanceof Error ? e.message : '删除失败') } }
  const savedImage = (item: SavedSticker): string | undefined => mediaUrl(item.imageUrl) || (item.stickerId ? stickerUrl(item.stickerId) : undefined)
  return <section className="fish-launcher-board" aria-label="大肥鱼社区">
    <header className="fish-launcher-heading"><img src={stickerUrl('deepseek-cheerful')} alt="DeepSeek 社区鲸鱼娘" /><div><h1>大肥鱼社区</h1><p>DeepSeek 同好聚在这里。聊体验、聊日常，也一起斗图。</p></div><button className="primary-button" onClick={() => { if (login()) setCompose(true) }}><Plus size={16} />发起话题</button></header>
    {error && <div className="fish-error" role="alert">{error}</div>}
    {compose && <form className="fish-compose" onSubmit={event => void createTopic(event)}><h2>发起一个话题</h2><label>话题标题<input value={title} onChange={e => setTitle(e.target.value)} minLength={2} maxLength={180} required placeholder="今天想和大家聊什么？" /></label><label>说点什么<textarea value={body} onChange={e => setBody(e.target.value)} maxLength={30000} rows={4} required placeholder="分享经历、抛出问题，或者先打个招呼。" /></label><div className="fish-actions"><button className="quiet-button" type="button" onClick={() => setCompose(false)}>取消</button><button className="primary-button" disabled={sending} type="submit">{sending ? '正在发布…' : '发布话题'}</button></div></form>}
    {!thread ? <><div className="fish-toolbar"><div className="fish-sort"><button aria-pressed={sort === 'recommended'} onClick={() => setSort('recommended')}>最近回复</button><button aria-pressed={sort === 'latest'} onClick={() => setSort('latest')}>最新发布</button></div><form onSubmit={e => { e.preventDefault(); void loadFeed() }}><input aria-label="搜索话题" value={query} onChange={e => setQuery(e.target.value)} maxLength={80} placeholder="搜索话题" /><button className="quiet-button" aria-label="搜索" type="submit"><Search size={16} /></button></form><button className="quiet-button" onClick={() => void loadFeed()} disabled={loading}><RefreshCw size={15} />刷新</button></div>
      {loading && <p className="fish-empty" role="status"><LoaderCircle size={18} />正在加载话题…</p>}
      {!loading && !threads.length && <p className="fish-empty">{query ? '没有找到相关话题，换个关键词试试。' : '还没有话题。来做第一个打招呼的人吧。'}</p>}
      <div className="fish-topics">{threads.map(t => <article key={t.id}><div className="fish-count"><strong>{t.replyCount}</strong><span>留言</span></div><div><button className="fish-topic-title" onClick={() => { clearMedia(); setReply(''); void openThread(t.id) }}>{t.title}</button><p>{t.summary}</p><small>{t.author.name} · {date(t.createdAt)}</small></div></article>)}</div>{hasMore && <button className="quiet-button fish-more" disabled={loading} onClick={() => void loadFeed(page + 1)}>加载更多话题</button>}</>
      : <><button className="quiet-button" onClick={() => { clearMedia(); setReply(''); void loadFeed() }}><ArrowLeft size={15} />返回话题列表</button><article className="fish-topic-detail"><h2>{thread.title}</h2><small>{thread.author.name} · {date(thread.createdAt)} · {thread.replyCount} 条留言</small><p className="fish-body">{thread.body}</p><button className="quiet-button" onClick={() => void window.launcher?.openExternal(`${ROOT}/community/#thread=${encodeURIComponent(thread.id)}`)}>到网站管理 / 举报<ExternalLink size={14} /></button></article>
      <h2 className="fish-reply-heading">留言 · {thread.replyCount}</h2>{!thread.comments?.length && <p className="fish-empty">还没有留言。来接第一句话吧。</p>}{thread.comments?.map(c => <article className="fish-reply" key={c.id}><header><strong>{c.author.name}</strong><small>{date(c.createdAt)}</small></header>{c.body && <p className="fish-body">{c.body}</p>}{!c.mediaBlocked && (c.imageUrl || c.stickerId) && <img className="fish-post-image" src={c.imageUrl || stickerUrl(c.stickerId!)} alt="留言中的图片或表情" loading="lazy" />}{!c.mediaBlocked && (c.imageUrl || c.stickerId) && <button className="text-button" onClick={() => void saveSticker(c.id)}>收藏表情</button>}{c.mediaModerationStatus === 'pending' && <small>图片正在审核</small>}{c.mediaBlocked && <small>图片已隐藏</small>}</article>)}
      {thread.readOnly || thread.status === 'locked' ? <p className="fish-empty">这个旧话题已归档，保留阅读。新交流请发起话题。</p> : <form className="fish-compose" onSubmit={event => void sendReply(event)}><h2>加入这个话题</h2><textarea aria-label="留言内容" value={reply} onChange={e => setReply(e.target.value)} maxLength={20000} rows={3} placeholder="说点什么，或选张表情和大家斗图…" /><div className="fish-media-tools"><button type="button" className="quiet-button" aria-expanded={picker} onClick={() => setPicker(!picker)}><SmilePlus size={16} />选表情</button><button type="button" className="quiet-button" onClick={() => imageInput.current?.click()}><ImageIcon size={16} />上传图片 / GIF</button><small>不超过 5 MB</small><input ref={imageInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={e => { const next = e.target.files?.[0]; if (!next) return; if (!['image/jpeg','image/png','image/webp','image/gif'].includes(next.type) || next.size < 1 || next.size > 5 * 1024 * 1024) { setError('请选择不超过 5 MB 的 JPG、PNG、WebP 或 GIF'); e.target.value = ''; return }; clearMedia(); setFile(next) }} /></div>
      {picker && <section className="fish-sticker-panel"><h3>我的表情</h3>{!saved.length && <p>在留言图片旁点击“收藏表情”，下次就能直接使用。</p>}<div className="fish-stickers">{saved.map(item => <div key={item.id}><button type="button" aria-label={`使用收藏表情 ${item.label}`} onClick={() => { clearMedia(); setSavedId(item.id); setPicker(false) }}><img src={savedImage(item)} alt={item.label || "收藏表情"} /></button><button type="button" className="text-button" onClick={() => void removeSticker(item.id)}>删除</button></div>)}</div><h3>公共表情</h3><div className="fish-stickers">{STICKERS.map(([id, label]) => <button type="button" key={id} aria-label={label} onClick={() => { clearMedia(); setSticker(id); setPicker(false) }}><img src={stickerUrl(id)} alt={label} loading="lazy" /></button>)}</div></section>}{(file || sticker || savedId) && <div className="fish-attachment"><img src={file ? filePreview : savedId ? savedImage(saved.find(item => item.id === savedId) || { id: savedId, label: "" }) : stickerUrl(sticker)} alt="待发送附件" /><span>{file?.name || '已选表情'}</span><button className="quiet-button" type="button" onClick={clearMedia} aria-label="移除附件"><X size={15} /></button></div>}
      <div className="fish-actions"><small>文字、图片、表情均可单独发送</small><button className="primary-button" type="submit" disabled={sending}><Send size={15} />{sending ? '正在发送…' : authenticated ? '发送留言' : '登录后留言'}</button></div></form>}</>}
    <footer className="fish-footer"><MessageCircle size={14} />友好交流，尊重创作。<button className="text-button" onClick={() => void window.launcher?.openExternal('https://github.com/JAdpp/dsh-whale-galgame')}>社区美术 · CC BY-NC-SA 4.0</button></footer>
  </section>
}
