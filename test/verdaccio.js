'use strict';

// The plugin inside a real Verdaccio, in front of a fake uplink that counts
// every request it gets. Proves that a restricted identity's reads never
// reach the uplink by any route, and that Verdaccio's own access rules,
// filters and responses still apply. Run with:
//   node test/verdaccio.js
// VERDACCIO_BIN points it at another Verdaccio build, e.g. the one
// fm-npmjs deploys:
//   VERDACCIO_BIN=../fm-npmjs/node_modules/verdaccio/bin/verdaccio node test/verdaccio.js

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

const PLUGIN_ROOT = path.join(__dirname, '..');
// verdaccio's package exports don't include its bin, so it's found by path.
const VERDACCIO_BIN =
  process.env.VERDACCIO_BIN ??
  path.join(PLUGIN_ROOT, 'node_modules', 'verdaccio', 'bin', 'verdaccio');

const REMOTE_TARBALL = Buffer.from('remote-pkg 1.0.0 tarball bytes');

// A registry with one package, remote-pkg, and a search endpoint. Every
// request is recorded by path.
function startFakeUplink() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url.split('?')[0]}`);
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = (status, body) => {
      res.writeHead(status, {'content-type': 'application/json'});
      res.end(JSON.stringify(body));
    };
    if (req.url === '/remote-pkg') {
      return json(200, {
        name: 'remote-pkg',
        'dist-tags': {latest: '1.0.0'},
        versions: {
          '1.0.0': {
            name: 'remote-pkg',
            version: '1.0.0',
            dist: {
              tarball: `${base}/remote-pkg/-/remote-pkg-1.0.0.tgz`,
              shasum: crypto
                .createHash('sha1')
                .update(REMOTE_TARBALL)
                .digest('hex'),
            },
          },
        },
        time: {'1.0.0': '2020-01-01T00:00:00.000Z'},
      });
    }
    if (req.url === '/remote-pkg/-/remote-pkg-1.0.0.tgz') {
      res.writeHead(200, {'content-type': 'application/octet-stream'});
      return res.end(REMOTE_TARBALL);
    }
    if (req.url.startsWith('/-/v1/search')) {
      return json(200, {objects: [], total: 0, time: new Date().toString()});
    }
    json(404, {error: 'not found'});
  });
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve({server, requests})),
  );
}

function freePort() {
  return new Promise(resolve => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const {port} = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitForUp(url, proc) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (proc.exitCode != null) break;
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`verdaccio never came up:\n${proc.getOutput()}`);
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

  const {server: uplink, requests} = await startFakeUplink();
  const uplinkUrl = `http://127.0.0.1:${uplink.address().port}/`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-enforcer-'));
  const plugins = path.join(work, 'plugins');
  fs.mkdirSync(path.join(plugins, '@fortmesa'), {recursive: true});
  fs.symlinkSync(
    PLUGIN_ROOT,
    path.join(plugins, '@fortmesa', 'verdaccio-offline-enforcer'),
    'dir',
  );
  fs.writeFileSync(path.join(work, 'htpasswd'), '');
  fs.writeFileSync(
    path.join(work, 'config.yaml'),
    `
storage: ${path.join(work, 'storage')}
plugins: ${plugins}
auth:
  htpasswd:
    file: ${path.join(work, 'htpasswd')}
    max_users: 1000
uplinks:
  fake:
    url: ${uplinkUrl}
    cache: true
packages:
  '@locked/*':
    access: alice
    publish: alice
  '@private/*':
    access: $authenticated
    publish: $authenticated
  '**':
    access: $authenticated
    publish: $authenticated
    proxy: fake
middlewares:
  '@fortmesa/verdaccio-offline-enforcer':
    online: [alice]
    offline: []
    enforceForAnonymous: true
    enforceForUnknown: true
log: {type: stdout, format: pretty, level: warn}
`,
  );

  const port = await freePort();
  const registry = `http://127.0.0.1:${port}`;
  const proc = spawn(
    process.execPath,
    [
      VERDACCIO_BIN,
      '--config',
      path.join(work, 'config.yaml'),
      '--listen',
      `127.0.0.1:${port}`,
    ],
    {stdio: ['ignore', 'pipe', 'pipe']},
  );
  let output = '';
  proc.stdout.on('data', d => (output += d));
  proc.stderr.on('data', d => (output += d));
  proc.getOutput = () => output;

  try {
    await waitForUp(`${registry}/-/ping`, proc);

    async function addUser(name) {
      const res = await fetch(`${registry}/-/user/org.couchdb.user:${name}`, {
        method: 'PUT',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          name,
          password: crypto.randomBytes(12).toString('hex'),
        }),
      });
      const body = await res.json();
      assert.ok(body.token, `registering ${name}: ${JSON.stringify(body)}`);
      return {authorization: `Bearer ${body.token}`};
    }
    const alice = await addUser('alice'); // online
    const ciBot = await addUser('ci-bot'); // restricted: in neither list

    async function publish(as, name) {
      const data = Buffer.from(`${name} tarball`);
      const file = `${name.split('/').pop()}-1.0.0.tgz`;
      const res = await fetch(`${registry}/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: {...as, 'content-type': 'application/json'},
        body: JSON.stringify({
          _id: name,
          name,
          'dist-tags': {latest: '1.0.0'},
          versions: {
            '1.0.0': {
              name,
              version: '1.0.0',
              dist: {
                tarball: `${registry}/${name}/-/${file}`,
                shasum: crypto.createHash('sha1').update(data).digest('hex'),
              },
            },
          },
          _attachments: {
            [file]: {
              content_type: 'application/octet-stream',
              data: data.toString('base64'),
              length: data.length,
            },
          },
        }),
      });
      return res.status;
    }
    assert.equal(await publish(alice, '@private/pkg'), 201);
    assert.equal(await publish(alice, '@locked/pkg'), 201);

    const uplinkHits = prefix =>
      requests.filter(r => r.includes(prefix)).length;
    const get = (url, headers = {}, method = 'GET') =>
      fetch(`${registry}${url}`, {method, headers});

    await check(
      "anonymous reads get Verdaccio's own 401, for local and proxied packages alike, and reach no uplink",
      async () => {
        for (const url of [
          '/@private%2fpkg',
          '/@private/pkg/-/pkg-1.0.0.tgz',
          '/remote-pkg',
        ]) {
          const res = await get(url);
          assert.equal(res.status, 401, url);
          assert.match(
            res.headers.get('www-authenticate') ?? '',
            /Basic/,
            `${url} should carry Verdaccio's WWW-Authenticate`,
          );
        }
        assert.equal(uplinkHits('remote-pkg'), 0);
      },
    );

    await check(
      "an authenticated identity without access gets Verdaccio's own 403",
      async () => {
        const res = await get('/@locked%2fpkg', ciBot);
        assert.equal(res.status, 403);
      },
    );

    await check(
      'a restricted identity can read a package that is stored locally',
      async () => {
        const res = await get('/@private%2fpkg', ciBot);
        assert.equal(res.status, 200);
        const tarball = await get('/@private/pkg/-/pkg-1.0.0.tgz', ciBot);
        assert.equal(tarball.status, 200);
        assert.equal(await tarball.text(), '@private/pkg tarball');
      },
    );

    await check(
      'a restricted GET, HEAD and dist-tags read of a package never cached 404 and reach no uplink',
      async () => {
        assert.equal((await get('/remote-pkg', ciBot)).status, 404);
        assert.equal((await get('/remote-pkg', ciBot, 'HEAD')).status, 404);
        assert.equal((await get('/remote-pkg/1.0.0', ciBot)).status, 404);
        assert.equal(
          (await get('/-/package/remote-pkg/dist-tags', ciBot)).status,
          404,
        );
        assert.equal(uplinkHits('remote-pkg'), 0, JSON.stringify(requests));
      },
    );

    await check('a restricted search asks no uplink', async () => {
      const res = await get('/-/v1/search?text=remote', ciBot);
      assert.equal(res.status, 200);
      assert.equal(uplinkHits('/-/v1/search'), 0);
    });

    await check(
      "an online identity's read goes to the uplink and caches the metadata",
      async () => {
        const res = await get('/remote-pkg', alice);
        assert.equal(res.status, 200);
        assert.equal(uplinkHits('GET /remote-pkg'), 1);
      },
    );

    await check(
      'a restricted read of the cached metadata is answered from storage, with tarball URLs pointing at this registry',
      async () => {
        const before = requests.length;
        const res = await get('/remote-pkg', ciBot);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(
          body.versions['1.0.0'].dist.tarball.startsWith(registry),
          body.versions['1.0.0'].dist.tarball,
        );
        const abbreviated = await get('/remote-pkg', {
          ...ciBot,
          accept: 'application/vnd.npm.install-v1+json',
        });
        assert.match(
          abbreviated.headers.get('content-type'),
          /vnd\.npm\.install-v1\+json/,
        );
        assert.equal(requests.length, before, JSON.stringify(requests));
      },
    );

    await check(
      'a restricted read of a tarball the cached metadata names, but storage lacks, 404s without fetching it',
      async () => {
        const res = await get('/remote-pkg/-/remote-pkg-1.0.0.tgz', ciBot);
        assert.equal(res.status, 404);
        const head = await get(
          '/remote-pkg/-/remote-pkg-1.0.0.tgz',
          ciBot,
          'HEAD',
        );
        assert.equal(head.status, 404);
        assert.equal(uplinkHits('.tgz'), 0);
      },
    );

    await check(
      'once an online identity has fetched the tarball, a restricted read gets it from storage',
      async () => {
        const online = await get('/remote-pkg/-/remote-pkg-1.0.0.tgz', alice);
        assert.equal(online.status, 200);
        assert.equal(
          Buffer.from(await online.arrayBuffer()).toString(),
          REMOTE_TARBALL.toString(),
        );
        assert.equal(uplinkHits('.tgz'), 1);

        const restricted = await get(
          '/remote-pkg/-/remote-pkg-1.0.0.tgz',
          ciBot,
        );
        assert.equal(restricted.status, 200);
        assert.equal(
          Buffer.from(await restricted.arrayBuffer()).toString(),
          REMOTE_TARBALL.toString(),
        );
        assert.equal(uplinkHits('.tgz'), 1);
      },
    );

    await check(
      "a restricted publish still runs Verdaccio's uplink check for an existing name",
      async () => {
        const before = uplinkHits('GET /fresh-pkg');
        assert.equal(await publish(ciBot, 'fresh-pkg'), 201);
        assert.ok(
          uplinkHits('GET /fresh-pkg') > before,
          JSON.stringify(requests),
        );
      },
    );
  } finally {
    proc.kill();
    uplink.close();
    if (process.exitCode) {
      console.error('\n--- verdaccio output ---\n' + proc.getOutput());
    }
    fs.rmSync(work, {recursive: true, force: true});
  }

  console.log(`\n${passed} check(s) passed.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
