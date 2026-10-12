import type { AccessWall, ListingKind, MediaStats, Settings } from '../../../shared/contracts'
// A creator profile is a listing every platform paginates its own way, so each one contributes an
// adapter and the browser keeps the crawling generic.
// 'media' is the file itself, set only by a post adapter: one entry per picture or clip of a post the
// engine cannot read, downloaded as it is rather than handed to the engine by the post's address.
// 'whole' marks an entry that is itself a collection - a 短剧 in the 短剧 catalogue - at 'url': picking
// it queues every item of that collection, walked when the download is asked for.
export type ListingEntry = MediaStats & { id: string; url: string; title: string; thumbnail?: string; duration?: number; kind: 'video' | 'audio' | 'image'; media?: string; whole?: boolean; wall?: AccessWall }
export type Pagination = { index: number; size: number; total?: number; hasMore: boolean }
// One tab of a listing, with its own pages: a 哔哩哔哩 video that is multi-part and also belongs to a
// collection offers both, and the collection has pages while the parts arrive in one reply.
// 'directory' is the name this group's downloads are filed under, which only a collection has.
export type ListingGroup = { id: string; title?: string; directory?: string; entries: ListingEntry[]; pagination: Pagination }
// 'post' is one work's files rather than a list of works - see ProfileAdapter.post.
export type ListingPage = { title?: string; kind?: ListingKind | 'post'; groups: ListingGroup[] }
// Most adapters serve one group; this is the shape they all had before a second one was possible.
export function onePage(id: string, title: string | undefined, entries: ListingEntry[], pagination: Pagination): ListingPage {
  return { title, groups: [{ id, title, entries, pagination }] }
}
// A listing API is usually a GET, but YouTube's continuation endpoint takes its token in a POST body.
export type Fetcher = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; referrer?: string; signal?: AbortSignal }) => Promise<Response>
// What a real graphics stack on this machine reports. 哔哩哔哩 reads these off the listing request and
// refuses one that cannot produce them, so they are taken from a page in the client's own partition
// rather than invented: the site already fingerprinted the same values when the client warmed up.
export type Fingerprint = { glVersion: string; glRenderer: string; glVendor: string; width: number; height: number }
// A platform that asks the client to name its language wants the same answer the session's
// Accept-Language gives, so the locale travels with the request instead of being defaulted per adapter.
// Whatever the site's own pages left in localStorage for this origin, read during the warm-up visit.
// A platform that keeps something the client is about to need - 哔哩哔哩 keeps the day's signing keys
// there - has already handed it over, and asking the network again would be a request for nothing.
// Reads a value out of the open page. Some platforms keep what a request to them needs in the page
// rather than in storage - X puts its CSRF token in a cookie the page can read and its GraphQL
// operation ids in its own script bundle - and there is no way to ask for it from out here.
// Deliberately read-only in spirit: this is for finding out what the page already knows, not for
// driving it. Scrolling a listing is still the thing this client does not do.
export type Evaluate = <T>(expression: string) => Promise<T>
// A reply is only this adapter's to read when the field it expects is an object. A string or an array
// where a record should be is the endpoint having moved, not the platform refusing, and the two get
// opposite answers: one stands down, the other is reported.
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
// 'group' names which tab the page number belongs to; the others keep whatever page they were on.
export type PageRequest = { url: URL; page: number; group?: string; fetch: Fetcher; evaluate?: Evaluate; userAgent: string; locale: Settings['locale']; fingerprint?: Fingerprint; storage?: Record<string, string>; signal: AbortSignal }

export interface ProfileAdapter {
  readonly id: string
  matches(url: URL): boolean
  // Where the listing actually lives: a bare space URL lands on a feed that renders too late to read.
  entryUrl(url: URL): string
  // The only route: the platform's own listing API, called from inside a page of its site. An adapter
  // without one cannot be served at all, which is the honest answer - there is no grid-walking behind
  // this, because scrolling a listing is the behaviour the platforms watch for.
  //
  // 'undefined' is the adapter standing down: it claimed the address, read it, and found nothing of its
  // own to list - a 哔哩哔哩 video page that is neither multi-part nor part of a collection is one video
  // and belongs to the engine. Matching on the URL alone cannot tell the two apart, so the answer has
  // to come after the read, and the caller falls back to the ordinary route.
  fetchPage?(request: PageRequest): Promise<ListingPage | undefined>
  // Reads one post's files rather than a list of posts: an X picture post, an Instagram carousel -
  // what the engine has no extractor for. Such an adapter also runs when a queued job re-resolves its
  // post, which is exactly when a listing entry pointing at such a post needs it. It answers with
  // kind 'post' and an entry per file, each carrying 'media'.
  readonly post?: boolean
}
