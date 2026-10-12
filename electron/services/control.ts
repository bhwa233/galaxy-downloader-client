import net from 'node:net'
import { chmodSync, rmSync } from 'node:fs'
import { MAX_LINE, type ControlReply, type ControlRequest } from '../../shared/control'
import { logger } from './log'

const log = logger('control')

// Checked net (Unix socket and Windows named pipe behind one API) against JSON-RPC libraries such as
// vscode-jsonrpc: the protocol here is one request line and one reply line, which those would wrap
// in framing, cancellation and notification machinery nothing uses. Hand-written, limited to reading
// lines, handing each to the controller and writing its reply back.
export class ControlServer {
  private server?: net.Server
  constructor(private handle: (command: string, input: unknown) => Promise<Omit<ControlReply, 'id'>>) {}

  get listening(): boolean { return Boolean(this.server?.listening) }

  async start(address: string): Promise<void> {
    if (this.server) return
    // A socket file left behind by a client that did not shut down cleanly refuses the new listener.
    // It is removed only once nothing answers on it, so a second running client is never displaced.
    if (process.platform !== 'win32' && await answers(address) === false) rmSync(address, { force: true })
    const server = net.createServer(socket => this.serve(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(address, () => { server.off('error', reject); resolve() })
    }).catch(error => { log.warn(`命令行通道未能监听 ${address}`, error); throw error })
    if (process.platform !== 'win32') chmodSync(address, 0o600)
    server.on('error', error => log.warn('命令行通道出错', error))
    this.server = server
    log.info(`命令行通道已监听 ${address}`)
  }

  stop(): void {
    this.server?.close()
    this.server = undefined
  }

  private serve(socket: net.Socket): void {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      if (buffer.length > MAX_LINE && !buffer.includes('\n')) { socket.destroy(); return }
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        if (line.trim()) void this.answer(socket, line)
      }
    })
    socket.on('error', () => socket.destroy())
  }

  private async answer(socket: net.Socket, line: string): Promise<void> {
    let request: ControlRequest
    try { request = JSON.parse(line) as ControlRequest } catch { socket.write(`${JSON.stringify({ id: 0, ok: false, message: 'Malformed request' })}\n`); return }
    const reply = await this.handle(String(request.command), request.input).catch(error => ({ ok: false, message: error instanceof Error ? error.message : String(error) }))
    if (!socket.destroyed) socket.write(`${JSON.stringify({ ...reply, id: request.id })}\n`)
  }
}

// Whether something is listening at the address: true, false, or undefined where it cannot be told.
function answers(address: string): Promise<boolean | undefined> {
  return new Promise(resolve => {
    const probe = net.connect(address)
    probe.once('connect', () => { probe.destroy(); resolve(true) })
    probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ECONNREFUSED' ? false : undefined))
  })
}
