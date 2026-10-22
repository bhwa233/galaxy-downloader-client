// Adapted from nexmoe/VidBee ce82483 (MIT). See LICENSE in this directory.
import { randomBytes } from 'node:crypto'
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * True when a POSIX path vanished between write and rename.
 *
 * @param error Caught filesystem error.
 */
const isMissingPathError = (error: unknown): boolean =>
  Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code: unknown }).code === 'ENOENT'
  )

/**
 * Worker-cancel error used when the work dir is deleted mid-write.
 *
 * @param dir Missing parent directory.
 */
const cancelledWorkDir = (dir: string): Error => new Error(`cancelled: work dir missing (${dir})`)

/**
 * Per-writer staging path so two processes never share `file.tmp`.
 *
 * @param filePath Final destination.
 */
export const atomicStagingPath = (filePath: string): string =>
  `${filePath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`

/**
 * Move a staging file into place. Another writer may already have published
 * `dest`; that is success, not a missing-file crash.
 *
 * @param tmp Staging file unique to this writer.
 * @param dest Final path.
 */
export const publishAtomicFile = (tmp: string, dest: string): void => {
  const dir = dirname(dest)
  try {
    renameSync(tmp, dest)
  } catch (error) {
    rmSync(tmp, { force: true })
    if (isMissingPathError(error) && existsSync(dest)) {
      return
    }
    if (isMissingPathError(error) && !existsSync(dir)) {
      throw cancelledWorkDir(dir)
    }
    throw error
  }
}

/**
 * Atomically replace a file so concurrent writers never share a `.tmp` name.
 *
 * @param filePath Destination path.
 * @param contents UTF-8 string or bytes.
 */
export const atomicWriteFile = (filePath: string, contents: string | Uint8Array): void => {
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    throw cancelledWorkDir(dir)
  }
  const tmp = atomicStagingPath(filePath)
  try {
    writeFileSync(tmp, contents)
  } catch (error) {
    rmSync(tmp, { force: true })
    if (isMissingPathError(error) && !existsSync(dir)) {
      throw cancelledWorkDir(dir)
    }
    throw error
  }
  publishAtomicFile(tmp, filePath)
}

/**
 * Atomically write JSON.
 *
 * @param filePath Destination path.
 * @param value JSON-serializable value.
 */
export const atomicWriteJson = (filePath: string, value: unknown): void => {
  atomicWriteFile(filePath, JSON.stringify(value))
}
