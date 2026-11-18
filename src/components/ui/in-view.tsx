import { useInView } from 'react-intersection-observer'

// A marker that calls back once it scrolls into view - the list mounts its next batch of cards there.
// The one place that knows how "in view" is decided: the margin, and that it is watched at all. The
// library stays behind this file so a list can say "when the end comes into view, do this".
export function InView({ onEnter, className }: { onEnter: () => void; className?: string }) {
  const { ref } = useInView({ rootMargin: '320px 0px', onChange: inView => { if (inView) onEnter() } })
  return <div ref={ref} className={className} aria-hidden="true" />
}
