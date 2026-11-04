import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { i18n } from '../../shared/i18n'
import { logger } from './log'

const run = promisify(execFile)
// Every launcher this client writes carries this line, so it only ever removes or rewrites its own.
const MARK = 'Galaxy Downloader command line'
const log = logger('command-line')

export type CommandLineState = { installed: boolean; launcher: string; onPath: boolean; configuring?: boolean; error?: string }

// Installs the `galaxy` command: the command line bundle copied out of the app, and a launcher that
// runs it with the client's own binary as Node. Copied rather than pointed at, because an AppImage is
// mounted somewhere new on every start and its insides have no stable path; the AppImage file itself
// does. The launcher is written again on every start once installed, so an update or a moved app
// never leaves it pointing at something that is gone.
//
// Checked for a library that puts a command on the PATH: there is none for an Electron app - VS Code
// and others each do it by hand, per platform - so it is written here, for the two cases this client
// ships: a per-user directory added to the user's PATH on Windows, ~/.local/bin with a managed
// shell-profile entry elsewhere. Only the marked entry is removed when the user disables it.
export class CommandLine {
  private desired = false
  private task?: Promise<void>
  private configuring = false
  private error?: string
  private registered?: boolean
  constructor(private userData: string, private appPath: string, private packaged: boolean, private changed: () => void = () => {}) {}

  private get windows() { return process.platform === 'win32' }
  private get directory() { return this.windows ? path.join(this.userData, 'bin') : path.join(os.homedir(), '.local', 'bin') }
  private get launcher() { return path.join(this.directory, this.windows ? 'galaxy.cmd' : 'galaxy') }
  private get script() { return path.join(this.userData, 'cli', 'galaxy.mjs') }
  // An AppImage names itself in APPIMAGE; the binary inside it is not a path that lasts.
  private get executable() { return process.env.APPIMAGE || process.execPath }

  state(): CommandLineState {
    let installed = false
    try { installed = existsSync(this.launcher) && readFileSync(this.launcher, 'utf8').includes(MARK) } catch { /* Configuration reports inaccessible paths. */ }
    const inherited = (process.env.PATH || '').split(path.delimiter).some(entry => this.windows ? path.resolve(entry).toLowerCase() === this.directory.toLowerCase() : path.resolve(entry) === this.directory)
    return { installed, launcher: this.launcher, onPath: this.registered ?? inherited, configuring: this.configuring, error: this.error }
  }

  // Serialize registration, and finish at the latest saved preference if it changes mid-install.
  // Startup does not wait for shell integration; configuration failures remain retryable in Settings.
  configure(enabled: boolean): Promise<void> {
    this.desired = enabled
    if (this.task) return this.task
    this.configuring = true; this.error = undefined; this.changed()
    this.task = (async () => {
      let target: boolean
      do {
        target = this.desired; this.error = undefined
        try { if (target) await this.install(); else await this.uninstall() }
        catch (error) { log.warn('Command registration failed', error); this.error = i18n.t('settings:tools.commandLine.failed') }
      } while (target !== this.desired)
    })().finally(() => { this.configuring = false; this.task = undefined; this.changed() })
    return this.task
  }

  async install(): Promise<CommandLineState> {
    const bundle = path.join(this.appPath, 'dist-electron', 'cli', 'galaxy.mjs')
    if (!existsSync(bundle)) throw new Error(i18n.t('desktop:errors.cliMissing', { path: bundle }))
    if (existsSync(this.launcher) && !readFileSync(this.launcher, 'utf8').includes(MARK)) throw new Error(i18n.t('desktop:errors.cliForeign', { path: this.launcher }))
    mkdirSync(path.dirname(this.script), { recursive: true })
    copyFileSync(bundle, this.script)
    mkdirSync(this.directory, { recursive: true })
    writeFileSync(this.launcher, this.windows ? this.cmd() : this.sh(), { mode: 0o755 })
    await this.userPath('add')
    return this.state()
  }

  async uninstall(): Promise<CommandLineState> {
    if (existsSync(this.launcher) && !this.state().installed) throw new Error(i18n.t('desktop:errors.cliForeign', { path: this.launcher }))
    rmSync(this.launcher, { force: true })
    rmSync(this.script, { force: true })
    await this.userPath('remove')
    return this.state()
  }

  // A development build only answers its own development launcher, and cannot start itself: the
  // binary alone is not the app. An installed client can, so its launcher says where it is.
  private cmd(): string {
    return [
      '@echo off', `rem ${MARK}. Written by the app; install it again from Settings if the app moves.`,
      'setlocal',
      this.packaged ? `set "GALAXY_APP=${this.executable}"` : 'set "GALAXY_DEV=1"',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `"${this.executable}" "${this.script}" %*`, '',
    ].join('\r\n')
  }

  private sh(): string {
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
    const env = this.packaged ? `GALAXY_APP=${quote(this.executable)}` : 'GALAXY_DEV=1'
    return [
      '#!/bin/sh', `# ${MARK}. Written by the app; install it again from Settings if the app moves.`,
      `${env} ELECTRON_RUN_AS_NODE=1 exec ${quote(this.executable)} ${quote(this.script)} "$@"`, '',
    ].join('\n')
  }

  // The user's own PATH, through .NET rather than setx, which silently cuts a PATH at 1024 characters.
  // The directory travels in an environment variable so no quoting of it reaches the script.
  private async userPath(change: 'add' | 'remove'): Promise<void> {
    if (!this.windows) {
      const homeDirectory = os.homedir()
      const shell = path.basename(process.env.SHELL || 'sh')
      const profiles = shell === 'zsh' ? [path.join(process.env.ZDOTDIR || homeDirectory, '.zshrc')]
        : shell === 'fish' ? [path.join(process.env.XDG_CONFIG_HOME || path.join(homeDirectory, '.config'), 'fish', 'conf.d', 'galaxy-downloader.fish')]
          : shell === 'bash' ? [path.join(homeDirectory, '.bashrc'), path.join(homeDirectory, existsSync(path.join(homeDirectory, '.bash_profile')) ? '.bash_profile' : '.profile')]
            : [path.join(homeDirectory, '.profile')]
      const start = `# >>> ${MARK} >>>`, end = `# <<< ${MARK} <<<`
      const directory = `'${this.directory.replace(/'/g, `'\\''`)}'`
      const command = shell === 'fish' ? `if not contains -- ${directory} $PATH\n    set -gx PATH ${directory} $PATH\nend`
        : `case ":$PATH:" in *:${directory}:*) ;; *) export PATH=${directory}:"$PATH" ;; esac`
      for (const profile of profiles) {
        const original = existsSync(profile) ? readFileSync(profile, 'utf8') : ''
        let content = original
        const from = content.indexOf(start), to = content.indexOf(end, from)
        if (from >= 0) {
          if (to < 0) throw new Error('Incomplete command-line PATH entry')
          content = content.slice(0, from) + content.slice(to + end.length).replace(/^\r?\n/, '')
        }
        if (change === 'add') content += `${content && !content.endsWith('\n') ? '\n' : ''}${start}\n${command}\n${end}\n`
        if (content !== original) { mkdirSync(path.dirname(profile), { recursive: true }); writeFileSync(profile, content, { mode: 0o600 }) }
      }
      this.registered = change === 'add'
      return
    }
    const script = change === 'add'
      ? "$d=$env:GALAXY_BIN; $p=[Environment]::GetEnvironmentVariable('Path','User'); $parts=@($p -split ';' | Where-Object { $_ }); if ($parts -notcontains $d) { [Environment]::SetEnvironmentVariable('Path', (($parts + $d) -join ';'), 'User') }; Write-Output 'true'"
      : "$d=$env:GALAXY_BIN; $p=[Environment]::GetEnvironmentVariable('Path','User'); $parts=@($p -split ';' | Where-Object { $_ }); if ($parts -contains $d) { [Environment]::SetEnvironmentVariable('Path', (($parts | Where-Object { $_ -ne $d }) -join ';'), 'User') }; Write-Output 'false'"
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; " + script], { env: { ...process.env, GALAXY_BIN: this.directory }, windowsHide: true, timeout: 15_000 })
    this.registered = result.stdout.trim() === 'true'
  }
}
