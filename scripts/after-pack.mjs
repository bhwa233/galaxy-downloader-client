import { rm } from 'node:fs/promises'
import path from 'node:path'

export default async function afterPack({ appOutDir }) {
  // A custom electronDist copies Chromium's log outside the application file filters.
  await rm(path.join(appOutDir, 'debug.log'), { force: true })
}
