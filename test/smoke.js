'use strict';

// Unit checks, no Verdaccio process: the restriction rules, and the storage
// wrappers register_middlewares() installs, against a fake storage that
// records what Verdaccio's own code would have received. test/verdaccio.js
// runs the plugin inside a real Verdaccio. Run with:
//   node test/smoke.js

const assert = require('node:assert/strict');
const {PassThrough} = require('node:stream');
const factory = require('../index.js');

const NOOP_LOGGER = {warn() {}, error() {}, info() {}};

// Stands in for Verdaccio's Storage: each method records its arguments, and
// local storage holds whatever `stored` lists.
function makeFakeStorage({stored = {}, allowed = true} = {}) {
  const calls = [];
  const storage = {
    calls,
    _syncUplinksMetadata(name, info, options, callback) {
      calls.push({method: '_syncUplinksMetadata', name, options});
      process.nextTick(() =>
        name in stored
          ? callback(null, stored[name])
          : callback(Object.assign(new Error('not found'), {status: 404})),
      );
    },
    async _isTarballAllowedByFilters(name, filename) {
      calls.push({method: '_isTarballAllowedByFilters', name, filename});
      return allowed;
    },
    getTarball(name, filename) {
      calls.push({method: 'getTarball (Verdaccio)', name, filename});
      const stream = new PassThrough();
      process.nextTick(() => stream.end('from-verdaccio'));
      return stream;
    },
    search(startkey, options) {
      calls.push({method: 'search', startkey, options});
      return new PassThrough({objectMode: true});
    },
    localStorage: {
      getTarball(name, filename) {
        calls.push({method: 'localStorage.getTarball', name, filename});
        const stream = new PassThrough();
        process.nextTick(() => {
          const key = `${name}/${filename}`;
          if (key in stored) {
            stream.emit('content-length', stored[key].length);
            stream.emit('open');
            stream.end(stored[key]);
          } else {
            stream.emit(
              'error',
              Object.assign(new Error('no such file available'), {
                status: 404,
              }),
            );
          }
        });
        return stream;
      },
    },
  };
  return storage;
}

// Installs the plugin on a fake app and returns a function that runs `fn`
// inside the plugin's middleware for a request with this method and user,
// the way Verdaccio's own route handler would run after it.
function install(enforcer, storage) {
  let middleware;
  enforcer.register_middlewares({use: fn => (middleware = fn)}, {}, storage);
  return (method, remoteUser, fn) =>
    new Promise((resolve, reject) => {
      middleware({method, remote_user: remoteUser}, {}, () => {
        Promise.resolve().then(fn).then(resolve, reject);
      });
    });
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
    stream.on('error', reject);
  });
}

function syncUplinks(storage, name) {
  return new Promise(resolve =>
    storage._syncUplinksMetadata(name, null, {}, (err, data) =>
      resolve({err, data}),
    ),
  );
}

async function main() {
  let passed = 0;

  async function check(name, fn) {
    try {
      await fn();
      passed++;
      console.log(`PASS: ${name}`);
    } catch (err) {
      console.error(`FAIL: ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }

  // --- _isRestricted() direct checks ---

  await check(
    'online user is never restricted, even when also anonymous-restricted by default',
    () => {
      const enforcer = factory({online: ['alice']}, {logger: NOOP_LOGGER});
      assert.equal(enforcer._isRestricted({name: 'alice'}), false);
    },
  );

  await check('offline user is always restricted', () => {
    const enforcer = factory({offline: ['bob']}, {logger: NOOP_LOGGER});
    assert.equal(enforcer._isRestricted({name: 'bob'}), true);
  });

  await check(
    'a group in online (via real_groups) is never restricted, even for a username not itself listed',
    () => {
      const enforcer = factory(
        {online: ['fortmesa.com']},
        {logger: NOOP_LOGGER},
      );
      assert.equal(
        enforcer._isRestricted({
          name: 'alice@fortmesa.com',
          real_groups: ['fortmesa.com'],
        }),
        false,
      );
    },
  );

  await check(
    'a group in offline (via real_groups) is always restricted, even for a username not itself listed',
    () => {
      const enforcer = factory(
        {offline: ['gha-org:untrusted-org']},
        {logger: NOOP_LOGGER},
      );
      assert.equal(
        enforcer._isRestricted({
          name: 'gha:untrusted-org/some-repo',
          real_groups: ['gha:untrusted-org/some-repo', 'gha-org:untrusted-org'],
        }),
        true,
      );
    },
  );

  await check(
    'matching is against real_groups, not the .groups superset every logged-in user gets ($all/$authenticated) -- those must never accidentally satisfy online',
    () => {
      // enforceForUnknown: true makes this test actually meaningful -- if
      // '$authenticated' wrongly matched via .groups instead of
      // real_groups, this would come back false (exempted as online)
      // instead of falling through to enforceForUnknown's true.
      const enforcer = factory(
        {online: ['$authenticated'], enforceForUnknown: true},
        {logger: NOOP_LOGGER},
      );
      assert.equal(
        enforcer._isRestricted({
          name: 'alice',
          groups: ['team1', '$all', '$authenticated'],
          real_groups: ['team1'],
        }),
        true,
      );
    },
  );

  await check(
    'construction throws loud if the old onlineUsernames/offlineUsernames keys are still present',
    () => {
      assert.throws(
        () => factory({onlineUsernames: ['alice']}, {logger: NOOP_LOGGER}),
        /renamed to 'online'\/'offline'/,
      );
      assert.throws(
        () => factory({offlineUsernames: ['bob']}, {logger: NOOP_LOGGER}),
        /renamed to 'online'\/'offline'/,
      );
    },
  );

  await check(
    "a user in neither list follows enforceForUnknown (default false preserves today's behavior)",
    () => {
      const permissive = factory({}, {logger: NOOP_LOGGER});
      assert.equal(permissive._isRestricted({name: 'carol'}), false);

      const strict = factory({enforceForUnknown: true}, {logger: NOOP_LOGGER});
      assert.equal(strict._isRestricted({name: 'carol'}), true);
    },
  );

  await check(
    'anonymous requests are governed by enforceForAnonymous regardless of the online/offline lists',
    () => {
      const enforcer = factory(
        {enforceForAnonymous: false},
        {logger: NOOP_LOGGER},
      );
      assert.equal(enforcer._isRestricted(undefined), false);
    },
  );

  await check(
    'construction throws if the same entry is listed as both online and offline',
    () => {
      assert.throws(
        () =>
          factory({online: ['dave'], offline: ['dave']}, {logger: NOOP_LOGGER}),
        /listed in both/,
      );
    },
  );

  // --- storage wrappers ---

  const RESTRICTED = {name: 'ci-bot', real_groups: []};
  const ONLINE = {name: 'alice', real_groups: ['fortmesa.com']};
  const ANONYMOUS = {name: undefined, groups: [], real_groups: []};
  const config = {online: ['fortmesa.com'], enforceForUnknown: true};

  await check(
    "a restricted identity's GET and HEAD look nothing up on an uplink",
    async () => {
      const storage = makeFakeStorage();
      const run = install(factory(config, {logger: NOOP_LOGGER}), storage);
      for (const method of ['GET', 'HEAD']) {
        await run(method, RESTRICTED, () => syncUplinks(storage, 'left-pad'));
      }
      const syncs = storage.calls.filter(
        c => c.method === '_syncUplinksMetadata',
      );
      assert.equal(syncs.length, 2);
      assert.ok(syncs.every(c => c.options.uplinksLook === false));
    },
  );

  await check('anonymous reads are restricted by default too', async () => {
    const storage = makeFakeStorage();
    const run = install(factory(config, {logger: NOOP_LOGGER}), storage);
    await run('GET', ANONYMOUS, () => syncUplinks(storage, 'left-pad'));
    assert.equal(storage.calls[0].options.uplinksLook, false);
  });

  await check(
    "an online identity's reads, and anyone's writes, keep Verdaccio's uplink lookups",
    async () => {
      const storage = makeFakeStorage();
      const run = install(factory(config, {logger: NOOP_LOGGER}), storage);
      await run('GET', ONLINE, () => syncUplinks(storage, 'left-pad'));
      // A publish checks the uplink for an existing name; that must still
      // happen for a restricted publisher.
      await run('PUT', RESTRICTED, () => syncUplinks(storage, 'new-pkg'));
      assert.deepEqual(
        storage.calls.map(c => c.options.uplinksLook),
        [undefined, undefined],
      );
    },
  );

  await check(
    'a call with no request context (nothing set by the middleware) is left alone',
    async () => {
      const storage = makeFakeStorage();
      install(factory(config, {logger: NOOP_LOGGER}), storage);
      await syncUplinks(storage, 'left-pad');
      assert.equal(storage.calls[0].options.uplinksLook, undefined);
    },
  );

  await check(
    "a restricted tarball read is served from local storage after the filter check, never through Verdaccio's getTarball",
    async () => {
      const storage = makeFakeStorage({
        stored: {'left-pad/left-pad-1.3.0.tgz': 'cached-bytes'},
      });
      const run = install(factory(config, {logger: NOOP_LOGGER}), storage);
      let length;
      const body = await run('GET', RESTRICTED, () => {
        const stream = storage.getTarball('left-pad', 'left-pad-1.3.0.tgz');
        stream.on('content-length', v => (length = v));
        return readAll(stream);
      });
      assert.equal(body, 'cached-bytes');
      assert.equal(length, 'cached-bytes'.length);
      assert.deepEqual(
        storage.calls.map(c => c.method),
        ['_isTarballAllowedByFilters', 'localStorage.getTarball'],
      );
    },
  );

  await check(
    'a restricted read of a tarball that is not stored fails with 404 instead of reaching an uplink',
    async () => {
      const storage = makeFakeStorage();
      const run = install(factory(config, {logger: NOOP_LOGGER}), storage);
      const err = await run('GET', RESTRICTED, () =>
        readAll(storage.getTarball('left-pad', 'left-pad-1.3.0.tgz')).then(
          () => null,
          e => e,
        ),
      );
      assert.equal(err?.status, 404);
      assert.ok(
        !storage.calls.some(c => c.method === 'getTarball (Verdaccio)'),
      );
    },
  );

  await check(
    'a restricted read of a tarball the filters block fails with 404 without touching storage',
    async () => {
      const storage = makeFakeStorage({allowed: false});
      const run = install(factory(config, {logger: NOOP_LOGGER}), storage);
      const err = await run('GET', RESTRICTED, () =>
        readAll(storage.getTarball('left-pad', 'left-pad-1.3.0.tgz')).then(
          () => null,
          e => e,
        ),
      );
      assert.equal(err?.status, 404);
      assert.ok(
        !storage.calls.some(c => c.method === 'localStorage.getTarball'),
      );
    },
  );

  await check(
    "an online identity's tarball read goes through Verdaccio's own getTarball",
    async () => {
      const storage = makeFakeStorage();
      const run = install(factory(config, {logger: NOOP_LOGGER}), storage);
      const body = await run('GET', ONLINE, () =>
        readAll(storage.getTarball('left-pad', 'left-pad-1.3.0.tgz')),
      );
      assert.equal(body, 'from-verdaccio');
    },
  );

  await check(
    "a restricted search asks local storage only, keeping the rest of the request's query",
    async () => {
      const storage = makeFakeStorage();
      const run = install(factory(config, {logger: NOOP_LOGGER}), storage);
      const req = {query: {text: 'left'}, headers: {host: 'x'}};
      await run('GET', RESTRICTED, () => storage.search(0, {req}));
      const {options} = storage.calls[0];
      assert.equal(options.req.query.local, '');
      assert.equal(options.req.query.text, 'left');
      assert.equal(options.req.headers.host, 'x');
      assert.equal(
        req.query.local,
        undefined,
        'the real request is not changed',
      );

      await run('GET', ONLINE, () => storage.search(0, {req}));
      assert.equal(storage.calls[1].options.req, req);
    },
  );

  await check(
    "refuses to start against a storage missing a method it wraps, naming what's missing",
    () => {
      const storage = makeFakeStorage();
      delete storage._syncUplinksMetadata;
      delete storage.localStorage;
      const errors = [];
      const enforcer = factory(config, {
        logger: {...NOOP_LOGGER, error: (obj, msg) => errors.push(msg)},
      });
      assert.throws(
        () => enforcer.register_middlewares({use() {}}, {}, storage),
        /_syncUplinksMetadata, localStorage\.getTarball/,
      );
      assert.equal(errors.length, 1, 'logged at error level as well');
    },
  );

  await check(
    'installing twice on the same storage wraps it once',
    async () => {
      const storage = makeFakeStorage();
      const enforcer = factory(config, {logger: NOOP_LOGGER});
      install(enforcer, storage);
      const once = storage._syncUplinksMetadata;
      install(enforcer, storage);
      assert.equal(storage._syncUplinksMetadata, once);
    },
  );

  console.log(`\n${passed} check(s) passed.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
