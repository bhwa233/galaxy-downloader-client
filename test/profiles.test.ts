import { expect, test } from 'vitest'
import { isProfileUrl } from '../electron/services/parser'
import { normalizeUrl, platformOf } from '../electron/services/media'
import { PROFILE_FIXTURES } from './fixtures/profiles'

// Guards the live fixtures offline: a URL that no longer routes the way it is labelled would make
// the live probe test the wrong code path instead of failing.
test.each(PROFILE_FIXTURES)('$platform fixture routes through $route', fixture => {
  const url = normalizeUrl(fixture.url)
  expect(platformOf(url)).toBe(fixture.platform)
  expect(isProfileUrl(url)).toBe(fixture.route === 'chrome')
})
