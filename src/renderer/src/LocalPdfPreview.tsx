import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

/** Local capability URL only; PDF actions, scripts, remote images and links are not executed. */
export function LocalPdfPreview({ url }: { url: string }): React.JSX.Element {
  const [document, setDocument] = useState<PDFDocumentProxy>()
  const [page, setPage] = useState(1), [error, setError] = useState(''), [progress, setProgress] = useState(0), [rendering, setRendering] = useState(true)
  const [renderedPage, setRenderedPage] = useState(0)
  const canvas = useRef<HTMLCanvasElement>(null), viewport = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  useEffect(() => {
    const node = viewport.current
    if (!node) return
    const observer = new ResizeObserver(entries => setWidth(Math.max(160, Math.floor(entries[0]!.contentRect.width - 32))))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let alive = true, destroy: (() => Promise<void>) | undefined
    setDocument(undefined); setPage(1); setError(''); setProgress(0)
    void Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([pdf, worker]) => {
      if (!alive) return
      pdf.GlobalWorkerOptions.workerSrc = worker.default
      const task = pdf.getDocument({ url, enableXfa: false, useSystemFonts: true })
      destroy = () => task.destroy()
      task.onProgress = (value: { loaded: number; total: number }) => { if (alive && value.total > 0) setProgress(Math.min(100, Math.round(value.loaded / value.total * 100))) }
      return task.promise.then(value => { if (alive) setDocument(value) })
    }).catch(() => { if (alive) setError('PDF 无法预览，可能已加密、损坏或本地服务已断开。可另存后检查。') })
    return () => { alive = false; void destroy?.().catch(() => {}) }
  }, [url])
  useEffect(() => {
    if (!document || !canvas.current) return
    let alive = true, cancel: (() => void) | undefined
    setRendering(true); setError('')
    void document.getPage(page).then(async pdfPage => {
      if (!alive || !canvas.current) return
      const original = pdfPage.getViewport({ scale: 1 })
      const scale = Math.min(width / original.width, 2)
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (original.width * original.height * scale * scale)))
      const view = pdfPage.getViewport({ scale: scale * ratio })
      const node = canvas.current
      node.width = Math.ceil(view.width); node.height = Math.ceil(view.height)
      node.style.width = `${view.width / ratio}px`; node.style.height = `${view.height / ratio}px`
      const task = pdfPage.render({ canvas: node, viewport: view })
      cancel = () => task.cancel()
      await task.promise
      if (alive) { setRenderedPage(page); setRendering(false) }
    }).catch(() => { if (alive) { setError('这一页未能显示，请切换页面或另存查看。'); setRendering(false) } })
    return () => { alive = false; cancel?.() }
  }, [document, page, width])
  return <div className="lcr-pdf">
    <nav aria-label="PDF 翻页"><button className="small-button" aria-label="PDF 上一页" disabled={!document || page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} /></button><span>{document ? `${page} / ${document.numPages} 页` : '加载 PDF'}</span><button className="small-button" aria-label="PDF 下一页" disabled={!document || page >= document.numPages} onClick={() => setPage(value => value + 1)}><ChevronRight size={16} /></button></nav>
    <div className="lcr-pdf-pages" ref={viewport} aria-busy={!error && (!document || rendering)}>
      {error ? <p role="alert" className="lcr-help">{error}</p> : !document ? <p role="status" className="lcr-help">读取本地 PDF…{progress ? ` ${progress}%` : ''}</p> : rendering && <p role="status" className="lcr-help">正在绘制第 {page} 页…</p>}
      <canvas ref={canvas} hidden={!document || !!error} data-rendered-page={renderedPage} role="img" aria-label={`PDF 第 ${renderedPage} 页`} />
    </div>
  </div>
}
