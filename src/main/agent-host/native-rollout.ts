import path from 'node:path'
import { open, realpath } from 'node:fs/promises'

export function parseNativeTurn(text: string, turnId: string): Array<Record<string, unknown>> {
  let current = ''; const items = new Map<string, Record<string, unknown>>()
  for (const line of text.split('\n')) {
    let row: { type: string; payload?: Record<string, any> }
    try { row = JSON.parse(line) } catch { continue }
    const p = row.payload || {}
    if (row.type === 'event_msg' && p.type === 'task_started') current = p.turn_id
    if (row.type === 'turn_context') current = p.turn_id
    const id = p.turn_id || p.internal_chat_message_metadata_passthrough?.turn_id || current
    if (id !== turnId) continue
    const item = row.type === 'event_msg' && p.type === 'item_completed' ? p.item : p
    if (!item) continue
    const kind = String(item.type || '').toLowerCase().replaceAll('_', '')
    if (kind === 'functioncalloutput' && item.namespace === 'codex_app' && item.name === 'send_message_to_thread') {
      const message = /^<codex_delegation>[\s\S]*?<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/.exec(String(item.output || ''))?.[1]
      if (message) items.set(item.id, { id: item.id, type: 'userMessage', source: 'desktop-relay', content: [{ type: 'text', text: message }] })
    } else if (kind === 'agentmessage' || (kind === 'message' && item.role === 'assistant')) {
      if (item.phase !== 'final_answer') continue
      const message = Array.isArray(item.content) ? item.content.map((part: { text?: string }) => part.text || '').join('') : String(item.text || '')
      if (message) items.set(item.id, { id: item.id, type: 'agentMessage', phase: 'final_answer', text: message })
    } else if (kind === 'usermessage' || (kind === 'message' && item.role === 'user')) {
      items.set(item.id, { id: item.id, type: 'userMessage', content: (item.content || []).map((part: { text?: string }) => ({ type: 'text', text: part.text || '' })) })
    }
  }
  return [...items.values()]
}
export function parseNativeSnapshot(text: string): Array<{ id: string; status: string; items: Array<Record<string, unknown>> }> {
  const turns = new Map<string, string>()
  let current = ''
  for (const line of text.split('\n')) {
    let row: { type: string; payload?: Record<string, any> }
    try { row = JSON.parse(line) } catch { continue }
    const p = row.payload || {}
    const id = p.turn_id || p.internal_chat_message_metadata_passthrough?.turn_id
    if (id) { current = id; if (!turns.has(id)) turns.set(id, 'inProgress') }
    if (row.type !== 'event_msg' || !current) continue
    if (p.type === 'task_complete') turns.set(current, 'completed')
    if (p.type === 'turn_aborted') turns.set(current, 'interrupted')
  }
  let budget = 192 * 1024
  return [...turns].slice(-5).reverse().map(([id, status]) => {
    const selected: Array<Record<string, unknown>> = []
    for (const item of parseNativeTurn(text, id).reverse()) {
      const size = Buffer.byteLength(JSON.stringify(item))
      if (size > budget) continue
      budget -= size; selected.unshift(item)
    }
    return { id, status, items: selected }
  })
}

// Never ask Desktop to summarize a long conversation on the send-critical path.
// Read the exact native index row and a bounded tail; this does not resume,
// modify, or acquire the conversation's writer lock.
export async function readNativeSnapshot(threadId: string): Promise<Record<string, unknown>> {
  if (!/^[a-f0-9-]{36}$/i.test(threadId)) throw new Error('Invalid thread id')
  const home = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex')
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(path.join(home, 'state_5.sqlite'), { readOnly: true })
  let row: { rollout_path: string; cwd: string; model?: string } | undefined
  try { row = database.prepare('SELECT rollout_path, cwd, model FROM threads WHERE id = ?').get(threadId) as typeof row } finally { database.close() }
  if (!row) throw new Error('原对话不在当前本机索引中')
  const root = await realpath(path.join(home, 'sessions'))
  const file = await realpath(row.rollout_path)
  const relative = path.relative(root, file)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !file.endsWith('.jsonl')) throw new Error('原对话记录路径无效')
  const handle = await open(file, 'r')
  try {
    const size = (await handle.stat()).size; const length = Math.min(size, 512 * 1024)
    const buffer = Buffer.alloc(length); const { bytesRead } = await handle.read(buffer, 0, length, size - length)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    let model: string | undefined = row.model
    for (const line of text.split('\n')) { try { const row = JSON.parse(line); if (row.type === 'turn_context' && typeof row.payload?.model === 'string') model = row.payload.model } catch { /* partial tail line */ } }
    return { thread: { id: threadId, cwd: row.cwd, model }, turns: parseNativeSnapshot(text), source: 'native-local-events' }
  } finally { await handle.close() }
}
