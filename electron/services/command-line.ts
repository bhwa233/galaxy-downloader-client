import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { i18n } from '../../shared/i18n'

const run = promisify(execFile)
// Every launcher this client writes carries this line, so it only ever removes or rewrites its own.
const MARK = 'Galaxy Downloader command line'

export type CommandLineState = { installed: boolean; launcher: string; onPath: boolean }

// Installs the `galaxy` command: the command line bundle copied out of the app, and a launcher that
// runs it with the client's own binary as Node. Copied rather than pointed at, because an AppImage is
// mounted somewhere new on every start and its insides have no stable path; the AppImage file itself
// does. The launcher is written again on every start once installed, so an update or a moved app
// never leaves it pointing at something that is gone.
//
// Checked for a library that puts a command on the PATH: there is none for an Electron app - VS Code
// and others each do it by hand, per platform - so it is written here, for the two cases this client
// ships: a per-user directory added to the user's PATH on Windows, ~/.local/bin elsewhere.
export class CommandLine {
  constructor(private userData: string, private appPath: string, private packaged: boolean) {}

  private get windows() { return process.platform === 'win32' }
  private get directory() { return this.windows ? path.join(this.userData, 'bin') : path.join(os.homedir(), '.local', 'bin') }
  private get launcher() { return path.join(this.directory, this.windows ? 'galaxy.cmd' : 'galaxy') }
  private get script() { return path.join(this.userData, 'cli', 'galaxy.mjs') }
  // An AppImage names itself in APPIMAGE; the binary inside it is not a path that lasts.
  private get executable() { return process.env.APPIMAGE || process.execPath }

  state(): CommandLineState {
    const installed = existsSync(this.launcher) && readFileSync(this.launcher, 'utf8').includes(MARK)
    const onPath = (process.env.PATH || '').split(path.delimiter).some(entry => path.resolve(entry) === this.directory)
    return { installed, launcher: this.launcher, onPath }
  }

  async install(): Promise<CommandLineState> {
    const bundle = path.join(this.appPath, 'dist-electron', 'cli', 'galaxy.mjs')
    if (!existsSync(bundle)) throw new Error(i18n.t('desktop:errors.cliMissing', { path: bundle }))
    if (existsSync(this.launcher) && !readFileSync(this.launcher, 'utf8').includes(MARK)) throw new Error(i18n.t('desktop:errors.cliForeign', { path: this.launcher }))
    mkdirSync(path.dirname(this.script), { recursive: true })
    copyFileSync(bundle, this.script)
    mkdirSync(this.directory, { recursive: true })
    writeFileSync(this.launcher, this.windows ? this.cmd() : this.sh(), { mode: 0o755 })
    if (this.windows) await this.userPath('add')
    return this.state()
  }

  async uninstall(): Promise<CommandLineState> {
    if (this.state().installed) rmSync(this.launcher, { force: true })
    rmSync(path.dirname(this.script), { recursive: true, force: true })
    if (this.windows) await this.userPath('remove')
    return this.state()
  }

  // Once installed, kept pointing at this copy of the client.
  async refresh(): Promise<void> { if (this.state().installed) await this.install() }

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
    const script = change === 'add'
      ? "$d=$env:GALAXY_BIN; $p=[Environment]::GetEnvironmentVariable('Path','User'); $parts=@($p -split ';' | Where-Object { $_ }); if ($parts -notcontains $d) { [Environment]::SetEnvironmentVariable('Path', (($parts + $d) -join ';'), 'User') }"
      : "$d=$env:GALAXY_BIN; $p=[Environment]::GetEnvironmentVariable('Path','User'); $parts=@($p -split ';' | Where-Object { $_ -and $_ -ne $d }); [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')"
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, GALAXY_BIN: this.directory }, windowsHide: true })
  }
}
