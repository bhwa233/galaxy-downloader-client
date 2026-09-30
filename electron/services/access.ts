// Why a platform would not hand something over. These are four different situations with four
// different answers, and reporting all of them as "解析失败" tells the user nothing they can act on:
// signing in fixes the first, buying or subscribing fixes the next two, and nothing fixes the last.
//
// The client never works around any of them. It does not buy, unlock, impersonate a member or borrow
// an account; the only thing it can do is say which wall it hit.
import type { AccessWall } from '../../shared/contracts'

// Read off the engine's and the platforms' own wording. Everything here is a refusal that names its
// own reason - a generic failure is deliberately not matched, because guessing at a category is the
// thing this exists to stop.
const WALLS: { kind: AccessWall; pattern: RegExp; message: string }[] = [
  // Platform encryption. The account can be entitled and the stream is still unusable: YouTube's
  // rented and purchased films are Widevine, and no key ever reaches this client. Checked first,
  // because a paid film matches the purchase wording too and this is the more specific answer.
  {
    kind: 'encrypted', pattern: /drm|widevine|playready|fairplay|受保护的内容|加密内容/i,
    message: '这是平台加密（DRM）的内容，即使账户有权限也取不到可用的媒体流。客户端不解密，也无法下载。',
  },
  // A membership or subscription tier: the content exists for members of this channel or this plan.
  {
    kind: 'membership', pattern: /members[- ]only|join this channel|channel's members|大会员|会员专享|仅.{0,4}会员|premium.{0,20}(only|required)|subscriber[- ]only/i,
    message: '这是会员专享内容。用有权限的账户在应用内浏览器登录后重试；账户本身没有会员资格时无法下载。',
  },
  // A one-off purchase: an episode, a course, a rental. Distinct from membership because paying for a
  // subscription does not unlock it and vice versa.
  {
    kind: 'purchase', pattern: /requires payment|paid (video|content|episode)|purchase|rent(al|ed)?\b|付费(解锁|内容|章节|集)?|需要购买|购买后观看|试看/i,
    message: '这是需要单独购买的内容。用已经购买过的账户在应用内浏览器登录后重试；没有购买就取不到。',
  },
]

// The wall a failure ran into, where it named one. 'undefined' means the message said nothing about
// permissions, which is its own answer: it is reported as the failure it is.
export function accessWall(message: string): { kind: AccessWall; message: string } | undefined {
  const found = WALLS.find(wall => wall.pattern.test(message))
  return found ? { kind: found.kind, message: found.message } : undefined
}

// Raised in place of the engine's own wording once the wall is known, so every layer above this sees
// one sentence that says which wall it is and what the user can do about it.
export class AccessDenied extends Error {
  constructor(readonly wall: AccessWall, message: string, readonly detail: string) { super(message) }
}

// A refusal, turned into the sentence the window shows. Anything that did not name a wall is handed
// back untouched: dressing an unknown failure up as a permission problem is the same lie in reverse.
export function asAccessDenied(error: unknown): AccessDenied | undefined {
  const text = error instanceof Error ? error.message : String(error)
  const wall = accessWall(text)
  return wall ? new AccessDenied(wall.kind, wall.message, text) : undefined
}
