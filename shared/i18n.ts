import i18next, { type i18n as I18n } from 'i18next'
import zhCommon from './locales/zh/common.json'
import zhApp from './locales/zh/app.json'
import zhTasks from './locales/zh/tasks.json'
import zhResult from './locales/zh/result.json'
import zhSettings from './locales/zh/settings.json'
import zhHistory from './locales/zh/history.json'
import zhErrors from './locales/zh/errors.json'
import zhQueue from './locales/zh/queue.json'
import zhDesktop from './locales/zh/desktop.json'
import enCommon from './locales/en/common.json'
import enApp from './locales/en/app.json'
import enTasks from './locales/en/tasks.json'
import enResult from './locales/en/result.json'
import enSettings from './locales/en/settings.json'
import enHistory from './locales/en/history.json'
import enErrors from './locales/en/errors.json'
import enQueue from './locales/en/queue.json'
import enDesktop from './locales/en/desktop.json'

// One i18next instance for both processes: the window's text and what the main process says to the
// user - errors, a task's activity log, notifications, the tray - come from the same dictionaries.
// Everything else imports this module rather than i18next itself.
//
// A namespace per area, so the window and the main process each own theirs: common, app, tasks,
// result, settings and history are the window's; errors, queue and desktop the main process's.
// Diagnostics written to the log file stay as they are - they are for whoever reads the log.
const zh = { common: zhCommon, app: zhApp, tasks: zhTasks, result: zhResult, settings: zhSettings, history: zhHistory, errors: zhErrors, queue: zhQueue, desktop: zhDesktop }
// Typed against the Chinese dictionaries, so an English one missing a key fails the typecheck.
// English may carry more keys than Chinese: its plurals take '_one' beside '_other'.
const en: typeof zh = { common: enCommon, app: enApp, tasks: enTasks, result: enResult, settings: enSettings, history: enHistory, errors: enErrors, queue: enQueue, desktop: enDesktop }

declare module 'i18next' {
  interface CustomTypeOptions { defaultNS: 'common'; resources: typeof zh }
}

export const locales = ['zh', 'en'] as const
export type Locale = typeof locales[number]
// The language a first start takes from the system: Chinese for any Chinese variant, else English.
export const localeFor = (tag: string): Locale => /^zh/i.test(tag) ? 'zh' : 'en'

export const i18n: I18n = i18next.createInstance()
void i18n.init({
  resources: { zh, en }, lng: 'zh', fallbackLng: 'zh', defaultNS: 'common', ns: Object.keys(zh),
  // React escapes on its own, and the main process never writes into HTML.
  interpolation: { escapeValue: false }, initAsync: false,
})
export function setLocale(locale: Locale): void { if (i18n.language !== locale) void i18n.changeLanguage(locale) }
