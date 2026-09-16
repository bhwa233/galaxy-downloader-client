// Real creator pages, kept here so the live probe always runs against the same four accounts.
// Public profiles only — no private or purchased content, and no account credentials.
export type ProfileFixture = {
  platform: string
  url: string
  // 'chrome' goes through ChromeConnection.inspectProfile (parser.isProfileUrl is true);
  // 'engine' goes through yt-dlp, which returns the channel as a playlist.
  route: 'chrome' | 'engine'
  // Whether the route normally needs the user to already be signed in inside Chrome.
  needsSignIn: boolean
  note?: string
}

export const PROFILE_FIXTURES: ProfileFixture[] = [
  {
    platform: '抖音',
    url: 'https://www.douyin.com/user/MS4wLjABAAAALBQu0odP0MyyGWgDpnvBTsSLhorbHcYxES8uubAVDEitEw3liy-Ytsk6tr_JKgN9',
    route: 'chrome',
    needsSignIn: true,
    note: 'Covers come from the /aweme/v1/web/aweme/post/ responses; the DOM fallback often has none.',
  },
  {
    platform: '小红书',
    url: 'https://www.xiaohongshu.com/user/profile/6a2174510000000002002401',
    route: 'chrome',
    needsSignIn: true,
  },
  {
    platform: 'Bilibili',
    url: 'https://space.bilibili.com/242020511',
    route: 'chrome',
    needsSignIn: false,
  },
  {
    platform: 'YouTube',
    url: 'https://www.youtube.com/@Fatcat996',
    route: 'engine',
    needsSignIn: false,
    note: 'Not a parser profile URL: yt-dlp extracts the channel as a playlist, capped at playlistend 100.',
  },
]
