// Raised when a platform's answer is one it would not have given a visitor it recognised: a listing
// with nothing in it where the posts are, a page served only to someone signed in, a player that will
// not start. The client answers it by offering the login window rather than by reporting a failure
// the user can do nothing about.
//
// It lives on its own because both sides need it and neither may import the other: parser.ts already
// reads the adapters, so an adapter reaching back into the parser for this class would close the loop.
//
// Deliberately narrow. Risk control turning a request away is not this. A sign-in does not reliably
// lift it, and an offer to sign in that changes nothing is worse than an error that says what happened.
export class LoginRequired extends Error {}

// Raised when a platform's risk control answers a listing request with its challenge page instead of
// data. Kept apart from LoginRequired because signing in is not what lifts it: passing the platform's
// own check on its page is. The window offers that page, in the same partition, so a check passed
// there counts for the next request.
export class VerificationRequired extends Error {}
