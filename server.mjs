import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.argv[2] ?? dirname(APP));
const PORT = Number(process.env.PORT ?? 7171);
const EDITOR = process.env.WT_UI_EDITOR ?? 'cursor';
const BRANCH = /^\w[\w./-]*$/;
const UNDER_PM2 = process.env.pm_id !== undefined;

const fail = (code, message) => Object.assign(new Error(message), { code });

const DEV_HOST = process.env.TREES_HOST || null;
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, DEV_HOST].filter(Boolean));

const TOKEN_FILE = join(homedir(), '.config', 'trees', 'token');
const loadToken = () => {
  const existing = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : '';
  if (/^[0-9a-f]{64}$/.test(existing)) {
    chmodSync(TOKEN_FILE, 0o600);
    return existing;
  }
  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  const temp = `${TOKEN_FILE}.${process.pid}`;
  writeFileSync(temp, token + '\n', { mode: 0o600 });
  renameSync(temp, TOKEN_FILE);
  return token;
};
const TOKEN = loadToken();

const same = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const sessionFor = (host) => createHmac('sha256', TOKEN).update(host).digest('hex');
// Browsers send 127.0.0.1 cookies to every local port, so local sessions are random, in memory and short-lived.
const LOCAL_TTL = 12 * 3600;
const localSessions = new Map();
const newLocalSession = (host) => {
  const id = randomBytes(32).toString('hex');
  localSessions.set(id, { host, expires: Date.now() + LOCAL_TTL * 1000 });
  return id;
};
const validLocal = (id, host) => {
  const s = localSessions.get(id);
  return Boolean(s && s.host === host && s.expires > Date.now());
};
const loggedIn = (req) => (req.headers.cookie ?? '').split(/;\s*/)
  .map((c) => c.split('='))
  .some(([name, value]) => name === '__Host-trees' ? same(value, sessionFor(req.headers.host)) : name === 'trees' && validLocal(value, req.headers.host));

const fromThisSite = (req) => {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  return !origin || (URL.canParse(origin) && new URL(origin).host === req.headers.host);
};

const run = (cmd, args, cwd, opts = {}) =>
  new Promise((ok, no) =>
    execFile(cmd, args, { cwd, maxBuffer: 1 << 24, ...opts }, (err, stdout, stderr) =>
      err ? no(new Error(err.code !== 'ENOENT' ? (stderr || err.message).trim() : cwd && !existsSync(cwd) ? `Folder not found: ${cwd}` : missing(cmd))) : ok(stdout)));

const missing = (cmd) => ({
  wt: 'Worktrunk (wt) is not installed. Install it with: brew install worktrunk',
  git: 'git is not installed.',
}[cmd] ?? `${cmd} is not installed or not on your PATH.`);

const isRepo = (dir) => stat(join(dir, '.git')).then((s) => s.isDirectory(), () => false);

const findRepos = async () => {
  if (await isRepo(ROOT)) return new Map([[basename(ROOT), ROOT]]);
  const dirs = (await readdir(ROOT, { withFileTypes: true }))
    .filter((d) => d.isDirectory()).map((d) => join(ROOT, d.name)).filter((d) => d !== APP);
  const flags = await Promise.all(dirs.map(isRepo));
  return new Map(dirs.filter((_, i) => flags[i]).map((d) => [basename(d), d]));
};
const REPOS = await findRepos();

const repoPath = (name) => {
  if (!REPOS.has(name)) throw fail(400, `unknown repo: ${name}`);
  return REPOS.get(name);
};

const list = async (repo, full) =>
  JSON.parse(await run('wt', ['list', '--format=json', ...(full ? ['--full'] : [])], repoPath(repo)));

const item = async (repo, key) => {
  const data = await list(repo, false);
  const it = data.items.find((i) => i.worktree && (i.branch === key || i.worktree.path === key));
  if (!it) throw fail(400, `no worktree: ${key}`);
  return { it, base: data.repo.default_branch, remote: data.repo.forge?.remote ?? 'origin' };
};

const lines = (s) => s.split('\n').filter(Boolean);

const detail = async (repo, key) => {
  const { it, base: local, remote } = await item(repo, key);
  const cwd = it.worktree.path;
  const git = (...a) => run('git', a, cwd).then(lines, () => []);
  // Local default branches are often stale; the remote one matches wt's ahead/behind numbers.
  const base = (await git('rev-parse', '--verify', '--quiet', `${remote}/${local}`)).length ? `${remote}/${local}` : local;
  const [commits, files, status] = await Promise.all([
    it.worktree.main ? [] : git('log', '--no-merges', '--format=%h%x09%s%x09%cI', `${base}..HEAD`),
    it.worktree.main ? [] : git('diff', '--numstat', `${base}...HEAD`),
    git('status', '--porcelain'),
  ]);
  return {
    path: cwd,
    commits: commits.map((l) => { const [sha, subject, when] = l.split('\t'); return { sha, subject, when }; }),
    files: files.map((l) => { const [added, deleted, file] = l.split('\t'); return { added, deleted, file }; }),
    uncommitted: status.map((l) => ({ code: l.slice(0, 2).trim(), file: l.slice(3) })),
  };
};

const wt = (repo, ...args) => run('wt', args, repoPath(repo));

const actions = {
  create: ({ repo, branch, base }) => {
    for (const b of [branch, base ?? 'main'])
      if (typeof b !== 'string' || !BRANCH.test(b)) throw fail(400, `bad branch: ${b}`);
    return wt(repo, 'switch', '--create', '--no-cd', ...(base ? ['--base', base] : []), branch);
  },
  merge: async ({ repo, key }) => {
    const { it } = await item(repo, key);
    if (!it.branch) throw fail(400, 'Detached worktrees have no branch to merge');
    return wt(repo, 'merge', '--branch', it.branch);
  },
  remove: async ({ repo, key, force }) =>
    wt(repo, 'remove', '--foreground', ...(force ? ['--force', '--force-delete'] : []), (await item(repo, key)).it.worktree.path),
  move: async ({ repo, key }) => {
    const { it, base } = await item(repo, key);
    const branch = it.branch;
    if (!it.worktree.main || !branch || branch === base)
      throw fail(400, `Only the main checkout on a branch other than ${base} can be moved`);
    const main = it.worktree.path;
    const git = (cwd, ...a) => run('git', a, cwd);
    const label = `trees: move ${branch}`;
    const safe = (e, next) => new Error(`${e.message}\n\nYour uncommitted changes are safe in the stash "${label}". ${next}`);

    let stash = null;
    if ((await git(main, 'status', '--porcelain')).trim()) {
      await git(main, 'stash', 'push', '--include-untracked', '-m', label);
      stash = (await git(main, 'rev-parse', 'stash@{0}')).trim();
    }
    try {
      await git(main, 'switch', base);
    } catch (e) {
      if (stash) await git(main, 'stash', 'pop').catch(() => { throw safe(e, 'Run git stash pop in the main checkout.'); });
      throw e;
    }
    try {
      await wt(repo, 'switch', '--no-cd', branch);
    } catch (e) {
      throw stash ? safe(e, `Run wt switch ${branch}, then git stash pop there.`) : e;
    }
    if (!stash) return '';
    const path = (await item(repo, branch)).it.worktree.path;
    if ((await git(path, 'rev-parse', 'stash@{0}')).trim() !== stash)
      throw safe(new Error('Another stash was added while moving'), `Apply it in ${path}.`);
    try {
      await git(path, 'stash', 'pop');
    } catch (e) {
      throw safe(e, `Resolve the conflicts in ${path}, then run git stash drop.`);
    }
    return '';
  },
  reset: async ({ repo, key }) => {
    const { it, base } = await item(repo, key);
    if (!it.worktree.main) throw fail(400, 'Only the main checkout can be reset');
    const main = it.worktree.path;
    const git = (...a) => run('git', a, main);
    let stashed = false;
    if ((await git('status', '--porcelain')).trim()) {
      await git('stash', 'push', '--include-untracked', '-m', `trees: set aside on ${it.branch ?? 'detached HEAD'}`);
      stashed = true;
    }
    if (it.branch === base) return '';
    try {
      await git('switch', base);
    } catch (e) {
      if (stashed) await git('stash', 'pop').catch(() => {
        throw new Error(`${e.message}\n\nYour changes are safe in the stash. Run git stash pop in the main checkout.`);
      });
      throw e;
    }
    return '';
  },
  terminal: async ({ repo, key }) => run('open', ['-a', 'Terminal', (await item(repo, key)).it.worktree.path]),
  editor: async ({ repo, key }) => run(EDITOR, [(await item(repo, key)).it.worktree.path]),
};

const health = async (name) => {
  const { items } = await list(name, true);
  const conflicts = items.filter((i) => i.worktree && (i.worktree.changes?.conflicted || i.default_branch?.merge_conflicts)).length;
  const failing = items.filter((i) => i.worktree && ['failed', 'error'].includes(i.checks?.status)).length;
  return { name, conflicts, failing };
};

const appGit = (...args) => run('git', args, APP, { timeout: 30e3, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const BOOT_ID = randomBytes(8).toString('hex');
const BOOT_HEAD = await appGit('rev-parse', 'HEAD').then((s) => s.trim(), () => null);
let running = 0;
let updating = false;
let fetching = null;
let fetchedAt = 0;

const fetchOrigin = () => (fetching ??= appGit('fetch', '--quiet', 'origin', 'main')
  .then(() => { fetchedAt = Date.now(); })
  .finally(() => { fetching = null; }));

const needsRestart = (files) => files.some((f) => f !== 'index.html' && !f.endsWith('.md') && !f.startsWith('test/'));
const changedSince = async (sha) => lines(await appGit('diff', '--name-only', sha, 'HEAD'));

const isAncestor = (a, b) => appGit('merge-base', '--is-ancestor', a, b).then(() => true, () => false);

const version = async (refresh) => {
  if (refresh || Date.now() - fetchedAt > 30 * 60e3) await fetchOrigin().catch(() => {});
  try {
    const [branch, head, target, log] = await Promise.all([
      appGit('branch', '--show-current'),
      appGit('rev-parse', 'HEAD'),
      appGit('rev-parse', 'origin/main'),
      appGit('log', '--format=%h%x09%s', 'HEAD..origin/main'),
    ]);
    const commits = lines(log).map((l) => { const [sha, subject] = l.split('\t'); return { sha, subject }; });
    const canUpdate = branch.trim() === 'main' && commits.length > 0 && await isAncestor('HEAD', 'origin/main');
    const stale = UNDER_PM2 && Boolean(BOOT_HEAD) && head.trim() !== BOOT_HEAD && needsRestart(await changedSince(BOOT_HEAD));
    return { boot: BOOT_ID, behind: commits.length, commits, target: target.trim(), canUpdate, stale };
  } catch {
    return { boot: BOOT_ID, behind: 0, commits: [], target: null, canUpdate: false, stale: false };
  }
};

const update = async ({ to }) => {
  if (running) throw fail(409, 'Wait until the running action finishes, then update.');
  if (updating) throw fail(409, 'An update is already running.');
  updating = true;
  let result;
  try {
    result = { ...(await applyUpdate(to)), boot: BOOT_ID };
    return result;
  } finally {
    updating = Boolean(result?.auto);
  }
};

const applyUpdate = async (to) => {
  if (!to) {
    if (!(await version(false)).stale) throw fail(409, 'Nothing to update.');
    return { restart: true, auto: true };
  }
  if (typeof to !== 'string' || !/^[0-9a-f]{40}$/.test(to)) throw fail(400, 'bad update target');
  const branch = (await appGit('branch', '--show-current')).trim();
  if (branch !== 'main') throw fail(409, `The tool is on branch ${branch || '(detached)'}, not main, so it can't update itself.`);
  await fetchOrigin().catch(() => {});
  if (!(await isAncestor(to, 'origin/main')) || !(await isAncestor('HEAD', to)))
    throw fail(409, 'That update is no longer available. Reload and try again.');
  await appGit('merge', '--ff-only', to);
  const restart = Boolean(BOOT_HEAD) && needsRestart(await changedSince(BOOT_HEAD));
  return { restart, auto: restart && UNDER_PM2 };
};

const restartSelf = () =>
  spawn('pm2', ['restart', String(process.env.pm_id), '--update-env'], { detached: true, stdio: 'ignore' })
    .on('error', (e) => { updating = false; console.error(`restart failed: ${e.message}`); })
    .on('exit', (code) => { if (code) { updating = false; console.error(`restart failed: pm2 exited with ${code}`); } })
    .unref();

const worktreeCount = async (path) =>
  (await run('git', ['worktree', 'list', '--porcelain'], path).catch(() => '')).split('\n').filter((l) => l.startsWith('worktree ')).length - 1;

const SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'referrer-policy': 'same-origin',
  'cache-control': 'no-store',
};

const send = (res, code, body, type = 'application/json', headers = {}) => {
  res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': type, ...headers });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const loginPage = (error) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Trees</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1c1b19;background:#f6f6f4}
@media(prefers-color-scheme:dark){body{color:#e8e6e1;background:#121211}input{background:#1b1b19;color:inherit;border-color:#2c2b28}}
h1{font-size:18px}code{font-size:13px}form{display:flex;gap:8px;margin-top:16px}
input{flex:1;font:inherit;padding:8px 10px;border:1px solid #e2e0db;border-radius:6px}
button{font:inherit;font-weight:550;padding:8px 14px;border:0;border-radius:6px;background:#2f5bd3;color:#fff;cursor:pointer}
.err{color:#b91c1c}
</style>
<h1>Log in to Trees</h1>
<p>This tool can change the git repos on this machine, so it only answers to its owner. Paste your token, which you can copy with:</p>
<p><code>pbcopy &lt; ${esc(TOKEN_FILE)}</code></p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/login"><input type="password" name="token" aria-label="Token" autocomplete="off" autofocus required><button>Log in</button></form>`;

const readBody = async (req, limit) => {
  let s = '';
  for await (const c of req) if ((s += c).length > limit) throw fail(413, 'request too large');
  return s;
};

const handle = async (req, res) => {
  // Host check blocks DNS rebinding; the session cookie keeps out other people on the network envoy is open to.
  if (!HOSTS.has(req.headers.host)) return send(res, 403, { error: 'bad host' });
  if (!URL.canParse(req.url, 'http://x')) return send(res, 400, { error: 'bad request' });
  const url = new URL(req.url, 'http://x');
  const q = Object.fromEntries(url.searchParams);
  const api = url.pathname.startsWith('/api/');
  if (req.method === 'GET' && url.pathname === '/favicon.svg')
    return send(res, 200, await readFile(new URL('favicon.svg', import.meta.url)), 'image/svg+xml', { 'cache-control': 'max-age=86400' });

  if ((api || req.method !== 'GET') && !fromThisSite(req)) return send(res, 403, { error: 'cross-site request' });

  if (url.pathname === '/login' && req.method === 'POST') {
    if (!same(new URLSearchParams(await readBody(req, 4096)).get('token')?.trim(), TOKEN))
      return send(res, 401, loginPage("That token didn't match."), 'text/html');
    const cookie = req.headers['x-forwarded-proto'] === 'https'
      ? `__Host-trees=${sessionFor(req.headers.host)}; Max-Age=31536000; Secure`
      : `trees=${newLocalSession(req.headers.host)}; Max-Age=${LOCAL_TTL}`;
    return send(res, 303, '', 'text/plain', { location: '/', 'set-cookie': `${cookie}; HttpOnly; SameSite=Lax; Path=/` });
  }
  if (!loggedIn(req)) return api ? send(res, 401, { error: 'Log in first: reload the page.' }) : send(res, 401, loginPage(), 'text/html');
  if (req.method !== 'GET' && req.headers['content-type'] !== 'application/json') return send(res, 415, { error: 'json only' });

  if (req.method === 'GET') {
    if (url.pathname === '/') return send(res, 200, await readFile(new URL('index.html', import.meta.url)), 'text/html');
    if (url.pathname === '/api/repos')
      return send(res, 200, await Promise.all([...REPOS].map(async ([name, path]) => ({ name, worktrees: await worktreeCount(path) }))));
    if (url.pathname === '/api/health') {
      const names = (q.repos ?? '').split(',').filter((n) => REPOS.has(n));
      return send(res, 200, await Promise.all(names.map((n) => health(n).catch(() => ({ name: n, conflicts: 0, failing: 0 })))));
    }
    if (url.pathname === '/api/list') return send(res, 200, await list(q.repo, 'full' in q));
    if (url.pathname === '/api/detail') return send(res, 200, await detail(q.repo, q.key));
    if (url.pathname === '/api/version') return send(res, 200, await version('refresh' in q));
  }
  if (req.method === 'POST' && url.pathname === '/api/update') {
    const result = await update(JSON.parse(await readBody(req, 1 << 16) || '{}'));
    send(res, 200, result);
    if (result.auto) restartSelf();
    return;
  }
  const name = api ? url.pathname.slice('/api/'.length) : null;
  if (req.method === 'POST' && Object.hasOwn(actions, name)) {
    const body = JSON.parse(await readBody(req, 1 << 16) || '{}');
    if (updating) throw fail(409, 'Wait until the update finishes.');
    running++;
    try {
      return send(res, 200, { output: await actions[name](body) });
    } finally {
      running--;
    }
  }
  send(res, 404, { error: 'not found' });
};

createServer((req, res) => handle(req, res).catch((e) => {
  if (res.headersSent) return res.end();
  send(res, [400, 409, 413].includes(e.code) ? e.code : e instanceof SyntaxError ? 400 : 500, { error: e.message });
})).listen(PORT, '127.0.0.1', () => {
  console.log(`trees: ${REPOS.size} repos under ${ROOT}`);
  console.log(`open: http://127.0.0.1:${PORT}${DEV_HOST ? `  or  https://${DEV_HOST}` : ''}`);
  console.log(`login token: ${TOKEN_FILE}  (copy it with: pbcopy < ${TOKEN_FILE})`);
});
