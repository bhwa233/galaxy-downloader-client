import { expect, test } from 'vitest'
import { accessWall, asAccessDenied } from '../electron/services/access'

// Wordings taken from what the engine and the platforms actually say. The point of the classifier is
// that these four get four different answers instead of one "解析失败".
test('a refusal is reported as the wall it actually is', () => {
  expect(accessWall("This video is available to this channel's members on level: 铁粉. Join this channel to get access to members-only content.")?.kind).toBe('membership')
  expect(accessWall('该视频为大会员专享，请开通大会员后观看')?.kind).toBe('membership')
  expect(accessWall('This video requires payment to watch')?.kind).toBe('purchase')
  expect(accessWall('第 12 集为付费内容，需要购买后观看')?.kind).toBe('purchase')
  // Encryption is checked first: a rented film matches the purchase wording too, and the key never
  // arrives either way, so the more specific and more final answer is the right one.
  expect(accessWall('This video is DRM protected. Purchase or rent it to watch.')?.kind).toBe('encrypted')
  expect(accessWall('Widevine protected stream')?.kind).toBe('encrypted')
})

test('a failure that named no wall is left alone rather than guessed at', () => {
  // Guessing a category for an ordinary failure is the same lie as flattening every failure into one.
  for (const message of ['HTTP Error 500', 'Unable to extract player response', '连接超时，请重试', '哔哩哔哩接口返回 -352：风控校验失败']) {
    expect(accessWall(message)).toBeUndefined()
    expect(asAccessDenied(new Error(message))).toBeUndefined()
  }
})

test('the sentence a wall is reported with says what the user can do, and never offers a way around', () => {
  const members = asAccessDenied(new Error('Join this channel to get access to members-only content'))!
  expect(members.wall).toBe('membership')
  expect(members.message).toContain('登录')
  // The engine's own wording is kept for the log rather than thrown away.
  expect(members.detail).toContain('members-only')
  const drm = asAccessDenied(new Error('This video is DRM protected'))!
  // Nothing about signing in: no account lifts platform encryption, and saying otherwise sends the
  // user to a login window that cannot help them.
  expect(drm.message).not.toContain('登录')
  expect(drm.message).toContain('加密')
})
