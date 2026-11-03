import { useTranslation } from 'react-i18next'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Item, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item'
import { Choice } from './Choice'
import { settingsSchema, type MediaItem, type Settings } from '../../../shared/contracts'
import { mediaFilename } from '../../../shared/filenames'

export function FilenameSettings({ settings, example, patch }: { settings: Settings; example?: MediaItem; patch: (value: Partial<Settings>) => void }) {
  const { t } = useTranslation('settings')
  const sample = example || { id: 'example', title: t('files.cleanNaming.sampleTitle'), author: t('files.cleanNaming.sampleAuthor'), authorId: '12345678', kind: 'video' as const, formats: [], publishedAt: new Date(2026, 10, 3).getTime() / 1000 }
  const custom = settings.filenameTemplate === 'custom'
  const valid = !custom || Boolean(settings.customFilenameTemplate.trim()) && settingsSchema.shape.customFilenameTemplate.safeParse(settings.customFilenameTemplate).success
  const extension = sample.kind === 'image' ? 'jpg' : sample.kind === 'audio' ? 'm4a' : 'mp4'
  const preview = mediaFilename(settings, { ...sample, id: sample.mediaId || sample.id })
  return <FieldSet>
    <FieldLegend>{t('files.naming.label')}</FieldLegend>
    <FieldGroup className="gap-4">
      <Choice label={t('files.cleanNaming.mode')} value={settings.filenameTemplate} options={(['title', 'author-title', 'author-date-title', 'custom'] as const).map(value => ({ value, label: t(`files.cleanNaming.presets.${value}`) }))} onChange={value => patch({ filenameTemplate: value as Settings['filenameTemplate'] })} />
      {custom && <Field data-invalid={!valid}>
        <FieldLabel htmlFor="filename-template">{t('files.cleanNaming.template')}</FieldLabel>
        <Input id="filename-template" required aria-invalid={!valid} value={settings.customFilenameTemplate} onChange={event => patch({ customFilenameTemplate: event.target.value })} maxLength={300} placeholder="{authorId}_{date}_{title}" />
        <div className="flex flex-wrap gap-1.5">{['authorId', 'author', 'date', 'title', 'id', 'channel', 'artist'].map(token => <Button key={token} type="button" variant="outline" size="sm" onClick={() => patch({ customFilenameTemplate: `${settings.customFilenameTemplate}{${token}}` })}>{`{${token}}`}</Button>)}</div>
        <FieldDescription>{valid ? t('files.cleanNaming.templateHint') : t('files.cleanNaming.invalidTemplate')}</FieldDescription>
      </Field>}
      <Item variant="muted">
        <ItemContent>
          <ItemDescription>{t('files.cleanNaming.preview')}{!example ? ` · ${t('files.cleanNaming.example')}` : ''}</ItemDescription>
          <ItemTitle className="break-all whitespace-normal">{preview}.{extension}</ItemTitle>
          <ItemDescription>{t('files.cleanNaming.collision', { filename: `${preview} (2).${extension}` })}</ItemDescription>
          {!sample.authorId && <ItemDescription>{sample.author ? t('files.cleanNaming.nicknameFallback') : t('files.cleanNaming.noAuthor')}</ItemDescription>}
          {(settings.filenameTemplate === 'author-date-title' || custom && settings.customFilenameTemplate.includes('{date}')) && sample.publishedAt === undefined && <ItemDescription>{t('files.cleanNaming.noDate')}</ItemDescription>}
        </ItemContent>
      </Item>
      <FieldDescription>{t('files.cleanNaming.hint')}</FieldDescription>
    </FieldGroup>
  </FieldSet>
}
