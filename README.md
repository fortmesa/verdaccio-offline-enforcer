# `verdaccio-offline-enforcer`

A [Verdaccio](https://verdaccio.org) middleware plugin: forces specific
usernames (or unauthenticated requests) into cache-only mode, serving only
already-cached packages instead of proxying to an upstream registry.

**Type**: Verdaccio `middlewares` (Express) plugin. **Config key**:
`middlewares.offline-enforcer`.

## What it does

Forces specific requests into "cache-only" mode: instead of proxying to an
upstream uplink for anything not already stored locally, the request gets a
`404` if it's not already cached. This is a _scoped_ version of Verdaccio's own
global `uplinks.<name>.offline: true` freeze -- that setting affects every
client; this plugin lets you restrict just certain usernames, or just
anonymous/unauthenticated traffic, without freezing the whole registry.

Restriction is decided per request, in this order:

1. Unauthenticated (`remote_user.name` is undefined): governed by
   `enforceForAnonymous` alone, regardless of the online/offline lists below.
2. `req.remote_user.name` is in `onlineUsernames`: never restricted.
3. `req.remote_user.name` is in `offlineUsernames`: always restricted.
4. Otherwise (an authenticated user in neither list): governed by
   `enforceForUnknown`.

## Installation

```bash
npm install @fortmesa/verdaccio-offline-enforcer
```

## Config

```yaml
middlewares:
  offline-enforcer:
    onlineUsernames: [] # usernames always allowed to proxy, regardless of everything else
    offlineUsernames: [] # usernames restricted to cache-only (default: none)
    enforceForAnonymous: true # anonymous requests are cache-only by default
    enforceForUnknown:
      false # default false preserves today's behavior -- an authenticated
      # user in neither list is allowed; set true to flip that default
```

Construction throws if the same username appears in both `onlineUsernames` and
`offlineUsernames` -- a config mistake, not something to silently resolve one
way or the other.

## Behavior details

- Only intercepts `GET` requests -- publish/unpublish and other methods pass
  through untouched.
- Ignores everything under `/-/` (`whoami`, `ping`, search, dist-tags, the web
  UI) -- those aren't package fetches.
- Parses the request path the same way Verdaccio's own routing does, including
  scoped-package `%40` encoding (`@scope%2Fname` <-> `@scope/name`), and
  validates each path segment against a safe-name pattern (no `/`, no `..`)
  before using it -- this guards against path-traversal via a crafted
  package/filename segment.
- **Tarball requests** (`GET /<pkg>/-/<file>.tgz`): checks
  `storage.hasLocalTarball()` and either streams the cached tarball directly or
  returns `404 not_found` if it isn't cached -- never falls through to the
  uplink.
- **Metadata requests** (`GET /<pkg>` or `GET /<pkg>/<version-or-tag>`): calls
  `storage.getPackage({ uplinksLook: false, ... })`, which forces a local-only
  lookup, then rewrites any `dist.tarball` URLs in the response to point at this
  registry (via `@verdaccio/tarball`'s `convertDistRemoteToLocalTarballUrls`)
  instead of the original upstream URLs, so a subsequent tarball fetch also
  stays local.

## Logging

`warn` on every blocked fetch (`offline-enforcer: blocked tarball fetch...` /
`...blocked metadata fetch...`), including the package/user; `error` only on
unexpected storage failures.

## Testing

```bash
node test/smoke.js
```

No test framework/build step -- a hand-rolled `node:assert`-based smoke test
that captures `register_middlewares()`'s single handler and drives it against
hand-built req/res objects and a minimal fake `Storage`.

## Dependencies

`@verdaccio/tarball` -- used purely for the dist-URL rewriting helper.

## License

MIT -- see [LICENSE](LICENSE).
