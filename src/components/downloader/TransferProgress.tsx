import { useTranslation } from 'react-i18next'
import { Progress } from '@/components/ui/progress'
import { formatBytes, formatDuration } from '@/lib/utils'

// Both the queue and updater already report byte statistics. Compose the shared Progress and
// formatters so that unknown totals and stalled transfers are presented consistently.
export function TransferProgress({ label, value, downloaded, total, speed, eta, active = false, waiting = false, showBar = true, showTransfer = true }: {
  label: string; value: number | null; downloaded?: number; total?: number; speed?: number; eta?: number;
  active?: boolean; waiting?: boolean; showBar?: boolean; showTransfer?: boolean;
}) {
  const { t } = useTranslation('common')
  const percent = value !== null && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null
  const bytes = downloaded !== undefined && Number.isFinite(downloaded) ? Math.max(0, downloaded) : undefined
  const size = total !== undefined && Number.isFinite(total) && total > 0 ? total : undefined
  const rate = speed !== undefined && Number.isFinite(speed) && speed > 0 ? speed : undefined
  const remaining = eta !== undefined && Number.isFinite(eta) && eta >= 0 && (!showTransfer || rate !== undefined) ? eta : undefined
  return <div className="flex min-w-0 flex-col gap-2">
    <div className="flex items-center justify-between gap-3 text-xs tabular-nums">
      <span className="text-muted-foreground">{label}</span>
      {percent !== null && <span>{Math.floor(percent)}%</span>}
    </div>
    {showBar && <Progress value={percent} aria-label={label} />}
    {(showTransfer || active && remaining !== undefined) && <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground">
      {showTransfer && <span>{bytes !== undefined ? formatBytes(bytes) : '—'}{size ? ` / ${formatBytes(size)}` : ''}</span>}
      {active && showTransfer && <span>{waiting ? t('transfer.waiting') : rate ? `${formatBytes(rate)}/s` : t('transfer.measuring')}</span>}
      {active && remaining !== undefined && !waiting && <span>{t('transfer.remaining', { time: formatDuration(remaining) })}</span>}
    </div>}
  </div>
}
