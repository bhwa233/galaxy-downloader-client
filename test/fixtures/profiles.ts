// Real creator pages, kept here so the live probe always runs against the same four accounts.
// Public profiles only — no private or purchased content, and no account credentials.
export type ProfileFixture = {
  platform: string
  url: string
  // 'browser' goes through EmbeddedBrowser.inspectProfile (parser.isProfileUrl is true);
  // 'engine' goes through yt-dlp, which returns the channel as a playlist.
  route: 'browser' | 'engine'
  // Whether the route normally needs the user to already be signed in inside the embedded browser.
  needsSignIn: boolean
  note?: string
}

export const PROFILE_FIXTURES: ProfileFixture[] = [
  {
    platform: '抖音',
    url: 'https://www.douyin.com/user/MS4wLjABAAAALBQu0odP0MyyGWgDpnvBTsSLhorbHcYxES8uubAVDEitEw3liy-Ytsk6tr_JKgN9',
    route: 'browser',
    needsSignIn: true,
    note: 'The security SDK replaces the page window.fetch, so the call is signed on its way out and a_bogus never has to be reproduced. A signed-out visitor is served page 1 and refused the rest.',
  },
  // 小红书 is deliberately absent: its profile listing is switched off and refused in parser.ts.
  {
    platform: 'Bilibili',
    url: 'https://space.bilibili.com/242020511',
    route: 'browser',
    needsSignIn: false,
  },
  {
    platform: 'YouTube',
    url: 'https://www.youtube.com/@Fatcat996',
    route: 'browser',
    needsSignIn: false,
    note: 'The adapter reads ytInitialData from the /videos tab and walks continuation tokens for later pages.',
  },
]
