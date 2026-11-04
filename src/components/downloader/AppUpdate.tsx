import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import type { Send } from '@/App'
import type { ClientState } from '../../../shared/contracts'
import { TransferProgress } from './TransferProgress'

export function AppUpdate({ state, send }: { state: ClientState; send: Send }) {
  const { t } = useTranslation('desktop')
  const [pending, setPending] = useState<'check' | 'download' | 'cancel' | 'install'>()
  const update = state.update
  const checking = update.status === 'checking' || pending === 'check'
  const transferring = ['connecting', 'downloading', 'verifying', 'cancelling'].includes(update.status)
  const busy = checking || transferring || pending !== undefined
  const hasActiveJobs = state.jobs.some(job => ['running', 'queued'].includes(job.status))
  const run = (operation: NonNullable<typeof pending>) => {
    if (pending && !(operation === 'cancel' && pending === 'download')) return
    setPending(operation)
    void send(`update:${operation === 'check' ? 'check' : operation === 'download' ? 'download' : operation === 'cancel' ? 'cancel' : 'install'}`, null).finally(() => setPending(undefined))
  }
  const status = checking ? 'checking' : pending === 'download' && !transferring && !update.external ? 'connecting' : update.status
  const label = status === 'idle' && update.message ? update.message : t(`update.states.${status}`, { version: update.version })
  return <Card size="sm" role="region" aria-labelledby="app-update-title">
    <CardHeader>
      <CardTitle id="app-update-title">{t('update.title')}</CardTitle>
      <CardDescription>{t('update.current', { version: update.currentVersion || '—' })}</CardDescription>
      <CardAction><Button type="button" variant="outline" disabled={busy} onClick={() => run('check')}>
        {checking && <Spinner data-icon="inline-start" aria-hidden="true" />}
        {checking ? t('update.checking') : update.failedOperation === 'check' ? t('update.retryCheck') : t('update.check')}
      </Button></CardAction>
    </CardHeader>
    <CardContent className="flex flex-col gap-3">
      <div className="flex items-center gap-2" role="status" aria-live="polite" aria-atomic="true">
        {['connecting', 'verifying', 'cancelling'].includes(status) && <Spinner aria-hidden="true" />}
        <span>{label}</span>
      </div>
      {update.status === 'error' ? <Alert variant="destructive"><AlertTitle>{t(update.failedOperation === 'download' ? 'update.downloadFailed' : 'update.checkFailed')}</AlertTitle><AlertDescription className="break-words">{update.message}</AlertDescription></Alert>
        : status !== 'idle' && update.message && <p className="text-sm text-muted-foreground">{update.message}</p>}
      {update.slow && <p className="text-sm text-muted-foreground">{t('update.slow')}</p>}
      {(transferring || status === 'connecting') && <TransferProgress label={t('update.package', { version: update.version })}
        value={update.progress ?? null} downloaded={update.downloaded ?? 0} total={update.total} speed={update.speed} eta={update.eta}
        active={status === 'downloading'} waiting={update.waiting} />}
      <div className="flex flex-wrap items-center gap-2">
        {(update.status === 'available' || update.status === 'error' && update.failedOperation === 'download') && <Button type="button" disabled={busy} onClick={() => run('download')}>
          {pending === 'download' && <Spinner data-icon="inline-start" aria-hidden="true" />}
          {update.external ? t('update.openRelease') : update.status === 'error' ? t('update.retryDownload') : t('update.download', { version: update.version })}
        </Button>}
        {['connecting', 'downloading'].includes(update.status) && <Button type="button" variant="outline" onClick={() => run('cancel')}>{t('update.cancel')}</Button>}
        {update.status === 'ready' && <Button type="button" disabled={hasActiveJobs || busy} onClick={() => run('install')}>{t('update.install')}</Button>}
        {update.status === 'ready' && hasActiveJobs && <span className="text-xs text-muted-foreground">{t('update.pauseFirst')}</span>}
      </div>
    </CardContent>
  </Card>
}
