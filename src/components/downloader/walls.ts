import type { AccessWall } from '../../../shared/contracts'

// What each permission wall is called on screen. Four separate headings because they are four separate
// situations: the first is fixed by signing in, the middle two by an account that is entitled, and the
// last by nothing at all. A single "解析失败" for all four is the thing these exist to replace.
export const wallTitles: Record<AccessWall, string> = {
  login: '需要登录才能继续',
  membership: '需要会员资格',
  purchase: '需要单独购买',
  encrypted: '平台加密，无法下载',
}

// Whether signing in could change the answer. It cannot for platform encryption, and offering a window
// that changes nothing is worse than saying plainly that there is nothing to be done.
export const fixableBySignIn = (wall: AccessWall | undefined) => Boolean(wall) && wall !== 'encrypted'
