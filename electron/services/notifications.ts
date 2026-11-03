import { app, Notification, type NotificationConstructorOptions } from 'electron'
import build from '../../electron-builder.json'
import { i18n } from '../../shared/i18n'
import type { ClientState } from '../../shared/contracts'
import { redact } from './engine'
import { logger } from './log'

const log = logger('notifications')

export function configureNativeNotifications(): void {
  if (process.platform !== 'win32') return
  // Electron registers the native toast activator and Start Menu properties. Keep the app identity
  // stable across upgrades, and give development its own identity to separate it from the installed app.
  app.setAppUserModelId(app.isPackaged ? build.appId : build.appId + '.development')
  app.setToastActivatorCLSID(app.isPackaged ? '{3B1F78DB-84A2-4558-A65D-D7B5C9664724}' : '{CC693110-136A-4A96-9A99-FDC40F34B3F6}')
}

// Reuse Electron's native Notification API for downloads, subscriptions and the settings probe.
// Keep instances alive for OS activation; report failure instead of silently dropping an alert.
export class NativeNotifications {
  private current: NonNullable<ClientState['nativeNotifications']> = { supported: false }
  private active = new Map<Notification, () => void>()
  private stopped = false
  constructor(private changed: () => void) {}
  state(): NonNullable<ClientState['nativeNotifications']> { return { ...this.current } }
  refresh(): boolean {
    const supported = Notification.isSupported()
    this.current = { ...this.current, supported, error: supported ? this.current.error : i18n.t('desktop:notifications.unavailable') }
    this.changed()
    return supported
  }
  async show(options: NotificationConstructorOptions, click?: () => void): Promise<void> {
    if (this.stopped) return
    if (!this.refresh()) {
      log.warn(this.current.error)
      throw new Error(this.current.error)
    }
    return await new Promise<void>((resolve, reject) => {
      let settled = false
      let notification: Notification | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const fail = (error: unknown) => {
        clearTimeout(timer)
        if (notification) this.active.delete(notification)
        const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 1500)
        if (!this.stopped) {
          this.current.error = message
          log.warn('Native notification failed', message)
          this.changed()
        }
        if (!settled) { settled = true; reject(new Error(message)) }
      }
      try {
        notification = new Notification(options)
        const held = notification
        this.active.set(held, () => { fail(i18n.t('desktop:notifications.closed')); held.close() })
        held.once('show', () => {
          clearTimeout(timer)
          this.current = { supported: true, lastShownAt: Date.now() }
          this.changed()
          if (!settled) { settled = true; resolve() }
        })
        held.on('failed', (_event, error) => fail(error || i18n.t('desktop:notifications.failed')))
        held.once('close', () => {
          this.active.delete(held)
          if (!settled) fail(i18n.t('desktop:notifications.closed'))
        })
        held.once('click', () => {
          this.active.delete(held)
          if (!this.stopped) click?.()
        })
        timer = setTimeout(() => {
          fail(i18n.t('desktop:notifications.timeout'))
          held.close()
        }, 15_000)
        held.show()
      } catch (error) { fail(error) }
    })
  }
  stop(): void {
    this.stopped = true
    for (const close of [...this.active.values()]) close()
    this.active.clear()
  }
}
