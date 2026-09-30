import type { AccessWall } from '../../../shared/contracts'
import { i18n } from '../../../shared/i18n'

// What each permission wall is called on screen. Four separate headings because they are four separate
// situations: the first is fixed by signing in, the middle two by an account that is entitled, and the
// last by nothing at all. A single "解析失败" for all four is the thing these exist to replace.
export const wallTitle = (wall: AccessWall): string => i18n.t(`walls.${wall}`)

// Whether signing in could change the answer. It cannot for platform encryption, and offering a window
// that changes nothing is worse than saying plainly that there is nothing to be done.
export const fixableBySignIn = (wall: AccessWall | undefined) => Boolean(wall) && wall !== 'encrypted'
