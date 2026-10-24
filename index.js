'use strict';

const {AsyncLocalStorage} = require('node:async_hooks');
const {PassThrough} = require('node:stream');

// Set for each request by register_middlewares() below and read by the
// storage wrappers, which Verdaccio calls from deep inside its own route
// handlers with no `req` in reach. AsyncLocalStorage carries the value
// through the storage plugin's callbacks and promises in between, the same
// way verdaccio-attestations carries its offline-restriction context into
// filter_metadata().
const requestContext = new AsyncLocalStorage();

// The storage methods this plugin wraps, and which Verdaccio itself calls for
// every read that can reach an uplink. They're Verdaccio internals (6.7.4 and
// 6.10.7 both have them with the signatures used below), so their absence
// stops the boot instead of leaving restricted identities online.
const REQUIRED_STORAGE_METHODS = [
  '_syncUplinksMetadata',
  '_isTarballAllowedByFilters',
  'getTarball',
  'search',
];

const WRAPPED = Symbol('verdaccio-offline-enforcer.wrapped');

function isRestrictedRequest() {
  return requestContext.getStore()?.restricted === true;
}

// The error Verdaccio's own getTarball emits for a tarball its filters
// block; its error middleware turns err.status into the response status.
function noSuchPackage() {
  return Object.assign(new Error('no such package available'), {
    status: 404,
    code: 404,
  });
}

class OfflineEnforcer {
  constructor(config, options) {
    this.logger = options.logger;

    // Renamed from onlineUsernames/offlineUsernames -- those old keys are no
    // longer read at all, so a config still using them would otherwise go
    // quietly inert (enforceForAnonymous/enforceForUnknown would be the only
    // thing left deciding restriction, silently dropping every configured
    // exemption). Fail loud instead of leaving a stale config no-op.
    if ('onlineUsernames' in config || 'offlineUsernames' in config) {
      throw this._configError(
        "offline-enforcer: 'onlineUsernames'/'offlineUsernames' were renamed to 'online'/'offline' " +
          '(now accepting usernames or groups, not just usernames) -- update your config',
      );
    }

    // A single list per state -- deliberately not split into separate
    // username/group config keys. Every other plugin in this stack
    // (generic-oidc's roles.allowList, oidc-auth's groupTemplates,
    // Verdaccio's own packages: access/publish) treats a username and a
    // group name as the same kind of thing: a plain string checked against
    // whichever ones apply to the current user. This plugin now matches
    // that convention instead of being the one place a username and a
    // group are configured differently.
    this.online = new Set(config.online ?? []);
    this.offline = new Set(config.offline ?? []);
    this.enforceForAnonymous = config.enforceForAnonymous ?? true;
    // Default false preserves today's behavior (any authenticated user not
    // explicitly offline-listed is implicitly allowed); set true to flip
    // that default and force every unlisted user into cache-only mode too.
    this.enforceForUnknown = config.enforceForUnknown ?? false;

    // Fail loud at startup on a config mistake, not silently-one-wins at
    // request time -- this is an access control.
    for (const entry of this.online) {
      if (this.offline.has(entry)) {
        throw this._configError(
          `offline-enforcer: '${entry}' is listed in both online and offline`,
        );
      }
    }
  }

  // Verdaccio's plugin loader can catch a constructor's throw and carry on
  // without the plugin when the plugins directory isn't on Node's module
  // path, so the reason is logged at error level before it's thrown.
  _configError(message) {
    this.logger.error({}, message);
    return new Error(message);
  }

  // Anonymous users have no `name`, handled first via enforceForAnonymous.
  // Otherwise, checks the user's own name AND every group Verdaccio's
  // createRemoteUser() actually put them in (real_groups -- the plugin-
  // provided groups, not the .groups superset that also carries the
  // universal $all/$authenticated-style defaults every logged-in user gets,
  // which would make onlineness/offlineness meaningless if matched against
  // those too) against online/offline: online always wins (never
  // restricted) if the name or ANY group matches, then offline (always
  // restricted) the same way, then enforceForUnknown decides anyone
  // matching neither. verdaccio-attestations mirrors this field for field
  // (its _isOfflineRestricted); change both together.
  _isRestricted(remoteUser) {
    if (remoteUser?.name === undefined) return this.enforceForAnonymous;
    const identities = [remoteUser.name, ...(remoteUser.real_groups ?? [])];
    if (identities.some(id => this.online.has(id))) return false;
    if (identities.some(id => this.offline.has(id))) return true;
    return this.enforceForUnknown;
  }

  // Verdaccio's own routes answer every request, so its access rules,
  // generated-token checks (revocation, read-only, CIDR), filters, version
  // and dist-tag handling, tarball URL rewriting and response format all
  // apply as usual. This plugin only marks a restricted identity's reads
  // and, through the storage wrappers, turns off every uplink lookup those
  // reads would make. Writes (publish, unpublish, dist-tag changes) are left
  // alone, so Verdaccio still checks an uplink before a name is published.
  register_middlewares(app, auth, storage) {
    this._wrapStorage(storage);

    app.use((req, res, next) => {
      const read = req.method === 'GET' || req.method === 'HEAD';
      const restricted = read && this._isRestricted(req.remote_user);
      requestContext.run({restricted, user: req.remote_user?.name}, () =>
        next(),
      );
    });
  }

  _wrapStorage(storage) {
    const missing = REQUIRED_STORAGE_METHODS.filter(
      name => typeof storage?.[name] !== 'function',
    );
    if (typeof storage?.localStorage?.getTarball !== 'function') {
      missing.push('localStorage.getTarball');
    }
    if (missing.length > 0) {
      throw this._configError(
        `offline-enforcer: this Verdaccio's storage has no ${missing.join(', ')}; ` +
          'refusing to start without cache-only enforcement',
      );
    }
    if (storage[WRAPPED]) return;
    storage[WRAPPED] = true;

    const logger = this.logger;
    const {_syncUplinksMetadata, getTarball, search} = storage;

    // Every metadata read (GET/HEAD of a package or version, dist-tags, the
    // web UI's readme and sidebar) and getTarball's own fallback go through
    // here. With uplinksLook false Verdaccio answers from local storage,
    // still running every filter, and 404s a package it has never cached.
    storage._syncUplinksMetadata = function (name, info, options, callback) {
      if (!isRestrictedRequest()) {
        return _syncUplinksMetadata.call(this, name, info, options, callback);
      }
      return _syncUplinksMetadata.call(
        this,
        name,
        info,
        {...options, uplinksLook: false},
        (err, ...rest) => {
          if (err?.status === 404) {
            logger.warn(
              {pkg: name, user: requestContext.getStore()?.user},
              'offline-enforcer: @{pkg} is not cached, and @{user} is cache-only',
            );
          }
          callback(err, ...rest);
        },
      );
    };

    // Verdaccio's getTarball falls back to an uplink when the tarball isn't
    // stored, even when the cached metadata already names it. For a
    // restricted read this does what it does minus that fallback: the
    // filter check first, then local storage only.
    storage.getTarball = function (name, filename) {
      if (!isRestrictedRequest()) return getTarball.call(this, name, filename);

      const out = new PassThrough();
      out.abort = () => {};
      this._isTarballAllowedByFilters(name, filename).then(
        allowed => {
          if (!allowed) {
            out.emit('error', noSuchPackage());
            return;
          }
          const local = this.localStorage.getTarball(name, filename);
          out.abort = () => local.abort?.();
          local.on('content-length', length =>
            out.emit('content-length', length),
          );
          local.on('open', () => local.pipe(out));
          local.on('error', err => {
            if (err?.status === 404) {
              logger.warn(
                {pkg: name, filename, user: requestContext.getStore()?.user},
                'offline-enforcer: @{pkg}/@{filename} is not cached, and @{user} is cache-only',
              );
            }
            out.emit('error', err);
          });
        },
        err => out.emit('error', err),
      );
      return out;
    };

    // Search asks every uplink unless the request's query has `local`.
    storage.search = function (startkey, options) {
      if (!isRestrictedRequest()) return search.call(this, startkey, options);
      const req = options?.req;
      const query = {...req?.query, local: ''};
      return search.call(this, startkey, {
        ...options,
        req: req ? Object.assign(Object.create(req), {query}) : {query},
      });
    };
  }
}

module.exports = (config, options) => new OfflineEnforcer(config, options);
module.exports.OfflineEnforcer = OfflineEnforcer;
