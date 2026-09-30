import { open, rm } from 'node:fs/promises'

// A cover that downloaded is not yet a cover. A platform with nothing to show still answers with an
// image: 哔哩哔哩 gives a video without a cover 'bfs/archive/transparent.png', a 1x1 transparent PNG
// of 123 bytes served as image/png (measured 2026-09-24 on BV1xx411c7mD). Neither the status nor the
// type gives it away, only the picture itself does, so a file that is not an image or is a single
// pixel is removed rather than saved as that item's cover. Read from the header rather than decoded:
// Electron's nativeImage takes PNG and JPEG only, and YouTube's covers are WebP.
export async function checkCover(file: string): Promise<string> {
  const handle = await open(file)
  const head = Buffer.alloc(32)
  try { await handle.read(head, 0, 32, 0) } finally { await handle.close() }
  const ascii = (start: number, end: number) => head.toString('latin1', start, end)
  const png = ascii(1, 4) === 'PNG'
  const gif = ascii(0, 3) === 'GIF'
  const image = png || gif || (head[0] === 0xff && head[1] === 0xd8) || (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP')
    || ascii(4, 8) === 'ftyp' || ascii(0, 2) === 'BM'
  // The two formats a placeholder pixel comes in, and the two that state their size up front.
  const pixel = png ? head.readUInt32BE(16) <= 1 && head.readUInt32BE(20) <= 1 : gif ? head.readUInt16LE(6) <= 1 && head.readUInt16LE(8) <= 1 : false
  if (image && !pixel) return file
  await rm(file, { force: true })
  throw new Error(image ? '平台没有提供封面，只返回了一张占位图' : '封面地址返回的不是图片')
}
