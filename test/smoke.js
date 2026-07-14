'use strict';

// Manual smoke test -- this repo has no test framework/build step for its
// plugins. Run with:
//   node verdaccio-offline-enforcer/test/smoke.js
// Captures register_middlewares()'s single handler (same pattern as
// verdaccio-oidc-auth/test/smoke.js's captureHandler) and drives it against
// hand-built req/res objects and a minimal fake Storage.

const assert = require('node:assert/strict');
const {PassThrough} = require('node:stream');
const factory = require('../index.js');

const NOOP_LOGGER = {warn() {}, error() {}, info() {}};

function captureHandler(enforcer, storage) {
  let handler;
  enforcer.register_middlewares({use: fn => (handler = fn)}, null, storage);
  return handler;
}

function makeFakeStorage({hasLocalTarball = true} = {}) {
  return {
    hasLocalTarball: async () => hasLocalTarball,
    getTarball() {
      const stream = new PassThrough();
      process.nextTick(() => stream.end('tarball-bytes'));
      return stream;
    },
    getPackage({callback}) {
      callback(null, {
        name: 'some-pkg',
        versions: {'1.0.0': {}},
        'dist-tags': {latest: '1.0.0'},
        time: {},
      });
    },
  };
}

function makeReq({method = 'GET', path = '/some-pkg', remoteUser} = {}) {
  return {
    method,
    path,
    headers: {},
    protocol: 'http',
    hostname: 'localhost',
    socket: {remoteAddress: '127.0.0.1'},
    remote_user: remoteUser,
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    header(name, value) {
      this.headers[name] = value;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
  };
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

  // --- End-to-end request-handling checks ---

  await check(
    "an online user reaches Verdaccio's own handling untouched, even under enforceForUnknown: true",
    async () => {
      const enforcer = factory(
        {online: ['alice'], enforceForUnknown: true},
        {logger: NOOP_LOGGER},
      );
      const storage = makeFakeStorage();
      const handler = captureHandler(enforcer, storage);
      const req = makeReq({remoteUser: {name: 'alice'}});
      const res = makeRes();
      let nextCalled = false;
      handler(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
    },
  );

  await check(
    'an unknown user is blocked from a not-locally-cached tarball when enforceForUnknown is true',
    async () => {
      const enforcer = factory(
        {enforceForUnknown: true},
        {logger: NOOP_LOGGER},
      );
      const storage = makeFakeStorage({hasLocalTarball: false});
      const handler = captureHandler(enforcer, storage);
      const req = makeReq({
        path: '/some-pkg/-/some-pkg-1.0.0.tgz',
        remoteUser: {name: 'carol'},
      });
      const res = makeRes();
      await new Promise(resolve => {
        handler(req, res, () => {});
        setImmediate(resolve); // _handleTarball resolves storage.hasLocalTarball() asynchronously
      });
      assert.equal(res.statusCode, 404);
    },
  );

  await check(
    'a scoped package is enforced, not bypassed -- a restricted user is blocked from a not-locally-cached scoped tarball',
    async () => {
      const enforcer = factory({offline: ['bob']}, {logger: NOOP_LOGGER});
      const storage = makeFakeStorage({hasLocalTarball: false});
      const handler = captureHandler(enforcer, storage);
      // Real npm client shape: a literal "/" between scope and package name,
      // not pre-encoded -- normalizeScopedPath() is what turns this into a
      // single logical segment.
      const req = makeReq({
        path: '/@scope/pkg/-/pkg-1.0.0.tgz',
        remoteUser: {name: 'bob'},
      });
      const res = makeRes();
      await new Promise(resolve => {
        handler(req, res, () => {});
        setImmediate(resolve);
      });
      assert.equal(
        res.statusCode,
        404,
        'a scoped package must be enforced (checked against local storage), never handed off to next() untouched',
      );
    },
  );

  await check(
    'a scoped package with a pre-encoded scope (%40) is also enforced',
    async () => {
      const enforcer = factory({offline: ['bob']}, {logger: NOOP_LOGGER});
      const storage = makeFakeStorage({hasLocalTarball: false});
      const handler = captureHandler(enforcer, storage);
      const req = makeReq({
        path: '/%40scope%2Fpkg/-/pkg-1.0.0.tgz',
        remoteUser: {name: 'bob'},
      });
      const res = makeRes();
      await new Promise(resolve => {
        handler(req, res, () => {});
        setImmediate(resolve);
      });
      assert.equal(res.statusCode, 404);
    },
  );

  await check(
    'an online user still reaches a scoped package untouched',
    async () => {
      const enforcer = factory({online: ['alice']}, {logger: NOOP_LOGGER});
      const storage = makeFakeStorage();
      const handler = captureHandler(enforcer, storage);
      const req = makeReq({
        path: '/@scope/pkg/-/pkg-1.0.0.tgz',
        remoteUser: {name: 'alice'},
      });
      const res = makeRes();
      let nextCalled = false;
      handler(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
    },
  );

  console.log(`\n${passed} check(s) passed.`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
