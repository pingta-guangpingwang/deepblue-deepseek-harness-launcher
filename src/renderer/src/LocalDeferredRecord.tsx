import { useEffect, useRef, useState } from 'react'
import type { LocalControlEvent } from '../../shared/local-control'
export function LocalDeferredRecord({ event, read, render }: { event: LocalControlEvent; read(offset: number): Promise<{ chunk: string; total: number; nextOffset: number }>; render(event: LocalControlEvent): React.JSX.Element }): React.JSX.Element {
  const [loaded, setLoaded] = useState<LocalControlEvent>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [progress, setProgress] = useState(0)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  async function load(): Promise<void> {
    if (busy) return; setBusy(true); setError('')
    try {
      const chunks: string[] = [], decoder = new TextDecoder(); let offset = 0, total = 1
      while (offset < total) {
        if (!alive.current) return
        const page = await read(offset)
        if (page.nextOffset <= offset) throw new Error('长记录读取没有推进，请重试')
        chunks.push(decoder.decode(Uint8Array.from(atob(page.chunk), char => char.charCodeAt(0)), { stream: true })); offset = page.nextOffset; total = page.total; setProgress(Math.round(offset / total * 100))
      }
      chunks.push(decoder.decode()); setLoaded({ ...event, payload: JSON.parse(chunks.join('')) })
    } catch (cause) { setError(cause instanceof Error ? cause.message : '长记录读取失败') }
    finally { setBusy(false) }
  }
  if (loaded) return render(loaded)
  return <article data-event-seq={event.seq} className="lcr-native-event"><p>这条记录较长，完整内容保留在本机。</p><button className="small-button" disabled={busy} onClick={() => void load()}>{busy ? `正在读取 ${progress}%` : '读取这条完整记录'}</button>{error && <p role="alert">{error}</p>}</article>
}
