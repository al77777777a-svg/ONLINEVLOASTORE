'use strict';

// Run with:  npm test      (or: node --test test/)
// These tests start the real dashboard server on a random port in demo mode (a pretend Railway
// that lives in memory), so they never touch your real bots and need no internet.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, parseEnv, writeEnv, isConfigured } = require('../lib/config');
const { createApp } = require('../server');
const { createDemo } = require('../lib/demo');
const { createRailway } = require('../lib/railway');
const { validateSettings, stripAnsi, normalizeSeverity } = require('../lib/bots');
const D = require('../lib/documents');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vola-test-'));
process.on('exit', () => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// ---------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------

async function startApp({ env = {}, argv = ['--demo'], transport } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'app-'));
  const envPath = path.join(dir, '.env');
  const dataDir = path.join(dir, 'data');
  const merged = { DEMO_SPEED: '100', DATA_DIR: dataDir, ...env };
  const cfg = loadConfig({ argv, env: merged, envPath });
  const app = createApp(cfg, { env: merged, argv, transport });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    base,
    envPath,
    dataDir,
    close: () =>
      new Promise((resolve) => {
        app.close();
        if (server.closeAllConnections) server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function client(base) {
  let cookie = '';
  async function call(method, url, body, { headers = {}, auth = true } = {}) {
    const h = { 'X-Requested-With': 'vola', ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (auth && cookie) h.Cookie = cookie;
    const res = await fetch(base + url, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie()) {
      if (c.startsWith('vc_sid=')) {
        const pair = c.split(';')[0];
        cookie = pair === 'vc_sid=' ? '' : pair;
      }
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, text, headers: res.headers };
  }
  return {
    call,
    get: (u, o) => call('GET', u, undefined, o),
    post: (u, b, o) => call('POST', u, b ?? {}, o),
    put: (u, b, o) => call('PUT', u, b ?? {}, o),
    patch: (u, b, o) => call('PATCH', u, b ?? {}, o),
    get cookie() {
      return cookie;
    },
  };
}

/** A raw HTTP request, so tests can send headers (Host, Origin) that fetch would not let them set. */
function raw(base, method, urlPath, headers = {}, body) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, method, path: urlPath, headers: { ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitFor(fn, { timeout = 5000, every = 40 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('Timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, every));
  }
}

const botByName = async (c, name) => (await c.get('/api/overview?force=1')).json.bots.find((b) => b.name === name);
const settled = async (c) => (await c.get('/api/overview?force=1')).json.bots.every((b) => !b.deployment || !b.deployment.inFlight);

// ---------------------------------------------------------------------------------------
// the dashboard, end to end, in demo mode
// ---------------------------------------------------------------------------------------

describe('dashboard in demo mode', () => {
  let ctx;
  let c;

  before(async () => {
    ctx = await startApp();
    c = client(ctx.base);
  });
  after(async () => {
    await ctx.close();
  });

  test('is locked until you sign in', async () => {
    const s = await c.get('/api/session');
    assert.equal(s.status, 200);
    assert.equal(s.json.authenticated, false);
    assert.equal(s.json.demo, true);
    assert.equal(s.json.demoHint, 'demo');
    for (const p of ['/api/overview', '/api/activity', '/api/diagnostics']) {
      assert.equal((await c.get(p)).status, 401, p);
    }
    assert.equal((await c.post('/api/bulk', { action: 'restart' })).status, 401);
  });

  test('rejects a wrong password and accepts the right one', async () => {
    assert.equal((await c.post('/api/login', { password: 'nope' })).status, 401);
    assert.equal((await c.post('/api/login', {})).status, 401);
    const good = await c.post('/api/login', { password: 'demo' });
    assert.equal(good.status, 200);
    const cookie = good.headers.getSetCookie()[0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal((await c.get('/api/session')).json.authenticated, true);
  });

  test('serves the web page with strict security headers and blocks path tricks', async () => {
    const index = await raw(ctx.base, 'GET', '/');
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /text\/html/);
    assert.match(index.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(index.headers['x-content-type-options'], 'nosniff');
    assert.equal(index.headers['x-frame-options'], 'DENY');
    for (const p of ['/.env', '/%2e%2e/server.js', '/..%2fserver.js', '/lib/../../.env', '/data/activity.jsonl', '/package.json', '/server.js']) {
      assert.equal((await raw(ctx.base, 'GET', p)).status, 404, p);
    }
  });

  test('refuses foreign host names, cross-site writes and writes without the dashboard header', async () => {
    assert.equal((await raw(ctx.base, 'GET', '/api/session', { Host: 'evil.example' })).status, 421);

    const common = { Cookie: c.cookie, 'X-Requested-With': 'vola', 'Content-Type': 'application/json' };
    const body = '{"action":"restart"}';
    assert.equal((await raw(ctx.base, 'POST', '/api/bulk', { ...common, Origin: 'https://evil.example' }, body)).status, 403);
    assert.equal((await raw(ctx.base, 'POST', '/api/bulk', { ...common, 'Sec-Fetch-Site': 'cross-site' }, body)).status, 403);
    const noHeader = { Cookie: c.cookie, 'Content-Type': 'application/json' };
    assert.equal((await raw(ctx.base, 'POST', '/api/bulk', noHeader, body)).status, 403);
  });

  test('survives an oversized request', async () => {
    const big = JSON.stringify({ text: 'x'.repeat(600 * 1024) });
    try {
      const r = await c.post('/api/bots/svc-bc/variables/import', JSON.parse(big));
      assert.equal(r.status, 413);
    } catch {
      /* the connection may be cut while the body is still being sent, which is fine */
    }
    assert.equal((await c.get('/api/session')).status, 200);
  });

  test('lists the five bots with sensible states and abilities', async () => {
    const r = await c.get('/api/overview');
    assert.equal(r.status, 200);
    const names = r.json.bots.map((b) => b.name);
    assert.deepEqual(
      [...names].sort(),
      ['VOLA-STORE-Welcome', 'bc', 'reaicovola', 'vola-store-payment', 'vola-store-ticket'].sort(),
    );
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
    const by = Object.fromEntries(r.json.bots.map((b) => [b.name, b]));
    assert.equal(by.bc.state, 'crashed');
    assert.equal(by.bc.capabilities.start, true);
    assert.equal(by.bc.capabilities.stop, true);
    assert.equal(by['vola-store-payment'].state, 'online');
    assert.equal(by['vola-store-payment'].label, 'Online');
    assert.equal(by['vola-store-payment'].capabilities.start, false);
    assert.equal(by['vola-store-payment'].capabilities.restart, true);
    assert.equal(by['vola-store-payment'].source.type, 'github');
    assert.deepEqual(by['vola-store-payment'].domains, ['vola-store-payment-production.up.railway.app']);
    assert.equal(by['vola-store-payment'].deployment.commit.message, 'Retry failed webhook deliveries');
    assert.equal(by['vola-store-ticket'].volumes[0].name, 'vola-store-ticket-volume');
    assert.equal(by['vola-store-ticket'].volumes[0].mountPath, '/data');
    assert.equal(r.json.project.name, 'VOLA STORE (demo)');
    assert.equal(r.json.environment.name, 'production');
    assert.equal(r.json.pollSeconds, 30);
    assert.equal(r.json.demo, true);
    assert.equal(r.json.stale, false);
    assert.ok(r.json.rate.limit > r.json.rate.remaining);
  });

  test('overview is cached briefly, unless you ask for a fresh answer', async () => {
    const a = await c.get('/api/overview?force=1');
    const cached = await c.get('/api/overview');
    assert.equal(cached.json.fetchedAt, a.json.fetchedAt, 'a normal request reuses the recent answer');
    await new Promise((resolve) => setTimeout(resolve, 15));
    const fresh = await c.get('/api/overview?maxAge=0');
    assert.notEqual(fresh.json.fetchedAt, a.json.fetchedAt, 'maxAge=0 asks Railway again');
    const tolerant = await c.get('/api/overview?maxAge=30');
    assert.equal(tolerant.json.fetchedAt, fresh.json.fetchedAt, 'maxAge=30 accepts the recent answer');
    assert.equal((await c.get('/api/overview?maxAge=banana')).status, 200);
  });

  test('restart: a running bot restarts and comes back online', async () => {
    const bot = await botByName(c, 'vola-store-payment');
    const r = await c.post(`/api/bots/${bot.id}/actions/restart`);
    assert.equal(r.status, 200);
    assert.equal(r.json.method, 'restart');
    assert.match(r.json.message, /restarting/);
    await waitFor(async () => (await botByName(c, 'vola-store-payment')).state === 'online');
  });

  test('stop takes a bot offline and start brings it back', async () => {
    const bot = await botByName(c, 'reaicovola');
    assert.equal((await c.post(`/api/bots/${bot.id}/actions/stop`)).status, 200);
    const stopped = await botByName(c, 'reaicovola');
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.capabilities.start, true);
    assert.equal(stopped.capabilities.stop, false);
    assert.equal(stopped.capabilities.restart, false);

    const start = await c.post(`/api/bots/${bot.id}/actions/start`);
    assert.equal(start.status, 200);
    assert.equal(start.json.method, 'start');
    await waitFor(async () => (await botByName(c, 'reaicovola')).state === 'online');
  });

  test('restarting a crashed bot falls back to a redeploy', async () => {
    const bot = await botByName(c, 'bc');
    const r = await c.post(`/api/bots/${bot.id}/actions/restart`);
    assert.equal(r.status, 200);
    assert.equal(r.json.method, 'redeploy');
    assert.match(r.json.message, /redeployed instead/);
    await waitFor(async () => (await botByName(c, 'bc')).state === 'crashed'); // the bad token crashes it again
  });

  test('fixing the bad token and saving with redeploy brings bc online', async () => {
    const bot = await botByName(c, 'bc');
    const set = await c.put(`/api/bots/${bot.id}/variables`, { name: 'DISCORD_TOKEN', value: 'demo_fixed_value', redeploy: true });
    assert.equal(set.status, 200);
    assert.equal(set.json.redeployed, true);
    await waitFor(async () => (await botByName(c, 'bc')).state === 'online');
  });

  test('deploy-latest, unknown actions and unknown bots', async () => {
    await waitFor(() => settled(c));
    const bot = await botByName(c, 'vola-store-ticket');
    const d = await c.post(`/api/bots/${bot.id}/actions/deploy-latest`);
    assert.equal(d.status, 200);
    assert.equal(d.json.method, 'deploy-latest');
    assert.equal((await c.post(`/api/bots/${bot.id}/actions/explode`)).status, 400);
    assert.equal((await c.post('/api/bots/not-a-bot/actions/restart')).status, 404);
    assert.equal((await c.post('/api/bots/..%2f..%2fetc/actions/restart')).status, 404);
    await waitFor(() => settled(c));
  });

  test('two actions at once on the same bot do not trip over each other', async () => {
    const bot = await botByName(c, 'vola-store-payment');
    const [a, b] = await Promise.all([
      c.post(`/api/bots/${bot.id}/actions/restart`),
      c.post(`/api/bots/${bot.id}/actions/restart`),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.ok(statuses.includes(200));
    assert.ok(statuses.every((s) => s === 200 || s === 409), `got ${statuses}`);
    await waitFor(() => settled(c));
  });

  test('bulk actions skip bots that have nothing to do and report each bot', async () => {
    const stopBot = await botByName(c, 'reaicovola');
    await c.post(`/api/bots/${stopBot.id}/actions/stop`);
    const r = await c.post('/api/bulk', { action: 'restart' });
    assert.equal(r.status, 200);
    assert.equal(r.json.results.length, 5);
    const by = Object.fromEntries(r.json.results.map((x) => [x.name, x]));
    assert.equal(by.reaicovola.skipped, true);
    assert.equal(by['vola-store-payment'].ok, true);
    assert.equal(by['vola-store-payment'].skipped, undefined);
    await waitFor(() => settled(c));

    const only = await c.post('/api/bulk', { action: 'start', ids: [stopBot.id] });
    assert.equal(only.json.results.length, 1);
    assert.equal(only.json.results[0].ok, true);
    await waitFor(async () => (await botByName(c, 'reaicovola')).state === 'online');

    assert.equal((await c.post('/api/bulk', { action: 'delete-everything' })).status, 400);
  });

  test('lists deployments and manages them safely', async () => {
    await waitFor(() => settled(c));
    const bot = await botByName(c, 'vola-store-ticket');
    const list = await c.get(`/api/bots/${bot.id}/deployments`);
    assert.equal(list.status, 200);
    const deps = list.json.deployments;
    assert.ok(deps.length >= 3);
    assert.equal(deps.filter((d) => d.isActive).length, 1);

    const running = deps.find((d) => d.isActive);
    assert.equal((await c.post(`/api/bots/${bot.id}/actions/cancel`, { deploymentId: running.id })).status, 409);
    assert.equal((await c.post(`/api/bots/${bot.id}/actions/cancel`, {})).status, 400);
    const foreign = '00000000-0000-0000-0000-000000000000';
    assert.equal((await c.post(`/api/bots/${bot.id}/actions/remove`, { deploymentId: foreign })).status, 404);
    assert.equal((await c.post(`/api/bots/${bot.id}/actions/rollback`, { deploymentId: running.id })).status, 409);

    const older = deps.filter((d) => d.canRollback && !d.isActive);
    assert.ok(older.length >= 2);
    const rb = await c.post(`/api/bots/${bot.id}/actions/rollback`, { deploymentId: older[0].id });
    assert.equal(rb.status, 200);
    await waitFor(() => settled(c));

    const victim = older[older.length - 1];
    assert.equal((await c.post(`/api/bots/${bot.id}/actions/remove`, { deploymentId: victim.id })).status, 200);
    const after = (await c.get(`/api/bots/${bot.id}/deployments`)).json.deployments;
    assert.ok(!after.some((d) => d.id === victim.id));
  });

  test('shows runtime and build logs and limits how many lines come back', async () => {
    const bot = await botByName(c, 'vola-store-payment');
    const run = await c.get(`/api/bots/${bot.id}/logs?limit=50`);
    assert.equal(run.status, 200);
    assert.ok(run.json.lines.length > 0);
    assert.equal(run.json.kind, 'deploy');
    for (const l of run.json.lines) {
      assert.ok(['info', 'warn', 'error', 'debug'].includes(l.severity));
      assert.equal(typeof l.message, 'string');
      assert.ok(!Number.isNaN(Date.parse(l.ts)));
    }
    const sorted = [...run.json.lines].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    assert.deepEqual(run.json.lines, sorted);

    const build = await c.get(`/api/bots/${bot.id}/logs?kind=build`);
    assert.equal(build.json.kind, 'build');
    assert.ok(build.json.lines.some((l) => /Railpack/.test(l.message)));

    assert.ok((await c.get(`/api/bots/${bot.id}/logs?limit=1`)).json.lines.length <= 10);
    assert.ok((await c.get(`/api/bots/${bot.id}/logs?limit=999999`)).json.lines.length <= 1000);
    assert.equal((await c.get(`/api/bots/${bot.id}/logs?deploymentId=11111111-1111-1111-1111-111111111111`)).status, 404);

    const crashed = await botByName(c, 'vola-store-payment');
    assert.ok(crashed);
  });

  test('variables: the list never carries values, reveal gives only what is asked for', async () => {
    const bot = await botByName(c, 'vola-store-payment');
    const r = await c.get(`/api/bots/${bot.id}/variables`);
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.json.variables.map((v) => v.name),
      ['DATABASE_URL', 'DISCORD_TOKEN', 'GUILD_ID', 'LOG_LEVEL', 'NODE_ENV'],
    );
    assert.ok(!r.text.includes('demo_token_not_a_real_secret'));
    assert.ok(!r.text.includes('production'));
    const kinds = Object.fromEntries(r.json.variables.map((v) => [v.name, v.kind]));
    assert.equal(kinds.DATABASE_URL, 'reference');
    assert.equal(kinds.DISCORD_TOKEN, 'plain');
    assert.ok(r.json.variables.find((v) => v.name === 'DISCORD_TOKEN').length > 10);

    const one = await c.post(`/api/bots/${bot.id}/variables/reveal`, { names: ['LOG_LEVEL'] });
    assert.deepEqual(one.json.values, { LOG_LEVEL: 'info' });
    const all = await c.post(`/api/bots/${bot.id}/variables/reveal`, {});
    assert.equal(Object.keys(all.json.values).length, 5);
    const nothing = await c.post(`/api/bots/${bot.id}/variables/reveal`, { names: ['NOPE', '__proto__', 'constructor'] });
    assert.deepEqual(nothing.json.values, {});

    const rendered = await c.get(`/api/bots/${bot.id}/variables?rendered=1`);
    const rk = Object.fromEntries(rendered.json.variables.map((v) => [v.name, v.kind]));
    assert.equal(rk.RAILWAY_SERVICE_NAME, 'railway');
    assert.equal(rk.DATABASE_URL, 'plain'); // references are resolved in the rendered view
  });

  test('variables: add, change and delete, with and without a redeploy', async () => {
    await waitFor(() => settled(c));
    const bot = await botByName(c, 'vola-store-welcome'.replace('welcome', 'Welcome').replace('vola-store-', 'VOLA-STORE-'));
    const count = async () => (await c.get(`/api/bots/${bot.id}/deployments`)).json.deployments.length;
    const before = await count();

    const add = await c.put(`/api/bots/${bot.id}/variables`, { name: 'NEW_ONE', value: 'hello', redeploy: false });
    assert.equal(add.status, 200);
    assert.equal(add.json.redeployed, false);
    assert.equal(await count(), before, 'no new deployment without redeploy');
    assert.deepEqual((await c.post(`/api/bots/${bot.id}/variables/reveal`, { names: ['NEW_ONE'] })).json.values, { NEW_ONE: 'hello' });

    await c.put(`/api/bots/${bot.id}/variables`, { name: 'NEW_ONE', value: 'changed', redeploy: true });
    assert.equal(await count(), before + 1, 'a redeploy was started');
    assert.deepEqual((await c.post(`/api/bots/${bot.id}/variables/reveal`, { names: ['NEW_ONE'] })).json.values, { NEW_ONE: 'changed' });
    await waitFor(() => settled(c));

    const del = await c.post(`/api/bots/${bot.id}/variables/delete`, { name: 'NEW_ONE', redeploy: false });
    assert.equal(del.status, 200);
    const names = (await c.get(`/api/bots/${bot.id}/variables`)).json.variables.map((v) => v.name);
    assert.ok(!names.includes('NEW_ONE'));
    assert.equal((await c.post(`/api/bots/${bot.id}/variables/delete`, { name: 'NEW_ONE', redeploy: false })).status, 502);
  });

  test('variables: bad input is refused and Railway errors are explained', async () => {
    const bot = await botByName(c, 'bc');
    for (const name of ['1ABC', 'has space', '', 'a-b', 'x'.repeat(300), null, 42]) {
      const r = await c.put(`/api/bots/${bot.id}/variables`, { name, value: 'x' });
      assert.equal(r.status, 400, `name ${JSON.stringify(name)}`);
    }
    assert.equal((await c.put(`/api/bots/${bot.id}/variables`, { name: 'OK_NAME', value: 42 })).status, 400);
    assert.equal((await c.put(`/api/bots/${bot.id}/variables`, { name: 'OK_NAME', value: 'x'.repeat(40000) })).status, 400);

    const fail = await c.put(`/api/bots/${bot.id}/variables`, { name: 'FAIL_ME', value: 'x' });
    assert.equal(fail.status, 502);
    assert.equal(fail.json.error.kind, 'railway');
    assert.match(fail.json.error.message, /simulated Railway error/);
  });

  test('variables: import .env text without ever deleting anything', async () => {
    const bot = await botByName(c, 'bc');
    const before = (await c.get(`/api/bots/${bot.id}/variables`)).json.count;
    const text = ['# a comment', 'export A_ONE=1', 'B_TWO="two words"', "C_THREE='3'", '', 'NODE_ENV=staging'].join('\n');
    const r = await c.post(`/api/bots/${bot.id}/variables/import`, { text, redeploy: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.count, 4);
    const after = await c.get(`/api/bots/${bot.id}/variables`);
    assert.equal(after.json.count, before + 3); // NODE_ENV already existed, nothing was removed
    const vals = (await c.post(`/api/bots/${bot.id}/variables/reveal`, { names: ['A_ONE', 'B_TWO', 'C_THREE', 'NODE_ENV'] })).json.values;
    assert.deepEqual(vals, { A_ONE: '1', B_TWO: 'two words', C_THREE: '3', NODE_ENV: 'staging' });

    assert.equal((await c.post(`/api/bots/${bot.id}/variables/import`, { text: '   ' })).status, 400);
    assert.equal((await c.post(`/api/bots/${bot.id}/variables/import`, { text: 'just words, no equals' })).status, 400);
    assert.equal((await c.post(`/api/bots/${bot.id}/variables/import`, { text: '1BAD=x' })).status, 400);
  });

  test('settings: read, change, clear and refuse nonsense', async () => {
    await waitFor(() => settled(c));
    const bot = await botByName(c, 'vola-store-payment');
    const read = await c.get(`/api/bots/${bot.id}/settings`);
    assert.equal(read.status, 200);
    assert.equal(read.json.settings.startCommand, 'node src/index.js');
    assert.equal(read.json.settings.restartPolicyType, 'ON_FAILURE');
    assert.equal(read.json.settings.numReplicas, 1);

    const patch = await c.patch(`/api/bots/${bot.id}/settings`, {
      changes: { startCommand: '  node src/main.js  ', numReplicas: '2', restartPolicyType: 'ALWAYS', sleepApplication: true },
    });
    assert.equal(patch.status, 200);
    assert.deepEqual(patch.json.applied.sort(), ['numReplicas', 'restartPolicyType', 'sleepApplication', 'startCommand']);
    assert.equal(patch.json.redeployed, false);
    const again = (await c.get(`/api/bots/${bot.id}/settings`)).json.settings;
    assert.equal(again.startCommand, 'node src/main.js');
    assert.equal(again.numReplicas, 2);
    assert.equal(again.restartPolicyType, 'ALWAYS');
    assert.equal(again.sleepApplication, true);

    const cleared = await c.patch(`/api/bots/${bot.id}/settings`, { changes: { startCommand: '' }, redeploy: true });
    assert.equal(cleared.json.redeployed, true);
    assert.equal((await c.get(`/api/bots/${bot.id}/settings`)).json.settings.startCommand, '');
    await waitFor(() => settled(c));

    const bad = [
      { numReplicas: 0 },
      { numReplicas: 'abc' },
      { restartPolicyType: 'SOMETIMES' },
      { unknownKey: 1 },
      { healthcheckTimeout: 0 },
      { startCommand: 123 },
      { sleepApplication: 'yes' },
      { restartPolicyMaxRetries: 11 },
      {},
    ];
    for (const changes of bad) {
      assert.equal((await c.patch(`/api/bots/${bot.id}/settings`, { changes })).status, 400, JSON.stringify(changes));
    }
    const proto = await c.call('PATCH', `/api/bots/${bot.id}/settings`, undefined, {});
    assert.equal(proto.status, 400);
    const res = await fetch(`${ctx.base}/api/bots/${bot.id}/settings`, {
      method: 'PATCH',
      headers: { 'X-Requested-With': 'vola', 'Content-Type': 'application/json', Cookie: c.cookie },
      body: '{"changes":{"__proto__":{"polluted":true}}}',
    });
    assert.equal(res.status, 400);
    assert.equal({}.polluted, undefined);
  });

  test('rename: works and refuses silly names', async () => {
    const bot = await botByName(c, 'bc');
    assert.equal((await c.post(`/api/bots/${bot.id}/rename`, { name: 'bc-broadcast' })).status, 200);
    assert.ok(await botByName(c, 'bc-broadcast'));
    for (const name of ['', '   ', 'x'.repeat(65), 'bad\u0000name', 42]) {
      assert.equal((await c.post(`/api/bots/${bot.id}/rename`, { name })).status, 400, JSON.stringify(name));
    }
    await c.post(`/api/bots/${bot.id}/rename`, { name: 'bc' });
  });

  test('keeps an activity trail that never contains secret values', async () => {
    const r = await c.get('/api/activity?limit=200');
    assert.equal(r.status, 200);
    assert.ok(r.json.entries.length > 8);
    assert.ok(r.json.entries.some((e) => e.action === 'restart' && e.ok === true));
    assert.ok(r.json.entries.some((e) => e.action === 'login' && e.ok === false));
    assert.ok(r.json.entries.some((e) => e.action === 'set-variable'));
    const text = JSON.stringify(r.json);
    for (const secret of ['demo_fixed_value', 'two words', 'changed', 'demo_token_not_a_real_secret']) {
      assert.ok(!text.includes(secret), `leaked ${secret}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const onDisk = fs.readFileSync(path.join(ctx.dataDir, 'activity.jsonl'), 'utf8');
    assert.ok(onDisk.includes('"action":"restart"'));
    assert.ok(!onDisk.includes('demo_fixed_value'));
  });

  test('diagnostics explain the connection in plain words', async () => {
    const r = await c.get('/api/diagnostics');
    assert.equal(r.status, 200);
    assert.ok(r.json.steps.every((s) => s.ok), JSON.stringify(r.json.steps));
    assert.equal(r.json.tokenType, 'demo');
    assert.ok(r.json.requests > 20);
  });

  test('connection and password cannot be changed in demo mode', async () => {
    assert.equal((await c.post('/api/connection', { token: 'x' })).status, 409);
    assert.equal((await c.post('/api/password', { current: 'demo', next: 'long enough password' })).status, 409);
  });

  test('logging out ends the session', async () => {
    assert.equal((await c.post('/api/logout')).status, 200);
    assert.equal((await c.get('/api/overview')).status, 401);
  });
});

// ---------------------------------------------------------------------------------------

describe('login lockout', () => {
  test('locks an address after repeated wrong passwords, even for the right one', async () => {
    const x = await startApp();
    const c = client(x.base);
    let last;
    for (let i = 0; i < 6; i += 1) last = await c.post('/api/login', { password: `wrong-${i}` });
    assert.equal(last.status, 429);
    assert.ok(last.json.error.retryAfter > 0);
    assert.equal((await c.post('/api/login', { password: 'demo' })).status, 429);
    await x.close();
  });
});

// ---------------------------------------------------------------------------------------

describe('first-time setup (token + password)', () => {
  let x;
  let c;
  let net;

  before(async () => {
    net = createDemo({ speed: 100 }); // stands in for Railway
    x = await startApp({ argv: [], env: {}, transport: net.transport });
    c = client(x.base);
  });
  after(async () => {
    await x.close();
    net.stop();
  });

  test('starts in setup mode and nothing else works yet', async () => {
    const s = await c.get('/api/session');
    assert.equal(s.json.needsSetup, true);
    assert.equal(s.json.authenticated, false);
    assert.equal((await c.get('/api/overview')).status, 401);
    assert.equal((await c.post('/api/login', { password: 'anything' })).status, 503);
    assert.equal((await c.get('/api/setup')).json.needsSetup, true);
  });

  test('explains a wrong token in plain words', async () => {
    const r = await c.post('/api/setup/test', { token: 'wrong-token' });
    assert.equal(r.json.ok, false);
    assert.match(r.json.steps[0].detail, /project token|account or workspace/i);
    assert.equal((await c.post('/api/setup/test', { token: 'two words' })).json.ok, false);
    assert.equal((await c.post('/api/setup/test', {})).json.ok, false);
    const good = await c.post('/api/setup/test', { token: 'demo-token' });
    assert.equal(good.json.ok, true);
    assert.equal(good.json.services.length, 5);
    assert.equal(good.json.mode, 'project');
    assert.ok(!fs.existsSync(x.envPath), 'testing must not save anything');
  });

  test('needs a decent password and a working token', async () => {
    assert.equal((await c.post('/api/setup/save', { token: 'demo-token', password: 'short' })).status, 400);
    const bad = await c.post('/api/setup/save', { token: 'nope', password: 'long enough password' });
    assert.equal(bad.status, 400);
    assert.ok(Array.isArray(bad.json.error.steps));
    assert.ok(!fs.existsSync(x.envPath));
  });

  test('saves the connection, stores only a password hash and signs you in', async () => {
    const r = await c.post('/api/setup/save', { token: 'demo-token', password: 'correct horse battery' });
    assert.equal(r.status, 200);
    assert.equal(r.json.projectName, 'VOLA STORE (demo)');
    assert.equal(r.json.services.length, 5);

    const env = fs.readFileSync(x.envPath, 'utf8');
    assert.match(env, /^RAILWAY_PROJECT_TOKEN=demo-token$/m);
    assert.match(env, /^RAILWAY_PROJECT_ID=demo-project$/m);
    assert.match(env, /^DASHBOARD_PASSWORD_HASH=scrypt\$/m);
    assert.ok(!env.includes('correct horse battery'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(x.envPath).mode & 0o777, 0o600);

    const o = await c.get('/api/overview');
    assert.equal(o.status, 200);
    assert.equal(o.json.bots.length, 5);
    assert.equal(o.json.demo, false);

    assert.equal((await c.post('/api/setup/save', { token: 'demo-token', password: 'another password' })).status, 403);
    assert.equal((await c.get('/api/setup')).json.needsSetup, false);
  });

  test('the new password works for a fresh login', async () => {
    const c2 = client(x.base);
    assert.equal((await c2.post('/api/login', { password: 'wrong password' })).status, 401);
    assert.equal((await c2.post('/api/login', { password: 'correct horse battery' })).status, 200);
    assert.equal((await c2.get('/api/overview')).status, 200);
  });

  test('changing the password signs every other session out', async () => {
    const c2 = client(x.base);
    await c2.post('/api/login', { password: 'correct horse battery' });
    assert.equal((await c.post('/api/password', { current: 'not it', next: 'a brand new passphrase' })).status, 403);
    assert.equal((await c.post('/api/password', { current: 'correct horse battery', next: 'short' })).status, 400);
    assert.equal((await c.post('/api/password', { current: 'correct horse battery', next: 'a brand new passphrase' })).status, 200);
    assert.equal((await c2.get('/api/overview')).status, 401);
    assert.equal((await c.get('/api/overview')).status, 200);
    const c3 = client(x.base);
    assert.equal((await c3.post('/api/login', { password: 'correct horse battery' })).status, 401);
    assert.equal((await c3.post('/api/login', { password: 'a brand new passphrase' })).status, 200);
  });

  test('swapping the Railway token checks it first', async () => {
    assert.equal((await c.post('/api/connection', { token: 'garbage' })).status, 400);
    const ok = await c.post('/api/connection', { token: 'demo-token' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.services.length, 5);
  });
});

// ---------------------------------------------------------------------------------------
// units
// ---------------------------------------------------------------------------------------

describe('config', () => {
  test('parseEnv understands quotes, comments and blank lines', () => {
    const parsed = parseEnv(['# hi', '', 'A=1', 'B="two words"', "C='three'", 'D=value # trailing comment', 'E=a#b', 'bad line', '1X=nope'].join('\r\n'));
    assert.deepEqual(parsed, { A: '1', B: 'two words', C: 'three', D: 'value', E: 'a#b' });
  });

  test('writeEnv updates, adds and removes keys and leaves the rest alone', () => {
    const file = path.join(tmpRoot, 'write-env.env');
    fs.writeFileSync(file, '# keep me\nKEEP=1\nCHANGE=old\nDROP=gone\n');
    writeEnv(file, { CHANGE: 'new value', DROP: null, ADD: 'x' });
    assert.equal(fs.readFileSync(file, 'utf8'), '# keep me\nKEEP=1\nCHANGE="new value"\nADD=x\n');
    assert.throws(() => writeEnv(file, { BAD: 'line\nbreak' }), /line breaks/);
    assert.throws(() => writeEnv(file, { BAD: 'has"quote' }), /double quotes/);
  });

  test('real environment variables beat the .env file, and setup completeness is detected', () => {
    const file = path.join(tmpRoot, 'precedence.env');
    fs.writeFileSync(file, 'RAILWAY_PROJECT_TOKEN=from-file\nPORT=4000\nDASHBOARD_PASSWORD=pw\n');
    const a = loadConfig({ argv: [], env: {}, envPath: file });
    assert.equal(a.token, 'from-file');
    assert.equal(a.tokenMode, 'project');
    assert.equal(a.port, 4000);
    assert.equal(isConfigured(a), true);
    const b = loadConfig({ argv: [], env: { RAILWAY_PROJECT_TOKEN: 'from-env', POLL_SECONDS: '1' }, envPath: file });
    assert.equal(b.token, 'from-env');
    assert.equal(b.pollSeconds, 10, 'polling is never faster than every 10 seconds');
    const noPw = loadConfig({ argv: [], env: { RAILWAY_PROJECT_TOKEN: 't' }, envPath: path.join(tmpRoot, 'missing.env') });
    assert.equal(isConfigured(noPw), false);
    const bearerNoIds = loadConfig({ argv: [], env: { RAILWAY_API_TOKEN: 't', DASHBOARD_PASSWORD: 'p' }, envPath: path.join(tmpRoot, 'missing.env') });
    assert.equal(bearerNoIds.tokenMode, 'bearer');
    assert.equal(isConfigured(bearerNoIds), false, 'an account token needs project and environment IDs');
    assert.equal(loadConfig({ argv: ['--demo'], env: {}, envPath: path.join(tmpRoot, 'missing.env') }).demo, true);
    assert.equal(loadConfig({ argv: [], env: {}, envPath: path.join(tmpRoot, 'missing.env') }).host, '127.0.0.1');
  });
});

describe('settings validation', () => {
  test('cleans up good values', () => {
    assert.deepEqual(validateSettings({ startCommand: '  node a.js  ', buildCommand: '', numReplicas: '3', healthcheckTimeout: null }), {
      startCommand: 'node a.js',
      buildCommand: null,
      numReplicas: 3,
      healthcheckTimeout: null,
    });
    assert.deepEqual(validateSettings({ restartPolicyType: 'NEVER', restartPolicyMaxRetries: 0, sleepApplication: false }), {
      restartPolicyType: 'NEVER',
      restartPolicyMaxRetries: 0,
      sleepApplication: false,
    });
  });

  test('refuses everything else', () => {
    for (const bad of [null, [], 'x', {}, { nope: 1 }, { numReplicas: 1.5 }, { startCommand: 'x'.repeat(5000) }, { cronSchedule: {} }]) {
      assert.throws(() => validateSettings(bad), /./, JSON.stringify(bad));
    }
  });

  test('errors use the words of the settings page, not internal names', () => {
    assert.throws(() => validateSettings({ numReplicas: 0 }), { message: 'Copies running at the same time must be a whole number from 1 to 50.' });
    assert.throws(() => validateSettings({ startCommand: 'x'.repeat(5000) }), { message: 'Start command is too long (max 4000 characters).' });
  });
});

describe('log helpers', () => {
  test('colour codes are stripped and severities are guessed sensibly', () => {
    assert.equal(stripAnsi('\u001b[31mred\u001b[0m and \u001b[1;32mgreen\u001b[0m'), 'red and green');
    assert.equal(normalizeSeverity('WARNING', ''), 'warn');
    assert.equal(normalizeSeverity('error', ''), 'error');
    assert.equal(normalizeSeverity(null, 'Unhandled promise rejection'), 'error');
    assert.equal(normalizeSeverity(null, 'all good'), 'info');
    assert.equal(normalizeSeverity('weird', 'all good'), 'info');
  });
});

describe('railway client', () => {
  const fake = (responses) => {
    const calls = [];
    let i = 0;
    const transport = async (req) => {
      calls.push(req);
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      if (r instanceof Error) throw r;
      return { status: r.status ?? 200, headers: new Headers(r.headers || {}), json: r.json ?? null, text: '' };
    };
    return { transport, calls };
  };
  const ok = { json: { data: { hello: 'world' } } };
  const netErr = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });

  test('puts a project token and an account token in the right header, and names the operation', async () => {
    const a = fake([ok]);
    await createRailway({ token: 'TOK1', mode: 'project', transport: a.transport }).request(D.ProjectToken);
    assert.equal(a.calls[0].headers['Project-Access-Token'], 'TOK1');
    assert.equal(a.calls[0].headers.Authorization, undefined);
    assert.equal(a.calls[0].body.operationName, 'ProjectToken');

    const b = fake([ok]);
    await createRailway({ token: 'TOK2', mode: 'bearer', transport: b.transport }).request(D.ProjectToken);
    assert.equal(b.calls[0].headers.Authorization, 'Bearer TOK2');
    assert.equal(b.calls[0].headers['Project-Access-Token'], undefined);
  });

  test('reads the rate limit headers', async () => {
    const f = fake([{ ...ok, headers: { 'x-ratelimit-limit': '1000', 'x-ratelimit-remaining': '998', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) } }]);
    const r = createRailway({ token: 't', transport: f.transport });
    assert.equal(r.getRate(), null);
    await r.request(D.ProjectToken);
    assert.equal(r.getRate().limit, 1000);
    assert.equal(r.getRate().remaining, 998);
    assert.ok(Date.parse(r.getRate().resetAt) > Date.now());
    assert.equal(r.getRequestCount(), 1);
  });

  test('classifies problems so the dashboard can explain them', async () => {
    const kind = async (response, doc = D.ProjectToken) => {
      const f = fake([response]);
      try {
        await createRailway({ token: 'SECRET-TOKEN-VALUE', transport: f.transport }).request(doc);
      } catch (err) {
        assert.ok(!err.message.includes('SECRET-TOKEN-VALUE'), 'the token must never appear in an error');
        return { kind: err.kind, err, calls: f.calls.length };
      }
      throw new Error('expected an error');
    };
    assert.equal((await kind({ status: 401, json: {} })).kind, 'auth');
    assert.equal((await kind({ json: { errors: [{ message: 'Not Authorized' }] } })).kind, 'auth');
    assert.equal((await kind({ json: { errors: [{ message: 'Project Token not found' }] } })).kind, 'auth');
    assert.equal((await kind({ json: { errors: [{ message: 'Service not found' }] } })).kind, 'graphql');
    assert.equal((await kind({ status: 200, json: null })).kind, 'http');
    const slow = await kind({ status: 429, headers: { 'retry-after': '60' }, json: {} });
    assert.equal(slow.kind, 'rate');
    assert.equal(slow.err.retryAfter, 60);
    assert.equal(slow.calls, 1, 'a long wait is not retried');
    const net = await kind(netErr());
    assert.equal(net.kind, 'network');
    assert.match(net.err.message, /ENOTFOUND/);
  });

  test('retries a query once after a hiccup, but never repeats a mutation', async () => {
    const q = fake([netErr(), ok]);
    assert.deepEqual(await createRailway({ token: 't', transport: q.transport }).request(D.ProjectToken), { hello: 'world' });
    assert.equal(q.calls.length, 2);

    const q5 = fake([{ status: 503, json: {} }, ok]);
    await createRailway({ token: 't', transport: q5.transport }).request(D.ProjectToken);
    assert.equal(q5.calls.length, 2);

    const m = fake([netErr(), ok]);
    await assert.rejects(createRailway({ token: 't', transport: m.transport }).request(D.DeploymentRestart, { id: 'x' }));
    assert.equal(m.calls.length, 1);

    const m5 = fake([{ status: 503, json: {} }, ok]);
    await assert.rejects(createRailway({ token: 't', transport: m5.transport }).request(D.DeploymentStop, { id: 'x' }));
    assert.equal(m5.calls.length, 1);

    const quick = fake([{ status: 429, headers: { 'retry-after': '1' }, json: {} }, ok]);
    await createRailway({ token: 't', transport: quick.transport }).request(D.DeploymentStop, { id: 'x' });
    assert.equal(quick.calls.length, 2, 'a 429 means nothing happened, so even a mutation may be retried');
  });
});
