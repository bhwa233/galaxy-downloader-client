import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleHelp, FolderOpen, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet, FieldTitle } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemSeparator, ItemTitle } from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Choice } from './Choice'
import { FilenameSettings } from './FilenameSettings'
import { AppUpdate } from './AppUpdate'
import { TransferProgress } from './TransferProgress'
import { settingsSchema, type ClientState, type Settings } from '../../../shared/contracts'
import type { Send } from '@/App'

const sections = ['general', 'download', 'files', 'subscriptions', 'browser', 'tools'] as const
type Section = typeof sections[number]
type NumericSetting = 'concurrency' | 'speedLimit' | 'taskSpeedLimit' | 'retries' | 'timeout' | 'batchLimit' | 'subscriptionIntervalHours'
type BooleanSetting = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings]

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return <FieldSet className="gap-4 border-t pt-4">
    <FieldLegend variant="label">{title}</FieldLegend>
    <FieldGroup>{children}</FieldGroup>
  </FieldSet>
}

function FieldContentLabel({ id, label, hint }: { id: string; label: string; hint?: string }) {
  const { t } = useTranslation('settings')
  return <div className="flex min-w-0 flex-1 items-center gap-1.5">
    <FieldTitle id={id}>{label}</FieldTitle>
    {hint && <Tooltip><TooltipTrigger render={<Button type="button" variant="ghost" size="icon-xs" aria-label={t('helpFor', { label })} />}><CircleHelp aria-hidden="true" /></TooltipTrigger><TooltipContent>{hint}</TooltipContent></Tooltip>}
  </div>
}

export function Preferences({ state, send, initialSection = 'general' }: { state: ClientState; send: Send; initialSection?: Section }) {
  const { t } = useTranslation(['settings', 'common'])
  const { t: subscriptionsText } = useTranslation('subscriptions')
  const [draft, setDraft] = useState(state.settings)
  const [section, setSection] = useState<Section>(initialSection)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [choosingDirectory, setChoosingDirectory] = useState(false)
  const [kernelChecking, setKernelChecking] = useState(false)
  const candidate = draft
  const valid = settingsSchema.safeParse(candidate).success && (draft.filenameTemplate !== 'custom' || Boolean(draft.customFilenameTemplate.trim()))
  const dirty = JSON.stringify(candidate) !== JSON.stringify(state.settings)
  const patch = (value: Partial<Settings>) => { setDraft(current => ({ ...current, ...value })); setSaved(false) }
  const save = async () => {
    if (!dirty || !valid || saving) return
    setSaving(true)
    try {
      const result = await send('settings:save', candidate)
      if (result && result.settings) { setDraft(result.settings); setSaved(true) }
    } finally { setSaving(false) }
  }
  const chooseDirectory = async () => {
    setChoosingDirectory(true)
    try { const result = await send('settings:directory', null); if (result && result.directory) patch({ downloadDirectory: result.directory }) }
    finally { setChoosingDirectory(false) }
  }
  const number = (key: NumericSetting, label: string, min: number, max: number, hint: string) => <Field>
    <FieldLabel htmlFor={`setting-${key}`}>{label}</FieldLabel>
    <Input id={`setting-${key}`} type="number" required min={min} max={max} value={Number.isNaN(draft[key]) ? '' : draft[key]} onChange={event => patch({ [key]: event.target.valueAsNumber })} />
    <FieldDescription>{hint}</FieldDescription>
  </Field>
  const toggle = (key: BooleanSetting, label: string, hint?: string) => <Field orientation="horizontal">
    <FieldContentLabel id={`toggle-${key}`} label={label} hint={hint} />
    <Switch aria-labelledby={`toggle-${key}`} checked={draft[key]} onCheckedChange={checked => patch({ [key]: checked })} />
  </Field>
  const kernelBusy = kernelChecking || state.kernel?.status === 'checking' || state.kernel?.status === 'downloading'
  const cli = state.commandLine
  const cliReady = state.settings.allowControl && cli.installed && cli.onPath && cli.listening
  const cliMessage = cli.configuring ? t('tools.commandLine.configuring') : cli.error || t(!state.settings.allowControl ? 'tools.commandLine.disabled' : cliReady ? 'tools.commandLine.ready' : 'tools.commandLine.needsSetup')
  return <form className="flex flex-1 flex-col" onSubmit={event => { event.preventDefault(); void save() }}>
    <Card className="flex-1">
      <CardHeader>
        <CardTitle className="sr-only">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
        <CardAction className="flex items-center gap-3">
          <span role="status" className="text-sm text-muted-foreground">{saved && !dirty ? t('saved') : dirty ? t('unsaved') : ''}</span>
          <Button type="submit" disabled={saving || choosingDirectory || !dirty || !valid}><Save data-icon="inline-start" />{saving ? t('saving') : t('save')}</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {dirty && !valid && <p role="alert" className="mb-4 text-sm text-destructive">{t('invalid')}</p>}
        <FieldSet disabled={saving} className="flex-1">
          <Tabs orientation="vertical" value={section} onValueChange={value => setSection(value as Section)} className="flex-1 gap-6">
            <TabsList className="w-40 shrink-0 items-stretch gap-1 self-stretch rounded-none border-r bg-transparent p-0 pr-4">{sections.map(id =>
              <TabsTrigger key={id} value={id} className="h-9 flex-none justify-start rounded-md border-0 px-3 font-normal hover:bg-muted/60 data-active:bg-muted data-active:font-medium dark:data-active:border-transparent dark:data-active:bg-muted group-data-[variant=default]/tabs-list:data-active:shadow-none">{t(`sections.${id}`)}</TabsTrigger>)}
            </TabsList>
            <TabsContent value="general"><FieldGroup>
              <Choice label="语言 · Language" value={draft.locale} onChange={value => patch({ locale: value as Settings['locale'] })} options={[{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]} />
              <Choice label={t('appearance.theme.label')} value={draft.theme} onChange={value => patch({ theme: value as Settings['theme'] })} options={[{ value: 'system', label: t('appearance.theme.system') }, { value: 'light', label: t('appearance.theme.light') }, { value: 'dark', label: t('appearance.theme.dark') }]} />
              <SettingsSection title={t('advanced.general')}>
                {toggle('resumeOnStart', t('general.resumeOnStart.label'), t('general.resumeOnStart.hint'))}
                {toggle('notifications', t('general.notifications.label'), t('general.notifications.hint'))}
                {toggle('minimizeToTray', t('general.minimizeToTray.label'), t('general.minimizeToTray.hint'))}
                {toggle('keepHistory', t('general.keepHistory.label'), t('general.keepHistory.hint'))}
                <Choice label={t('appearance.resultView.label')} value={draft.resultView} onChange={value => patch({ resultView: value as Settings['resultView'] })} options={[{ value: 'auto', label: t('appearance.resultView.auto') }, { value: 'list', label: t('appearance.resultView.list') }, { value: 'grid', label: t('appearance.resultView.grid') }]} />
                <Choice label={t('appearance.density.label')} value={draft.density} onChange={value => patch({ density: value as Settings['density'] })} options={[{ value: 'comfortable', label: t('appearance.density.comfortable') }, { value: 'compact', label: t('appearance.density.compact') }]} />
              </SettingsSection>
            </FieldGroup></TabsContent>
            <TabsContent value="download"><FieldGroup>
              {number('concurrency', t('download.concurrency.label'), 1, 4, t('download.concurrency.hint'))}
              {number('speedLimit', t('download.speedLimit.label'), 0, 1048576, t('download.speedLimit.hint'))}
              {number('batchLimit', t('download.batchLimit.label'), 0, 500, t('download.batchLimit.hint'))}
              <SettingsSection title={t('advanced.download')}>
                {number('taskSpeedLimit', t('download.taskSpeedLimit.label'), 0, 1048576, t('download.taskSpeedLimit.hint'))}
                {number('timeout', t('download.timeout.label'), 5, 300, t('download.timeout.hint'))}
                {number('retries', t('download.retries.label'), 0, 10, t('download.retries.hint'))}
              </SettingsSection>
            </FieldGroup></TabsContent>
            <TabsContent value="files"><FieldGroup>
              <Field>
                <FieldLabel>{t('general.saveLocation')}</FieldLabel>
                <Button type="button" variant="outline" className="justify-start overflow-hidden" disabled={choosingDirectory} aria-label={t('general.saveLocation')} onClick={() => void chooseDirectory()}>{choosingDirectory ? <Spinner aria-hidden="true" /> : <FolderOpen data-icon="inline-start" />}<span className="truncate">{draft.downloadDirectory}</span></Button>
              </Field>
              <FilenameSettings settings={draft} example={state.parse.result?.items[0]} patch={patch} />
              {toggle('organizeByCollection', t('files.organizeByCollection.label'), t('files.organizeByCollection.hint'))}
              <FieldSet>
                <FieldLegend variant="label">{t('files.videoQuality.label')}</FieldLegend>
                <ToggleGroup spacing={0} variant="outline" aria-label={t('files.videoQuality.label')} value={[draft.videoQuality]} onValueChange={([value]) => { if (value === 'best' || value === 'lowest') patch({ videoQuality: value }) }}>
                  <ToggleGroupItem value="best">{t('files.videoQuality.best')}</ToggleGroupItem>
                  <ToggleGroupItem value="lowest">{t('files.videoQuality.lowest')}</ToggleGroupItem>
                </ToggleGroup>
              </FieldSet>
              <Choice label={t('files.audioFormat.label')} value={draft.audioFormat} onChange={value => patch({ audioFormat: value as Settings['audioFormat'] })} options={[{ value: 'best', label: t('files.audioFormat.best') }, ...(['mp3', 'm4a', 'flac'] as const).map(value => ({ value, label: t('files.audioFormat.convert', { format: value.toUpperCase() }) }))]} />
              <SettingsSection title={t('files.cover.legend')}>
                {toggle('saveThumbnail', t('files.cover.save.label'), t('files.cover.save.hint'))}
                {toggle('embedThumbnailInVideo', t('files.cover.embedVideo.label'), t('files.cover.embedVideo.hint'))}
                {toggle('embedThumbnailInAudio', t('files.cover.embedAudio.label'), t('files.cover.embedAudio.hint'))}
                {(draft.saveThumbnail || draft.embedThumbnailInVideo || draft.embedThumbnailInAudio) && <Choice label={t('files.cover.format.label')} value={draft.thumbnailFormat} onChange={value => patch({ thumbnailFormat: value as Settings['thumbnailFormat'] })} options={[{ value: 'original', label: t('files.cover.format.original') }, { value: 'jpg', label: t('files.cover.format.jpg') }]} />}
                <FieldDescription>{t('files.cover.hint')}</FieldDescription>
              </SettingsSection>
              <SettingsSection title={t('files.subtitles.legend')}>
                {toggle('downloadSubtitles', t('files.subtitles.download.label'), t('files.subtitles.download.hint'))}
                {draft.downloadSubtitles && <>
                  <Field><FieldLabel htmlFor="subtitle-languages">{t('files.subtitles.languages')}</FieldLabel><Input id="subtitle-languages" value={draft.subtitleLanguages} placeholder={t('files.subtitles.languagesPlaceholder')} onChange={event => patch({ subtitleLanguages: event.target.value })} /><FieldDescription>{t('files.subtitles.languagesHint')}</FieldDescription></Field>
                  {toggle('subtitleAutoGenerated', t('files.subtitles.autoGenerated.label'), t('files.subtitles.autoGenerated.hint'))}
                  <FieldDescription>{t('files.subtitles.hint')}</FieldDescription>
                </>}
              </SettingsSection>
              <SettingsSection title={t('advanced.output')}>
                {toggle('embedMetadata', t('files.metadata.label'))}
                {toggle('embedChapters', t('files.chapters.label'))}
              </SettingsSection>
              <SettingsSection title={t('advanced.files')}>
                {toggle('organizeByPlatform', t('files.organizeByPlatform.label'), t('files.organizeByPlatform.hint'))}
                {toggle('organizeByChannel', t('files.organizeByChannel.label'))}
              </SettingsSection>
            </FieldGroup></TabsContent>
            <TabsContent value="subscriptions"><FieldGroup>
              {toggle('subscriptionAutomatic', subscriptionsText('automatic'), subscriptionsText('automaticHint'))}
              {draft.subscriptionAutomatic && number('subscriptionIntervalHours', subscriptionsText('interval'), 1, 720, t('subscriptions.intervalHint'))}
              {toggle('subscriptionNotifications', subscriptionsText('systemNotifications'), subscriptionsText('systemNotificationsHint'))}
            </FieldGroup></TabsContent>
            <TabsContent value="browser"><FieldGroup>
              <FieldDescription>{state.browser.sites ? t('browser.sessions', { count: state.browser.sites }) : t('browser.noSessions')}</FieldDescription>
              <Button type="button" variant="outline" className="self-start" onClick={() => void send('browser:login', { url: '' })}>{t('common:openLogin')}</Button>
              <SettingsSection title={t('advanced.accounts')}><Button type="button" variant="outline" className="self-start" disabled={!state.browser.sites} onClick={() => void send('browser:clear', null)}>{t('browser.clearSessions')}</Button></SettingsSection>
            </FieldGroup></TabsContent>
            <TabsContent value="tools"><FieldGroup>
              <ItemGroup className="gap-0 rounded-lg border">
                <div role="region" aria-labelledby="kernel-version-title">
                  <Item className="rounded-none border-0"><ItemContent><ItemTitle id="kernel-version-title">{t('tools.kernel')}</ItemTitle><ItemDescription>{state.kernel?.version || state.tools.engine.version || '—'}</ItemDescription></ItemContent><ItemActions><Button type="button" variant="outline" disabled={kernelBusy} onClick={() => {
                    setKernelChecking(true); void send('kernel:check', null).finally(() => setKernelChecking(false))
                  }}>{kernelBusy && <Spinner data-icon="inline-start" aria-hidden="true" />}{t(kernelBusy ? 'tools.kernelChecking' : 'tools.checkUpdate')}</Button></ItemActions></Item>
                  {(kernelBusy || state.kernel?.error) && <div className="px-3 pb-3" role="status">{state.kernel?.error ? <p className="text-sm text-destructive">{state.kernel.error}</p> : state.kernel?.status === 'downloading' ? <TransferProgress label={t('tools.kernelDownloading')} value={state.kernel.progress === undefined ? null : state.kernel.progress * 100} showTransfer={false} /> : <p className="text-sm text-muted-foreground">{t('tools.kernelChecking')}</p>}</div>}
                </div>
                <ItemSeparator className="my-0" />
                <AppUpdate state={state} send={send} />
              </ItemGroup>
              {toggle('kernelAutoUpdate', t('tools.kernelAutomatic'), t('tools.kernelAutomaticHint'))}
              {toggle('allowControl', t('tools.allowControl.label'), t('tools.allowControl.hint'))}
              <FieldDescription>{cliMessage}</FieldDescription>
              {state.settings.allowControl && !cli.configuring && (!cliReady || cli.error) && <Button type="button" variant="outline" className="self-start" disabled={!draft.allowControl} onClick={() => void send('cli:install', null)}>{t('tools.commandLine.retry')}</Button>}
              <SettingsSection title={t('advanced.diagnostics')}>
                {toggle('verboseLogging', t('tools.verboseLogging.label'), t('tools.verboseLogging.hint'))}
                <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => void send('logs:open', null)}>{t('tools.openLogs')}</Button><Button type="button" variant="outline" onClick={() => void send('logs:export', null)}>{t('tools.exportLogs')}</Button></div>
              </SettingsSection>
            </FieldGroup></TabsContent>
          </Tabs>
        </FieldSet>
      </CardContent>
    </Card>
  </form>
}
