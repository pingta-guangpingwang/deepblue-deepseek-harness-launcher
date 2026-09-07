import { createHash } from 'node:crypto'
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { desktopRelayRequest } from './desktop-relay'
import { sameLocalPath } from './local-models'

interface Options {
  project: { path: string }; instruction: string; resumeSessionId: string; runtimeRequestId?: string; sandbox?: string
  attachments?: unknown[]
  control?: { cancelled?: boolean; closed?: boolean; desktopNative?: boolean }
  onProgress?: (progress: { summary: string }) => Promise<void>
}
interface NativeTurn { id: string; status: string; items?: Array<{ type: string; text?: string; phase?: string; content?: Array<{ text?: string }> }> }
export async function runNativeDesktopTask(options: Options): Promise<Record<string, unknown>> {
  const { resumeSessionId: target, instruction } = options
  const control = options.control || {}; control.desktopNative = true; control.closed = false
  const result = (exitCode: number, diagnostic: string, finalReply = ''): Record<string, unknown> => ({ desktopDelivery: true, sessionId: target, resumeSessionId: target, exitCode, diagnostic, finalReply, cancelled: false })
  try {
    if (control.cancelled) return result(1, '任务已取消，未发送到桌面')
    // Existing web read-only policy must not silently inherit a writable Desktop.
    if (options.sandbox !== 'workspace-write') return result(1, '桌面原对话沿用原生权限，不能保证网页的只读沙箱；请在本机明确切换任务策略后再使用桌面直连')
    if (options.attachments?.length) return result(1, '桌面直连的远程附件尚未接通持久化，消息未发送；本次请先发送文字任务')
    if (!options.runtimeRequestId) return result(1, '远程请求缺少稳定任务编号，拒绝发送以避免重复执行')
    const root = await realpath(options.project.path)
    const before = await desktopRelayRequest({ action: 'read', targetThreadId: target })
    const state = before.result as { thread?: { id: string; cwd?: string }; turns?: NativeTurn[] } | undefined
    const nativeRoot = state?.thread?.cwd ? await realpath(state.thread.cwd).catch(() => '') : ''
    if (!before.ok || state?.thread?.id !== target || !sameLocalPath(nativeRoot, root)) return result(1, '桌面原对话与授权项目不匹配，未发送')
    let baseline = state.turns?.[0]?.id
    const hash = createHash('sha256').update(target + '\0' + options.runtimeRequestId).digest('hex')
    const requestId = `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`
    if (control.cancelled) return result(1, '任务已取消，未发送到桌面')
    const delivery = await desktopRelayRequest({ action: 'send', targetThreadId: target, requestId, message: instruction, baselineTurnId: baseline })
    if (delivery.status !== 'delivered') return result(1, delivery.error || '桌面发送结果未确认；请检查原对话，禁止自动重发')
    baseline = delivery.baselineTurnId || baseline
    await options.onProgress?.({ summary: '已送达桌面原对话，正在同步执行结果' })
    const deadline = Date.now() + 15 * 60 * 1000
    while (Date.now() < deadline) {
      if (control.cancelled) return result(1, '本机同步已停止观察，桌面原任务可能仍在运行；请在 Codex 确认，不能把停止观察当成停止任务')
      const reply = await desktopRelayRequest({ action: 'read', targetThreadId: target })
      const turns = (reply.result as { turns?: NativeTurn[] } | undefined)?.turns || []
      const turn = turns.find(turn => turn.id !== baseline && turn.items?.some(item => item.type === 'userMessage' && item.content?.map(part => part.text || '').join('\n') === instruction))
      if (turn?.status === 'completed') return result(0, '', turn.items?.filter(item => item.type === 'agentMessage' && item.phase === 'final_answer').map(item => item.text || '').join('\n'))
      if (turn?.status === 'failed' || turn?.status === 'interrupted') return result(1, '桌面原对话执行失败或已中断，请查看 Codex')
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    return result(1, '消息已送达，但等待桌面结果超过 15 分钟；请查看原对话，不会自动重复执行')
  } catch (error) { return result(1, error instanceof Error ? error.message : '桌面结果未确认，请检查原对话，勿重发') }
  finally { control.closed = true }
}
