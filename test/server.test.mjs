import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, copyFileSync, appendFileSync, rmSync, symlinkSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env: ENV, encoding: 'utf8' }).trim();
const freePort = () => new Promise((ok) => { const s = createServer().listen(0, () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let tmp, home, root, app, origin, work, bin, port, proc, out = '';
const tokenFile = () => join(home, '.config', 'trees', 'token');

const raw = (method, path, { headers = {}, body } = {}) => new Promise((ok, no) => {
  const r = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: data }));
  });
  r.on('error', no);
  if (body) r.write(body);
  r.end();
});

const startServer = async () => {
  out = '';
  // Pretends to run under pm2, with a PATH that has no pm2, so a restart can never hit a real process.
  proc = spawn(process.execPath, [join(app, 'server.mjs')], {
    cwd: app, env: { ...ENV, HOME: home, PORT: String(port), TREES_HOST: 'trees.example.test', pm_id: '0', PATH: `${bin}:/usr/bin:/bin` },
  });
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 100 && !out.includes('trees:'); i++) await wait(50);
};
const stopServer = async () => {
  if (proc.exitCode === null) { proc.kill(); await new Promise((r) => proc.once('exit', r)); }
};
const alive = async () => (await raw('GET', '/')).status === 401;

const login = (host = `127.0.0.1:${port}`) => raw('POST', '/login', {
  headers: { host, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
  body: `token=${readFileSync(tokenFile(), 'utf8').trim()}`,
});
let cookie;
const authed = (method, path, opts = {}) => raw(method, path, { ...opts, headers: { cookie, ...opts.headers } });
const post = (path, body = {}, headers = {}) =>
  authed('POST', path, { headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, ...headers }, body: JSON.stringify(body) });

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'trees-'));
  home = join(tmp, 'home');
  root = join(tmp, 'root');
  origin = join(tmp, 'origin.git');
  app = join(root, 'trees');
  work = join(tmp, 'work');
  bin = join(tmp, 'bin');
  mkdirSync(bin);
  symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(bin, 'git'));
  mkdirSync(home);

  const seed = join(tmp, 'seed');
  mkdirSync(seed);
  for (const f of ['server.mjs', 'index.html', 'favicon.svg', 'package.json', '.gitignore']) copyFileSync(join(SRC, f), join(seed, f));
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'v1');
  git(tmp, 'clone', '-q', '--bare', seed, origin);
  git(tmp, 'clone', '-q', origin, app);
  git(tmp, 'clone', '-q', origin, work);

  mkdirSync(join(root, 'demo'));
  git(join(root, 'demo'), 'init', '-q', '-b', 'main');
  git(join(root, 'demo'), 'commit', '-q', '--allow-empty', '-m', 'init');

  port = await freePort();
  await startServer();
  cookie = (await login()).headers['set-cookie'][0].split(';')[0];
});

after(async () => {
  await stopServer();
  rmSync(tmp, { recursive: true, force: true });
});

test('creates a private 64-hex token file', () => {
  assert.match(readFileSync(tokenFile(), 'utf8').trim(), /^[0-9a-f]{64}$/);
  assert.equal(statSync(tokenFile()).mode & 0o777, 0o600);
});

test('never prints the token, only where to find it', () => {
  const token = readFileSync(tokenFile(), 'utf8').trim();
  assert.ok(!out.includes(token), out);
  assert.ok(out.includes(`http://127.0.0.1:${port}`), out);
  assert.ok(out.includes('https://trees.example.test'), out);
  assert.ok(out.includes(tokenFile()), out);
});

test('serves the favicon without a login, and both pages link it', async () => {
  const icon = await raw('GET', '/favicon.svg');
  assert.equal(icon.status, 200);
  assert.equal(icon.headers['content-type'], 'image/svg+xml');
  assert.match(icon.body, /^<svg /);
  assert.match((await raw('GET', '/')).body, /<link rel="icon" href="\/favicon\.svg"/);
  assert.match((await authed('GET', '/')).body, /<link rel="icon" href="\/favicon\.svg"/);
});

test('refuses requests without the login cookie', async () => {
  const page = await raw('GET', '/');
  assert.equal(page.status, 401);
  assert.match(page.body, /<form/);
  assert.match(page.body, /\.config\/trees\/token/);
  assert.equal((await raw('GET', '/api/repos')).status, 401);
});

test('rejects a wrong token and token-in-URL logins', async () => {
  const wrong = await raw('POST', '/login', {
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    body: `token=${'0'.repeat(64)}`,
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers['set-cookie'], undefined);
  const viaUrl = await raw('GET', `/login?token=${readFileSync(tokenFile(), 'utf8').trim()}`);
  assert.equal(viaUrl.headers['set-cookie'], undefined);
});

test('rejects a login posted from another site', async () => {
  const r = await raw('POST', '/login', {
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-site' },
    body: `token=${readFileSync(tokenFile(), 'utf8').trim()}`,
  });
  assert.equal(r.status, 403);
});

test('login sets a lax http-only cookie that is not the raw token', async () => {
  const r = await login();
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/');
  const c = r.headers['set-cookie'][0];
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.ok(!c.includes(readFileSync(tokenFile(), 'utf8').trim()));
  assert.equal((await authed('GET', '/api/repos')).status, 200);
});

test('a cookie from one host does not work on another', async () => {
  assert.equal((await authed('GET', '/api/repos', { headers: { host: 'trees.example.test' } })).status, 401);
  const devCookie = (await login('trees.example.test')).headers['set-cookie'][0].split(';')[0];
  assert.equal((await raw('GET', '/api/repos', { headers: { host: 'trees.example.test', cookie: devCookie } })).status, 200);
});

test('local logins get a short-lived random session, not a reusable derived one', async () => {
  const first = (await login()).headers['set-cookie'][0];
  const second = (await login()).headers['set-cookie'][0];
  assert.notEqual(first.split(';')[0], second.split(';')[0]);
  const maxAge = Number(first.match(/Max-Age=(\d+)/)[1]);
  assert.ok(maxAge <= 12 * 3600, first);
});

test('rejects unknown hosts', async () => {
  assert.equal((await authed('GET', '/api/repos', { headers: { host: 'evil.example' } })).status, 403);
});

test('a planted cookie with the same name does not lock the owner out', async () => {
  const name = cookie.split('=')[0];
  assert.equal((await raw('GET', '/api/repos', { headers: { cookie: `${name}=junk; ${cookie}` } })).status, 200);
});

test('lists repos in the folder above the tool, but not the tool itself', async () => {
  const names = JSON.parse((await authed('GET', '/api/repos')).body).map((r) => r.name);
  assert.ok(names.includes('demo'), names.join(','));
  assert.ok(!names.includes('trees'), names.join(','));
});

test('forbids framing, and keeps the origin for its own form posts', async () => {
  for (const r of [await raw('GET', '/'), await authed('GET', '/'), await authed('GET', '/api/repos')]) {
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.match(r.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
    assert.equal(r.headers['referrer-policy'], 'same-origin');
  }
});

test('rejects cross-site and malformed-origin requests without crashing', async () => {
  assert.equal((await post('/api/create', { repo: 'demo', branch: 'x' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/create', { repo: 'demo', branch: 'x' }, { origin: 'null' })).status, 403);
  assert.equal((await post('/api/create', { repo: 'demo', branch: 'x' }, { 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await authed('GET', '/api/repos', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.ok(await alive());
});

test('survives a malformed request path', async () => {
  await new Promise((ok) => {
    const s = connect(port, '127.0.0.1', () => s.end(`GET // HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`));
    s.on('data', () => {}); s.on('close', ok); s.on('error', ok);
  });
  await wait(200);
  assert.ok(await alive(), out);
});

test('only routes actions under /api/', async () => {
  assert.equal((await post('/zzzzcreate', { repo: 'demo', branch: 'x' })).status, 404);
});

test('create requires a branch name', async () => {
  assert.equal((await post('/api/create', { repo: 'demo' })).status, 400);
});

test('applies exactly the update that was shown, despite untracked files', async () => {
  assert.equal(JSON.parse((await authed('GET', '/api/version?refresh=1')).body).behind, 0);

  appendFileSync(join(work, 'index.html'), '\n<!-- v2 -->\n');
  git(work, 'commit', '-qam', 'Ship v2');
  git(work, 'push', '-q', 'origin', 'main');

  const pending = JSON.parse((await authed('GET', '/api/version?refresh=1')).body);
  assert.equal(pending.behind, 1);
  assert.equal(pending.canUpdate, true);
  assert.deepEqual(pending.commits.map((c) => c.subject), ['Ship v2']);

  appendFileSync(join(work, 'index.html'), '\n<!-- v3 -->\n');
  git(work, 'commit', '-qam', 'Ship v3');
  git(work, 'push', '-q', 'origin', 'main');

  writeFileSync(join(app, 'stray-untracked.txt'), 'x');
  const r = await post('/api/update', { to: pending.target });
  assert.equal(r.status, 200, r.body);
  assert.equal(JSON.parse(r.body).restart, false);
  assert.equal(git(app, 'rev-parse', 'HEAD'), pending.target);
  const page = (await authed('GET', '/')).body;
  assert.match(page, /<!-- v2 -->/);
  assert.doesNotMatch(page, /<!-- v3 -->/);
  assert.equal(JSON.parse((await authed('GET', '/api/version')).body).stale, false);
});

test('asks for a restart when server code was pulled outside the app', async () => {
  appendFileSync(join(work, 'server.mjs'), '\n// pulled\n');
  git(work, 'commit', '-qam', 'Server change');
  git(work, 'push', '-q', 'origin', 'main');
  git(app, 'pull', '-q', '--ff-only');
  assert.equal(JSON.parse((await authed('GET', '/api/version')).body).stale, true);
});

test('refuses an update target that is not on origin/main', async () => {
  assert.equal((await post('/api/update', { to: '0'.repeat(40) })).status, 409);
});

test('does not offer an update when the tool is not on main', async () => {
  appendFileSync(join(work, 'README.md'), 'more\n');
  git(work, 'add', 'README.md');
  git(work, 'commit', '-qm', 'Docs');
  git(work, 'push', '-q', 'origin', 'main');
  assert.equal(JSON.parse((await authed('GET', '/api/version?refresh=1')).body).canUpdate, true);
  git(app, 'switch', '-q', '-c', 'local-experiment');
  const v = JSON.parse((await authed('GET', '/api/version?refresh=1')).body);
  git(app, 'switch', '-q', 'main');
  assert.equal(v.canUpdate, false);
});

test('local sessions end when the tool restarts', async () => {
  await stopServer();
  await startServer();
  assert.equal((await authed('GET', '/api/repos')).status, 401);
  cookie = (await login()).headers['set-cookie'][0].split(';')[0];
});

test('regenerates an empty token file instead of opening up', async () => {
  await stopServer();
  writeFileSync(tokenFile(), '\n');
  await startServer();
  assert.equal((await raw('GET', '/api/repos')).status, 401);
  assert.match(readFileSync(tokenFile(), 'utf8').trim(), /^[0-9a-f]{64}$/);
});
