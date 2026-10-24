# `verdaccio-offline-enforcer`

A [Verdaccio](https://verdaccio.org) middleware plugin: forces specific
usernames or groups (or unauthenticated requests) into cache-only mode, serving
only already-cached packages instead of proxying to an upstream registry.

**Type**: Verdaccio `middlewares` (Express) plugin. **Config key** (the literal,
scoped package name -- Verdaccio never prefix-mangles a scoped plugin's config
key): `middlewares."@fortmesa/verdaccio-offline-enforcer"`.

## What it does

Forces specific requests into "cache-only" mode: instead of proxying to an
upstream uplink for anything not already stored locally, the request gets a
`404` if it's not already cached. This is a _scoped_ version of Verdaccio's own
global `uplinks.<name>.offline: true` freeze -- that setting affects every
client; this plugin lets you restrict just certain identities, or just
anonymous/unauthenticated traffic, without freezing the whole registry.

`online`/`offline` accept a username **or** a group name, exactly like
Verdaccio's own `packages: access/publish` and every other plugin in this stack
(generic-oidc's `roles.allowList`, oidc-auth's `groupTemplates`) treat the two
as the same kind of thing -- a plain string checked against whichever apply to
the current user. A user matches an entry if their own username matches it, or
if any of their groups do (Verdaccio's `real_groups` -- the groups a plugin
actually assigned, not the `$all`/`$authenticated`-style defaults every
logged-in user also carries).

Restriction is decided per request, in this order:

1. Unauthenticated (`remote_user.name` is undefined): governed by
   `enforceForAnonymous` alone, regardless of the online/offline lists below.
2. The user's name or any of their groups is in `online`: never restricted.
3. The user's name or any of their groups is in `offline`: always restricted.
4. Otherwise (an authenticated user matching neither): governed by
   `enforceForUnknown`.

## Installation

```bash
npm install @fortmesa/verdaccio-offline-enforcer
```

## Config

```yaml
middlewares:
  '@fortmesa/verdaccio-offline-enforcer':
    online: [] # usernames/groups always allowed to proxy, regardless of everything else
    offline: [] # usernames/groups restricted to cache-only (default: none)
    enforceForAnonymous: true # anonymous requests are cache-only by default
    enforceForUnknown:
      false # default false preserves today's behavior -- an authenticated
      # user matching neither list is allowed; set true to flip that default
```

Construction throws if the same entry appears in both `online` and `offline` --
a config mistake, not something to silently resolve one way or the other.

## How it works

The plugin never answers a request itself. Verdaccio's own routes answer every
one, so its `packages:` access rules (401 for anonymous, 403 for a user without
access), its checks on tokens from `npm token create` (revocation, read-only,
CIDR), every `filter_metadata` plugin, version and dist-tag handling, tarball
URL rewriting and its response format all apply exactly as they do without this
plugin.

For a `GET` or `HEAD` from a restricted identity, the plugin turns off the
uplink lookups Verdaccio's storage would make:

- package metadata, for every route that reads it (`/<pkg>`, `/<pkg>/<version>`,
  `/-/package/<pkg>/dist-tags`, the web UI's readme and sidebar), comes from
  local storage only, and a package never cached is a 404;
- a tarball comes from local storage only, after Verdaccio's own filter check,
  even when the cached metadata names one storage doesn't hold yet;
- search (`/-/v1/search`, `/-/all`) asks local storage only.

Writes (publish, unpublish, dist-tag changes) are left alone, so Verdaccio still
asks the uplink whether a name already exists before accepting a publish.

It does this by wrapping three methods on the storage object
`register_middlewares()` receives (`_syncUplinksMetadata`, `getTarball`,
`search`) and marking each request with an `AsyncLocalStorage` context, the same
technique `verdaccio-attestations` uses. Those are Verdaccio internals, present
with the same signatures in 6.7.4 and 6.10.7; if the storage lacks any of them
the plugin logs an error and refuses to start rather than leave restricted
identities online.

Needs Node.js 22.12 or later.

## Logging

`warn` when a restricted identity asks for a package or tarball that isn't
cached (`offline-enforcer: <pkg> is not cached, and <user> is cache-only`).
`error` for a configuration the plugin refuses to start with.

## Testing

```bash
yarn test
```

Runs `test/smoke.js` (the restriction rules, and the storage wrappers against a
fake storage) and `test/verdaccio.js`, which runs the plugin in a real Verdaccio
in front of a fake uplink that counts every request it gets. Point
`VERDACCIO_BIN` at another Verdaccio build to run the second against it, for
example the one fm-npmjs deploys:

```bash
VERDACCIO_BIN=../fm-npmjs/node_modules/verdaccio/bin/verdaccio node test/verdaccio.js
```

## Dependencies

None at runtime: everything it uses is Node's own (`node:async_hooks`,
`node:stream`) or Verdaccio's storage object.

## License

MIT -- see [LICENSE](LICENSE).
