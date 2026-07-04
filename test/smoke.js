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
      const enforcer = factory(
        {onlineUsernames: ['alice']},
        {logger: NOOP_LOGGER},
      );
      assert.equal(enforcer._isRestricted({name: 'alice'}), false);
    },
  );

  await check('offline user is always restricted', () => {
    const enforcer = factory(
      {offlineUsernames: ['bob']},
      {logger: NOOP_LOGGER},
    );
    assert.equal(enforcer._isRestricted({name: 'bob'}), true);
  });

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
    'construction throws if a username is listed as both online and offline',
    () => {
      assert.throws(
        () =>
          factory(
            {onlineUsernames: ['dave'], offlineUsernames: ['dave']},
            {logger: NOOP_LOGGER},
          ),
        /listed in both/,
      );
    },
  );

  // --- End-to-end request-handling checks ---

  await check(
    "an online user reaches Verdaccio's own handling untouched, even under enforceForUnknown: true",
    async () => {
      const enforcer = factory(
        {onlineUsernames: ['alice'], enforceForUnknown: true},
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

  console.log(`\n${passed} check(s) passed.`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
