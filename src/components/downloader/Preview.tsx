import { useCallback, useRef } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import type { ClientState } from '../../../shared/contracts'
import type { Send } from '@/App'

// The dialog an item's page is previewed in. The page itself is not in here: platform pages refuse to
// be framed, so the main process lays a view of its own over the area this dialog leaves empty, and is
// told where that area is whenever it moves. Clicking outside the dialog, Esc or the close button ends
// the preview; so can Esc inside the page, which the main process catches and reports through the state.
export function Preview({ preview, send }: { preview: ClientState['preview']; send: Send }) {
  const element = useRef<HTMLDivElement | null>(null)
  const place = useCallback(() => {
    if (!element.current) return
    const { x, y, width, height } = element.current.getBoundingClientRect()
    void send('preview:place', { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) })
  }, [send])
  const area = useCallback((node: HTMLDivElement | null) => {
    element.current = node
    if (!node) return
    const observer = new ResizeObserver(place)
    observer.observe(node)
    window.addEventListener('resize', place)
    return () => { observer.disconnect(); window.removeEventListener('resize', place) }
  }, [place])
  // The dialog zooms in as it opens, and a size observer does not see a transform: the area is measured
  // again once the animation has settled, or the page would sit where the dialog was mid-zoom.
  return <Dialog open={Boolean(preview)} onOpenChange={open => { if (!open) void send('preview:close', null) }}>
    <DialogContent className="h-[85vh] w-[min(92vw,80rem)] grid-rows-[auto_1fr] gap-0 overflow-hidden p-0 sm:max-w-none" onAnimationEnd={place}>
      <DialogTitle className="truncate py-3 pr-12 pl-4 text-sm">{preview?.title}</DialogTitle>
      <div ref={area} className="grid min-h-0 place-items-center bg-black text-sm text-white/60">正在打开页面…</div>
    </DialogContent>
  </Dialog>
}
