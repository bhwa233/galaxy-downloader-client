import { expect, test } from 'vitest'
import { isProfileUrl, refusalFor } from '../electron/services/parser'
import { normalizeUrl, platformOf } from '../electron/services/media'
import { PROFILE_FIXTURES } from './fixtures/profiles'

// Guards the live fixtures offline: a URL that no longer routes the way it is labelled would make
// the live probe test the wrong code path instead of failing.
test.each(PROFILE_FIXTURES)('$platform fixture routes through $route', fixture => {
  const url = normalizeUrl(fixture.url)
  expect(platformOf(url)).toBe(fixture.platform)
  expect(isProfileUrl(url)).toBe(fixture.route === 'browser')
  expect(refusalFor(url)).toBeUndefined()
})

// A switched-off listing is refused where the user can read why, instead of failing later as something
// that looks like a login problem.
test('a xiaohongshu profile is refused, while a single note still parses', () => {
  expect(refusalFor('https://www.xiaohongshu.com/user/profile/6a2174510000000002002401')).toMatch('暂不支持小红书主页解析')
  expect(refusalFor('https://www.xiaohongshu.com/explore/65123abc?xsec_token=x')).toBeUndefined()
  expect(isProfileUrl('https://www.xiaohongshu.com/user/profile/6a2174510000000002002401')).toBe(false)
})
