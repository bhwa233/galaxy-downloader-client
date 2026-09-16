import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const windows = process.platform === 'win32'
const python = path.join(root, '.venv', windows ? 'Scripts/python.exe' : 'bin/python')
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}
const hasUv = spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0
if (hasUv) {
  if (!existsSync(python) || !existsSync(path.join(root, '.venv', 'pyvenv.cfg'))) run('uv', ['venv', '--python', '3.12', '.venv'])
  run('uv', ['pip', 'install', '--python', python, '-r', 'engine/requirements.txt'])
} else {
  if (!existsSync(python)) run(windows ? 'python' : 'python3', ['-m', 'venv', '.venv'])
  run(python, ['-m', 'pip', 'install', '-r', 'engine/requirements.txt'])
}
if (process.argv.includes('--bundle')) {
  run(python, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile', '--name', 'media-engine', '--collect-all', 'yt_dlp', '--collect-all', 'yt_dlp_ejs', '--distpath', 'resources/engine', '--workpath', 'engine-build/work', '--specpath', 'engine-build', 'engine/main.py'])
  mkdirSync(path.join(root, 'resources/engine'), { recursive: true })
  const ffmpeg = path.join(root, 'node_modules/ffmpeg-static', windows ? 'ffmpeg.exe' : 'ffmpeg')
  copyFileSync(ffmpeg, path.join(root, 'resources/engine', windows ? 'ffmpeg.exe' : 'ffmpeg'))
}
