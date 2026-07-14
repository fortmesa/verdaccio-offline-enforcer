'use strict';

const {convertDistRemoteToLocalTarballUrls} = require('@verdaccio/tarball');

// A package/scope segment: no slashes, no path traversal, not empty.
const SAFE_SEGMENT = /^[^/@][^/]*$/;

// Mirrors @verdaccio/middleware's encodeScopePackage, applied to req.path so a
// scoped name (`@scope/pkg`) is treated as the single first path segment.
function normalizeScopedPath(path) {
  return path.replace(/\/%40/, '/@').replace(/(\/@[^/%]+)\/(?!$)/, '$1%2F');
}

function isSafeName(segment) {
  return (
    typeof segment === 'string' &&
    !segment.includes('..') &&
    SAFE_SEGMENT.test(segment)
  );
}

// A decoded package name: either a single safe segment (unscoped, e.g.
// "left-pad"), or exactly one "/" with a "@scope" half on the left (itself
// a safe segment once its leading "@" is stripped) and a safe segment on
// the right (e.g. "@scope/pkg"). Anything with zero "/" but a leading "@",
// or more than one "/", is never a real package name and must not be
// treated as a safe one just because it superficially looks segment-like.
function isSafePackageName(name) {
  if (typeof name !== 'string' || name.includes('..')) return false;
  const parts = name.split('/');
  if (parts.length === 1) return SAFE_SEGMENT.test(name);
  return (
    parts.length === 2 &&
    parts[0].startsWith('@') &&
    SAFE_SEGMENT.test(parts[0].slice(1)) &&
    SAFE_SEGMENT.test(parts[1])
  );
}

class OfflineEnforcer {
  constructor(config, options) {
    this.logger = options.logger;
    this.urlPrefix = config.urlPrefix;

    // Renamed from onlineUsernames/offlineUsernames -- those old keys are no
    // longer read at all, so a config still using them would otherwise go
    // quietly inert (enforceForAnonymous/enforceForUnknown would be the only
    // thing left deciding restriction, silently dropping every configured
    // exemption). Fail loud instead of leaving a stale config no-op.
    if ('onlineUsernames' in config || 'offlineUsernames' in config) {
      throw new Error(
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
        throw new Error(
          `offline-enforcer: '${entry}' is listed in both online and offline`,
        );
      }
    }
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
  // matching neither.
  _isRestricted(remoteUser) {
    if (remoteUser?.name === undefined) return this.enforceForAnonymous;
    const identities = [remoteUser.name, ...(remoteUser.real_groups ?? [])];
    if (identities.some(id => this.online.has(id))) return false;
    if (identities.some(id => this.offline.has(id))) return true;
    return this.enforceForUnknown;
  }

  register_middlewares(app, auth, storage) {
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      if (!this._isRestricted(req.remote_user)) return next();

      const segments = normalizeScopedPath(req.path).split('/').filter(Boolean);
      // Everything else (whoami, ping, search, dist-tags, web UI) lives under /-/.
      if (segments.length === 0 || segments[0] === '-') return next();

      const rawPackageName = decodeURIComponent(segments[0]);
      if (!isSafePackageName(rawPackageName)) return next();

      if (segments[1] === '-') {
        if (segments.length < 3 || !isSafeName(segments[2])) return next();
        return this._handleTarball(
          req,
          res,
          storage,
          rawPackageName,
          decodeURIComponent(segments[2]),
        );
      }

      if (segments.length <= 2) {
        const queryVersion =
          segments[1] !== undefined
            ? decodeURIComponent(segments[1])
            : undefined;
        return this._handleMetadata(
          req,
          res,
          storage,
          rawPackageName,
          queryVersion,
        );
      }

      return next();
    });
  }

  _handleTarball(req, res, storage, packageName, filename) {
    const user = req.remote_user?.name;
    storage
      .hasLocalTarball(packageName, filename)
      .then(hasLocal => {
        if (!hasLocal) {
          this.logger.warn(
            {pkg: packageName, filename, user},
            'offline-enforcer: blocked tarball fetch -- not cached locally',
          );
          return res.status(404).json({
            error: 'not_found',
            reason: `${packageName}/${filename} is not available offline`,
          });
        }
        const stream = storage.getTarball(packageName, filename);
        stream.on('content-length', len => res.header('Content-Length', len));
        stream.on('error', err => {
          if (res.headersSent) return res.end();
          res
            .status(err.status || 404)
            .json({error: 'not_found', reason: err.message});
        });
        res.header('Content-Type', 'application/octet-stream');
        stream.pipe(res);
      })
      .catch(err => {
        this.logger.error(
          {err, pkg: packageName},
          'offline-enforcer: error checking local tarball',
        );
        res.status(500).json({error: 'internal_error'});
      });
  }

  _handleMetadata(req, res, storage, packageName, queryVersion) {
    const user = req.remote_user?.name;
    const accept = req.headers.accept || '';
    const abbreviated = accept.includes('vnd.npm.install-v1+json');

    storage.getPackage({
      name: packageName,
      // The one option that matters: skip every uplink and answer from local storage only.
      uplinksLook: false,
      req,
      abbreviated,
      callback: (err, metadata) => {
        if (err) {
          this.logger.warn(
            {pkg: packageName, user, err: err.message},
            'offline-enforcer: blocked metadata fetch -- not available offline',
          );
          return res.status(err.status || 404).json({
            error: 'not_found',
            reason: `${packageName} is not available offline`,
          });
        }

        metadata = convertDistRemoteToLocalTarballUrls(
          metadata,
          {
            protocol: req.protocol,
            headers: req.headers,
            host: req.hostname,
            remoteAddress: req.socket.remoteAddress,
          },
          this.urlPrefix,
        );

        if (queryVersion === undefined) {
          res.setHeader(
            'Content-Type',
            abbreviated
              ? 'application/vnd.npm.install-v1+json'
              : 'application/json',
          );
          return res.json(metadata);
        }

        let version = metadata.versions?.[queryVersion];
        if (!version && metadata['dist-tags']?.[queryVersion]) {
          version = metadata.versions?.[metadata['dist-tags'][queryVersion]];
        }
        if (!version) {
          return res.status(404).json({
            error: 'not_found',
            reason: `${packageName}@${queryVersion} is not available offline`,
          });
        }
        res.setHeader('Content-Type', 'application/json');
        res.json(version);
      },
    });
  }
}

module.exports = (config, options) => new OfflineEnforcer(config, options);
